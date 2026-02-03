"""
Strava OAuth + API client (async, httpx).

Acceptance checks covered by endpoints using this client:
- build_auth_url contains client_id and redirect_uri.
- exchange_code_for_token stores provider='strava' row in oauth_tokens.
- refresh handles token expiry and updates DB.
- get_athlete_activities respects rate limits and retries.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx
from sqlalchemy import text as sql_text
from sqlalchemy.engine import Engine

from .db import get_engine

log = logging.getLogger("strava-auto-server.strava")


OAUTH_TOKEN_URL = "https://www.strava.com/oauth/token"
API_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities"
API_ACTIVITY_URL_TMPL = "https://www.strava.com/api/v3/activities/{id}"
API_ATHLETE_URL = "https://www.strava.com/api/v3/athlete"
API_GEAR_URL_TMPL = "https://www.strava.com/api/v3/gear/{id}"
PUSH_SUBSCRIPTIONS_URL = "https://www.strava.com/api/v3/push_subscriptions"


@dataclass
class TokenInfo:
    access_token: str
    refresh_token: str
    expires_at: int
    scope: str
    athlete_id: Optional[int]


def _now_epoch() -> int:
    return int(time.time())


class StravaClient:
    """Async Strava client handling OAuth and activities.

    Notes:
    - Single-user MVP using one row in `oauth_tokens` with provider='strava'.
    - Logs X-RateLimit-Usage/Limits when present.
    - Retries 429/5xx with small jittered backoff.
    """

    def __init__(self, engine: Optional[Engine] = None, athlete_id: Optional[int] = None) -> None:
        self.engine = engine or get_engine()
        self.client_id = os.getenv("STRAVA_CLIENT_ID", "")
        self.client_secret = os.getenv("STRAVA_CLIENT_SECRET", "")
        self.redirect_uri = os.getenv("STRAVA_REDIRECT_URI", "")
        self.athlete_id = athlete_id
        self._http = httpx.AsyncClient(timeout=20)

    def build_auth_url(self, scopes: List[str], *, state: Optional[str] = None) -> str:
        """Build the Strava OAuth URL.

        Uses approval_prompt=auto, response_type=code.
        Strava expects scopes as comma-separated.
        """
        scope_str = ",".join(scopes)
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "approval_prompt": "auto",
            "scope": scope_str,
        }
        if state:
            params["state"] = state
        from urllib.parse import urlencode

        return f"https://www.strava.com/oauth/authorize?{urlencode(params)}"

    async def _save_token(
        self,
        data: Dict[str, Any],
        *,
        athlete_id_hint: Optional[int] = None,
    ) -> TokenInfo:
        # Be tolerant of different token payload shapes (expires_at/expires_in)
        exp_raw = data.get("expires_at")
        exp_val: int
        try:
            exp_val = int(exp_raw) if exp_raw is not None else 0
        except Exception:
            exp_val = 0
        if not exp_val:
            try:
                exp_val = _now_epoch() + int(data.get("expires_in", 0) or 0)
            except Exception:
                exp_val = 0

        athlete_id = (data.get("athlete") or {}).get("id")
        if athlete_id is None:
            athlete_id = athlete_id_hint or self.athlete_id
        token = TokenInfo(
            access_token=str(data.get("access_token", "")),
            refresh_token=str(data.get("refresh_token", "")),
            expires_at=exp_val,
            scope=str(data.get("scope", "")),
            athlete_id=athlete_id,
        )
        if token.athlete_id is not None:
            self.athlete_id = int(token.athlete_id)
        else:
            raise RuntimeError("Missing athlete_id while saving Strava token")
        from datetime import datetime, timezone

        now_iso = datetime.now(timezone.utc).isoformat()
        with self.engine.begin() as conn:
            params = {
                "at": token.access_token,
                "rt": token.refresh_token,
                "exp": token.expires_at,
                "sc": token.scope,
                "aid": token.athlete_id,
                "now": now_iso,
            }
            # Portable upsert: try UPDATE first, then INSERT if no row updated
            res = conn.execute(
                sql_text(
                    """
                    UPDATE oauth_tokens
                    SET access_token = :at,
                        refresh_token = :rt,
                        expires_at = :exp,
                        scope = :sc,
                        updated_at = :now
                    WHERE provider = 'strava' AND athlete_id = :aid
                    """
                ),
                params,
            )
            if getattr(res, "rowcount", 0) == 0:
                conn.execute(
                    sql_text(
                        """
                        INSERT INTO oauth_tokens (provider, athlete_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
                        VALUES ('strava', :aid, :at, :rt, :exp, :sc, :now, :now)
                        """
                    ),
                    params,
                )
        return token

    async def exchange_code_for_token(self, code: str) -> Tuple[TokenInfo, Dict[str, Any]]:
        """Exchange authorization code for tokens and persist them.

        POST https://www.strava.com/oauth/token with grant_type=authorization_code
        """
        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "grant_type": "authorization_code",
        }
        resp = await self._http.post(OAUTH_TOKEN_URL, data=payload)
        if resp.status_code >= 400:
            detail = _safe_text(resp)
            log.error("Token exchange failed (%s): %s", resp.status_code, detail)
            resp.raise_for_status()
        data = resp.json()
        token = await self._save_token(data)
        log.info(
            "Strava connected for athlete_id=%s, scope=%s",
            token.athlete_id,
            token.scope,
        )
        return token, (data.get("athlete") or {})

    def _load_token_row(self, athlete_id: Optional[int] = None) -> Optional[TokenInfo]:
        """Load the single Strava token row, using mappings for portability."""
        aid = athlete_id if athlete_id is not None else self.athlete_id
        if aid is None:
            return None
        with self.engine.connect() as conn:
            row = (
                conn.execute(
                    sql_text(
                        "SELECT access_token, refresh_token, expires_at, scope, athlete_id FROM oauth_tokens WHERE provider='strava' AND athlete_id = :aid"
                    ),
                    {"aid": int(aid)},
                )
                .mappings()
                .fetchone()
            )
            if not row:
                return None
            return TokenInfo(
                access_token=str(row["access_token"] or ""),
                refresh_token=str(row["refresh_token"] or ""),
                expires_at=int(row["expires_at"] or 0),
                scope=str(row["scope"] or ""),
                athlete_id=(
                    int(row["athlete_id"]) if row["athlete_id"] is not None else None
                ),
            )

    async def refresh_token_if_needed(self, athlete_id: Optional[int] = None) -> None:
        """Refresh access token if it expires within 2 minutes."""
        token = self._load_token_row(athlete_id=athlete_id)
        if not token:
            return
        threshold = 120
        now = _now_epoch()
        if token.expires_at - now > threshold:
            return
        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": token.refresh_token,
        }
        resp = await self._http.post(OAUTH_TOKEN_URL, data=payload)
        if resp.status_code >= 400:
            log.warning(
                "Token refresh failed (%s): %s", resp.status_code, _safe_text(resp)
            )
            resp.raise_for_status()
        data = resp.json()
        new_token = await self._save_token(data, athlete_id_hint=token.athlete_id)
        ttl = new_token.expires_at - _now_epoch()
        log.info("Strava token refreshed, ttl=%ss", ttl)

    async def create_webhook_subscription(
        self, callback_url: str, verify_token: str
    ) -> Dict[str, Any]:
        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "callback_url": callback_url,
            "verify_token": verify_token,
        }
        resp = await self._http.post(PUSH_SUBSCRIPTIONS_URL, data=payload)
        if resp.status_code >= 400:
            detail = _safe_text(resp)
            log.error("Create webhook subscription failed (%s): %s", resp.status_code, detail)
            resp.raise_for_status()
        return resp.json()

    async def list_webhook_subscriptions(self) -> List[Dict[str, Any]]:
        params = {"client_id": self.client_id, "client_secret": self.client_secret}
        resp = await self._http.get(PUSH_SUBSCRIPTIONS_URL, params=params)
        if resp.status_code >= 400:
            detail = _safe_text(resp)
            log.error("List webhook subscriptions failed (%s): %s", resp.status_code, detail)
            resp.raise_for_status()
        data = resp.json()
        return list(data) if isinstance(data, list) else []

    async def delete_webhook_subscription(self, subscription_id: int) -> None:
        params = {"client_id": self.client_id, "client_secret": self.client_secret}
        url = f"{PUSH_SUBSCRIPTIONS_URL}/{int(subscription_id)}"
        resp = await self._http.delete(url, params=params)
        if resp.status_code >= 400:
            detail = _safe_text(resp)
            log.error("Delete webhook subscription failed (%s): %s", resp.status_code, detail)
            resp.raise_for_status()

    async def get_athlete_activities(
        self, after: Optional[int]
    ) -> List[Dict[str, Any]]:
        """Fetch recent athlete activities (paginated up to 100).

        Retries on 429/5xx with small backoff and logs rate limits.
        """
        log.info("Fetching Strava activities after=%s", after)
        # Global cooldown guard based on prior 429s
        try:
            from .db import get_cooldown_detail as _get_cd_detail
            from .timefmt import human_local_from_epoch as _hl
            _cd = _get_cd_detail()
            cd_until = int(_cd.get("until") or 0)
            if cd_until and int(time.time()) < cd_until:
                reason = str(_cd.get("reason") or "")
                scope = str(_cd.get("scope") or "")
                msg = f"Strava cooldown active until {_hl(cd_until)} (epoch={cd_until})"
                if reason:
                    msg += f"; reason: {reason}"
                if scope:
                    msg += f"; scope: {scope}"
                log.warning(msg + "; skipping fetch")
                return []
        except Exception:
            pass
        token = self._load_token_row()
        if not token:
            return []
        params = {"per_page": 100}
        if after is not None:
            params["after"] = int(after)

        headers = {"Authorization": f"Bearer {token.access_token}"}
        backoffs = [0.5, 1.5, 3.0]
        last_exc: Optional[Exception] = None
        for attempt, delay in enumerate([0.0] + backoffs, start=1):
            if delay:
                await asyncio.sleep(delay + 0.1 * delay * (os.getpid() % 5))
            try:
                resp = await self._http.get(
                    API_ACTIVITIES_URL, params=params, headers=headers
                )
                self._log_rate_limits(resp)
                # Record metrics and set cooldown on 429
                try:
                    _record_request(resp, path="/athlete/activities")
                except Exception:
                    pass
                if resp.status_code == 429:
                    return []
                if 500 <= resp.status_code < 600:
                    raise httpx.HTTPStatusError("server error", request=resp.request, response=resp)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, list):
                    log.warning("Unexpected activities payload type: %s", type(data))
                    return []
                log.info(
                    "Strava activities fetched: after=%s items=%s", after, len(data)
                )
                # If empty and no 'after' filter, try epoch fallback once
                if not data and after is None:
                    try:
                        resp2 = await self._http.get(
                            API_ACTIVITIES_URL,
                            params={"per_page": 100, "after": 0},
                            headers=headers,
                        )
                        try:
                            self._log_rate_limits(resp2)
                        except Exception:
                            pass
                        try:
                            _record_request(resp2, path="/athlete/activities?after=0")
                        except Exception:
                            pass
                        resp2.raise_for_status()
                        data2 = resp2.json()
                        if isinstance(data2, list):
                            log.info(
                                "Strava activities epoch fallback items=%s", len(data2)
                            )
                            return data2  # type: ignore[return-value]
                    except Exception:
                        pass
                return data  # type: ignore[return-value]
            except Exception as exc:  # noqa: BLE001 - log + retry
                last_exc = exc
                if attempt >= 1 + len(backoffs):
                    break
                log.warning("Activities fetch attempt %s failed: %s", attempt, exc)
        if last_exc:
            log.error("Activities fetch failed after retries: %s", last_exc)
        return []

    async def update_activity(
        self,
        activity_id: int,
        *,
        name: Optional[str] = None,
        sport_type: Optional[str] = None,
        commute: Optional[bool] = None,
        workout_type: Optional[int] = None,
        gear_id: Optional[str] = None,
        hide_from_home: Optional[bool] = None,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Update an activity fields on Strava.

        Supports: name, sport_type, commute (subset for MVP).
        """
        token = self._load_token_row()
        if not token:
            raise RuntimeError("No Strava token; cannot update activity")
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        data: Dict[str, Any] = {}
        if name is not None:
            data["name"] = name
        if sport_type is not None:
            data["sport_type"] = sport_type
        if commute is not None:
            # Strava accepts boolean-ish; be explicit
            data["commute"] = 1 if commute else 0
        if workout_type is not None:
            try:
                data["workout_type"] = int(workout_type)
            except Exception:
                pass
        if gear_id is not None:
            data["gear_id"] = str(gear_id)
        if hide_from_home is not None:
            # Strava API accepts boolean for hide_from_home; send as 1/0 to be safe
            data["hide_from_home"] = 1 if hide_from_home else 0
        if description is not None:
            data["description"] = str(description)
        if not data:
            return {}
        url = API_ACTIVITY_URL_TMPL.format(id=int(activity_id))
        resp = await self._http.put(url, data=data, headers=headers)
        try:
            _record_request(resp, path=f"/activities/{activity_id}")
        except Exception:
            pass
        if resp.status_code >= 400:
            log.warning(
                "Update activity %s failed (%s): %s",
                activity_id,
                resp.status_code,
                _safe_text(resp),
            )
            resp.raise_for_status()
        try:
            return resp.json()
        except Exception:
            return {}

    async def get_activity(self, activity_id: int) -> Dict[str, Any]:
        """Fetch detailed activity by id (includes fields not present in list).

        Best-effort: returns {} on error.
        """
        token = self._load_token_row()
        if not token:
            return {}
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        url = API_ACTIVITY_URL_TMPL.format(id=int(activity_id))
        try:
            resp = await self._http.get(url, headers=headers)
            try:
                _record_request(resp, path=f"/activities/{activity_id}")
            except Exception:
                pass
            if resp.status_code >= 400:
                return {}
            data = resp.json()
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        return {}

    async def get_athlete(self) -> Dict[str, Any]:
        token = self._load_token_row()
        if not token:
            raise RuntimeError("No Strava token; cannot fetch athlete")
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        resp = await self._http.get(API_ATHLETE_URL, headers=headers)
        try:
            _record_request(resp, path="/athlete")
        except Exception:
            pass
        if resp.status_code >= 400:
            log.warning(
                "Fetch athlete failed (%s): %s", resp.status_code, _safe_text(resp)
            )
            resp.raise_for_status()
        try:
            return resp.json()
        except Exception:
            return {}

    async def get_athlete_gear(self) -> Dict[str, Any]:
        """Return a dict with a 'shoes' list. Falls back if /athlete lacks shoes.

        Primary path: GET /athlete -> parse 'shoes'.
        Fallback: collect distinct gear_id from recent activities and GET /gear/{id} for details.
        """
        # Try primary /athlete payload first
        data = await self.get_athlete()
        print(data)
        shoes = []
        for item in data.get("shoes") or []:
            try:
                shoes.append(
                    {
                        "id": item.get("id"),
                        "name": item.get("name"),
                        "primary": bool(item.get("primary")),
                        "distance": item.get("distance"),
                    }
                )
            except Exception:
                continue
        if shoes:
            return {"shoes": shoes}

        # Fallback: scan recent activities for gear IDs and fetch each gear
        token = self._load_token_row()
        if not token:
            return {"shoes": []}
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        params = {"per_page": 100}
        # Last 180 days window to avoid old retired shoes; Strava ignores 'after' if too new
        try:
            recent_after = int(time.time()) - 180 * 86400
            params["after"] = recent_after
        except Exception:
            pass
        resp = await self._http.get(API_ACTIVITIES_URL, params=params, headers=headers)
        try:
            _record_request(resp, path="/athlete/activities")
        except Exception:
            pass
        if resp.status_code >= 400:
            log.info("Activities fetch for gear fallback failed (%s)", resp.status_code)
            return {"shoes": []}
        ids: set[str] = set()
        try:
            for a in resp.json() or []:
                gid = a.get("gear_id")
                st = (a.get("sport_type") or "").lower()
                if gid and (st == "run" or st == "trailrun" or st == "virtualrun"):
                    ids.add(str(gid))
        except Exception:
            pass
        out = []
        for gid in ids:
            try:
                g = await self._http.get(
                    API_GEAR_URL_TMPL.format(id=gid), headers=headers
                )
                try:
                    _record_request(g, path=f"/gear/{gid}")
                except Exception:
                    pass
                if g.status_code >= 400:
                    continue
                gj = g.json()
                if (gj.get("type") or "").lower() != "shoe":
                    continue
                out.append(
                    {
                        "id": gj.get("id"),
                        "name": gj.get("name"),
                        "primary": bool(gj.get("primary")),
                        "distance": gj.get("distance"),
                    }
                )
            except Exception:
                continue
        return {"shoes": out}

    async def get_activity_detail(self, activity_id: int) -> Dict[str, Any]:
        token = self._load_token_row()
        if not token:
            raise RuntimeError("No Strava token; cannot fetch activity detail")
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        url = f"https://www.strava.com/api/v3/activities/{int(activity_id)}"
        resp = await self._http.get(url, headers=headers, params={"include_all_efforts": "false"})
        try:
            self._log_rate_limits(resp)
        except Exception:
            pass
        try:
            _record_request(resp, path=f"/activities/{activity_id}?detail")
        except Exception:
            pass
        if resp.status_code >= 400:
            resp.raise_for_status()
        try:
            return resp.json()
        except Exception:
            return {}

    async def get_activity_laps(self, activity_id: int) -> List[Dict[str, Any]]:
        token = self._load_token_row()
        if not token:
            raise RuntimeError("No Strava token; cannot fetch laps")
        await self.refresh_token_if_needed()
        headers = {"Authorization": f"Bearer {token.access_token}"}
        url = f"https://www.strava.com/api/v3/activities/{int(activity_id)}/laps"
        resp = await self._http.get(url, headers=headers)
        try:
            self._log_rate_limits(resp)
        except Exception:
            pass
        try:
            _record_request(resp, path=f"/activities/{activity_id}/laps")
        except Exception:
            pass
        if resp.status_code >= 400:
            resp.raise_for_status()
        try:
            data = resp.json()
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _log_rate_limits(self, resp: httpx.Response) -> None:
        usage = resp.headers.get("X-RateLimit-Usage")
        limit = resp.headers.get("X-RateLimit-Limit")
        if not usage or not limit:
            return
        try:
            u_short, u_long = [int(x) for x in usage.split(",")]
            l_short, l_long = [int(x) for x in limit.split(",")]
            pct_short = (u_short / max(l_short, 1)) if l_short else 0
            pct_long = (u_long / max(l_long, 1)) if l_long else 0
            level = (
                logging.WARNING if pct_short > 0.8 or pct_long > 0.8 else logging.INFO
            )
            log.log(
                level,
                "Strava rate usage short=%s/%s long=%s/%s",
                u_short,
                l_short,
                u_long,
                l_long,
            )
        except Exception:  # pragma: no cover - best-effort parsing
            log.info("Strava rate headers usage=%s limit=%s", usage, limit)


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text
    except Exception:
        return f"<unreadable body; status {resp.status_code}>"


def _parse_rate_headers(resp: httpx.Response) -> Dict[str, Optional[int]]:
    """Parse overall and read rate headers + retry-after + date epoch.

    Returns keys:
    um, ud, lm, ld    -> overall usage/limits (min/day)
    rum, rud, rlm, rld -> read usage/limits (min/day)
    ra -> retry-after seconds
    date_epoch -> server date header epoch seconds (UTC) if present
    """
    out: Dict[str, Optional[int]] = {
        "um": None,
        "ud": None,
        "lm": None,
        "ld": None,
        "rum": None,
        "rud": None,
        "rlm": None,
        "rld": None,
        "ra": None,
        "date_epoch": None,
    }
    try:
        usage = resp.headers.get("X-RateLimit-Usage") or resp.headers.get("x-ratelimit-usage")
        limit = resp.headers.get("X-RateLimit-Limit") or resp.headers.get("x-ratelimit-limit")
        r_usage = resp.headers.get("X-ReadRateLimit-Usage") or resp.headers.get("x-readratelimit-usage")
        r_limit = resp.headers.get("X-ReadRateLimit-Limit") or resp.headers.get("x-readratelimit-limit")
        if usage and "," in usage:
            parts = [p.strip() for p in usage.split(",", 1)]
            out["um"] = int(parts[0])
            out["ud"] = int(parts[1])
        if limit and "," in limit:
            parts = [p.strip() for p in limit.split(",", 1)]
            out["lm"] = int(parts[0])
            out["ld"] = int(parts[1])
        if r_usage and "," in r_usage:
            parts = [p.strip() for p in r_usage.split(",", 1)]
            out["rum"] = int(parts[0])
            out["rud"] = int(parts[1])
        if r_limit and "," in r_limit:
            parts = [p.strip() for p in r_limit.split(",", 1)]
            out["rlm"] = int(parts[0])
            out["rld"] = int(parts[1])
        ra_hdr = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
        if ra_hdr:
            out["ra"] = int(ra_hdr)
        # Parse server date header if present (RFC 7231 IMF-fixdate)
        from email.utils import parsedate_to_datetime
        date_hdr = resp.headers.get("Date") or resp.headers.get("date")
        if date_hdr:
            try:
                dt = parsedate_to_datetime(date_hdr)
                out["date_epoch"] = int(dt.timestamp())
            except Exception:
                pass
    except Exception:
        pass
    return out


def _record_request(resp: httpx.Response, *, path: str) -> None:
    meta = _parse_rate_headers(resp)
    um = meta.get("um"); ud = meta.get("ud"); lm = meta.get("lm"); ld = meta.get("ld")
    rum = meta.get("rum"); rud = meta.get("rud"); rlm = meta.get("rlm"); rld = meta.get("rld")
    ra = meta.get("ra")
    try:
        from .db import log_strava_request as _log, set_cooldown as _set_cd
        _log(path=path, status=int(resp.status_code), usage_min=um, usage_day=ud, limit_min=lm, limit_day=ld, retry_after=ra)
        import time as _t
        now = int(_t.time())
        # 429 handling: use Retry-After or default
        if resp.status_code == 429:
            cooldown = ra if (isinstance(ra, int) and ra and ra > 0) else 180
            _set_cd(now + cooldown, reason="HTTP 429 Too Many Requests", scope="server")
            return
        # Proactive cooldown based on usage headers (overall and read)
        def next_quarter_epoch(ref: int) -> int:
            from datetime import datetime, timezone, timedelta
            dt = datetime.fromtimestamp(ref, tz=timezone.utc)
            # Minutes to next boundary at 0,15,30,45
            m = dt.minute
            next_min = (15 * ((m // 15) + 1)) % 60
            hour_incr = 1 if next_min == 0 else 0
            next_dt = dt.replace(minute=next_min, second=0, microsecond=0) + timedelta(hours=hour_incr if next_min == 0 and (dt.second or dt.microsecond) else 0)
            if next_dt <= dt:
                next_dt = next_dt + timedelta(minutes=15)
            return int(next_dt.timestamp())

        def next_midnight_epoch(ref: int) -> int:
            from datetime import datetime, timezone, timedelta
            dt = datetime.fromtimestamp(ref, tz=timezone.utc)
            next_day = (dt + timedelta(days=1)).date()
            ndt = datetime(next_day.year, next_day.month, next_day.day, tzinfo=timezone.utc)
            return int(ndt.timestamp())

        server_now = int(meta.get("date_epoch") or now)
        triggers: list[tuple[int, str]] = []  # (until_epoch, reason)

        def check_pair(u: Optional[int], l: Optional[int], label: str) -> None:
            if not (isinstance(u, int) and isinstance(l, int) and l > 0):
                return
            ratio = u / l if l else 0.0
            if u >= l:
                # Exceeded short term
                until = next_quarter_epoch(server_now)
                triggers.append((until, f"Exceeded 15-minute {label} limit ({u}/{l})"))
            elif ratio >= 0.95:
                until = next_quarter_epoch(server_now)
                triggers.append((until, f"Near 15-minute {label} limit ({u}/{l})"))

        def check_pair_day(u: Optional[int], l: Optional[int], label: str) -> None:
            if not (isinstance(u, int) and isinstance(l, int) and l > 0):
                return
            ratio = u / l if l else 0.0
            if u >= l:
                until = next_midnight_epoch(server_now)
                triggers.append((until, f"Exceeded daily {label} limit ({u}/{l})"))
            elif ratio >= 0.98:
                until = next_midnight_epoch(server_now)
                triggers.append((until, f"Near daily {label} limit ({u}/{l})"))

        # Overall
        check_pair(um, lm, "overall")
        check_pair_day(ud, ld, "overall")
        # Read-only
        check_pair(rum, rlm, "read")
        check_pair_day(rud, rld, "read")

        if triggers:
            # Choose the furthest reset among triggers to be safe
            until, reason = max(triggers, key=lambda t: t[0])
            # Determine scope from reason text
            scope = "read" if "read" in reason else "overall"
            # Only set/extend if the new until is further than existing
            from .db import get_cooldown_until as _get_cd
            cur = _get_cd()
            if until > max(int(cur or 0), now):
                _set_cd(until, reason=reason, scope=scope)
    except Exception:
        pass
