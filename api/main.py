from __future__ import annotations

import os
import uuid
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, status, Response, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
import httpx
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import text as sql_text
from sqlalchemy.exc import OperationalError
from sqlalchemy.engine import Engine, Result

from .db import get_engine, ensure_schema, set_setting, get_cooldown_detail
from .strava_client import StravaClient
from .scheduler import start_scheduler
from . import scheduler as _scheduler
from .timefmt import human_local_from_epoch

# -----------------------------------------------------------------------------
# Config & Logging
# -----------------------------------------------------------------------------

APP_ENV = os.getenv("APP_ENV", "dev")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////data/app.db")

STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID", "")
STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET", "")
STRAVA_REDIRECT_URI = os.getenv("STRAVA_REDIRECT_URI", "")
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")

# Geocoding config
GEOCODE_PROVIDER = os.getenv("GEOCODE_PROVIDER", "nominatim").lower()
GEOCODE_CONTACT_EMAIL = os.getenv("GEOCODE_CONTACT_EMAIL", "turnercharlie25@gmail.com")
GEOCODE_TTL_DAYS = int(os.getenv("GEOCODE_TTL_DAYS", "30"))

CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("strava-auto-server")

## Shared DB engine
engine: Engine = get_engine()


# -----------------------------------------------------------------------------
# Pydantic models (request/response)
# -----------------------------------------------------------------------------


class Condition(BaseModel):
    type: str
    op: str
    value: Any


class Effect(BaseModel):
    type: str
    params: Dict[str, Any] = Field(default_factory=dict)


class AutomationCreate(BaseModel):
    name: str
    enabled: bool = True
    priority: int = 0
    conditions: List[Condition] = Field(default_factory=list)
    effects: List[Effect] = Field(default_factory=list)


class Automation(AutomationCreate):
    id: str
    created_at: datetime
    updated_at: datetime


class AutomationEnablePayload(BaseModel):
    enabled: bool


class AutomationUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    conditions: Optional[List[Condition]] = None
    effects: Optional[List[Effect]] = None


# -----------------------------------------------------------------------------
# FastAPI app
# -----------------------------------------------------------------------------

app = FastAPI(
    title="Strava Auto Server",
    version="0.0.1",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    try:
        ensure_schema()
    except OperationalError as e:
        log.exception("Failed to initialize DB")
        raise e
    # Start background scheduler for Strava polling
    if os.getenv("DISABLE_SCHEDULER") == "1" or APP_ENV == "test":
        log.info("Scheduler disabled by environment (DISABLE_SCHEDULER=1 or APP_ENV=test)")
    else:
        try:
            start_scheduler(engine)
        except Exception as e:  # noqa: BLE001
            log.exception("Failed to start scheduler: %s", e)


# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------


def _row_to_automation(row: Any) -> Automation:
    return Automation(
        id=row.id,
        name=row.name,
        enabled=bool(row.enabled),
        priority=row.priority,
        conditions=json.loads(row.conditions_json or "[]"),
        effects=json.loads(row.effects_json or "[]"),
        created_at=_coerce_dt(row.created_at),
        updated_at=_coerce_dt(row.updated_at),
    )


def _coerce_dt(val: Any) -> datetime:
    if isinstance(val, datetime):
        return val.replace(tzinfo=timezone.utc) if val.tzinfo is None else val
    # SQLite may return strings for timestamps if not set up otherwise
    return datetime.fromisoformat(str(val)).replace(tzinfo=timezone.utc)


# -----------------------------------------------------------------------------
# Health & sanity endpoints
# -----------------------------------------------------------------------------


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    try:
        with engine.connect() as conn:
            conn.execute(sql_text("SELECT 1"))
        db_ok = True
    except Exception as e:
        log.error("DB health check failed: %s", e)
        db_ok = False

    return {
        "status": "ok" if db_ok else "degraded",
        "env": APP_ENV,
        "version": app.version,
        "db": {"ok": db_ok},
        "strava_env": {
            "has_client_id": bool(STRAVA_CLIENT_ID),
            "has_client_secret": bool(STRAVA_CLIENT_SECRET),
            "has_redirect_uri": bool(STRAVA_REDIRECT_URI),
        },
    }


# -----------------------------------------------------------------------------
# Rate limit metrics
# -----------------------------------------------------------------------------


@app.get("/api/admin/ratelimit")
def get_ratelimit_metrics() -> Dict[str, Any]:
    from .db import get_cooldown_detail as _get_cd_detail, get_setting as _get_setting
    from .timefmt import human_local_from_epoch as _hl
    now = int(datetime.now(timezone.utc).timestamp())
    cd_detail = _get_cd_detail()
    cd = int(cd_detail.get("until") or 0)
    with engine.connect() as conn:
        # counts
        c15 = conn.execute(sql_text("SELECT COUNT(*) AS c FROM strava_request_log WHERE ts >= :t"), {"t": now - 900}).scalar_one()
        c24 = conn.execute(sql_text("SELECT COUNT(*) AS c FROM strava_request_log WHERE ts >= :t"), {"t": now - 86400}).scalar_one()
        e15 = conn.execute(sql_text("SELECT COUNT(*) AS c FROM strava_request_log WHERE ts >= :t AND status = 429"), {"t": now - 900}).scalar_one()
        e24 = conn.execute(sql_text("SELECT COUNT(*) AS c FROM strava_request_log WHERE ts >= :t AND status = 429"), {"t": now - 86400}).scalar_one()
        last = conn.execute(sql_text("SELECT usage_min, usage_day, limit_min, limit_day, retry_after, status FROM strava_request_log ORDER BY ts DESC LIMIT 1")).fetchone()
    hdrs = None
    if last:
        hdrs = {
            "usage_min": int(last.usage_min) if last.usage_min is not None else None,
            "usage_day": int(last.usage_day) if last.usage_day is not None else None,
            "limit_min": int(last.limit_min) if last.limit_min is not None else None,
            "limit_day": int(last.limit_day) if last.limit_day is not None else None,
            "last_status": int(last.status) if last.status is not None else None,
        }
    # Derive a friendly cooldown message
    reason = str(cd_detail.get("reason") or "")
    scope = str(cd_detail.get("scope") or "")
    set_at = int(cd_detail.get("set_at") or 0)
    msg = ""
    if cd and cd > now:
        local = _hl(cd)
        parts = []
        if reason:
            parts.append(reason)
        else:
            parts.append("Strava cooldown active")
        if scope:
            parts.append(f"scope: {scope}")
        if local:
            parts.append(f"until {local}")
        msg = "; ".join(parts)
    next_sync_raw = _get_setting("scheduler_next_run_epoch", "0")
    try:
        next_sync_epoch = int(next_sync_raw or 0)
    except Exception:
        next_sync_epoch = 0
    interval_raw = _get_setting("scheduler_current_interval_sec", "0")
    try:
        current_interval_sec = int(interval_raw or 0)
    except Exception:
        current_interval_sec = 0
    next_sync_local = _hl(next_sync_epoch) if next_sync_epoch else ""
    return {
        "now": now,
        "cooldown_until": int(cd or 0),
        "cooldown_until_local": _hl(cd) if cd else "",
        "cooldown_reason": reason,
        "cooldown_scope": scope,
        "cooldown_set_at": set_at,
        "cooldown_message": msg,
        "requests_15m": int(c15 or 0),
        "requests_24h": int(c24 or 0),
        "errors_429_15m": int(e15 or 0),
        "errors_429_24h": int(e24 or 0),
        "last_headers": hdrs,
        "next_sync_epoch": next_sync_epoch,
        "next_sync_local": next_sync_local,
        "current_interval_sec": current_interval_sec,
    }


@app.get("/api/admin/polling_profile")
def get_polling_profile() -> Dict[str, Any]:
    profile = _scheduler._load_polling_profile()
    if not profile:
        profile = {}
    intervals_map = profile.get("intervals") or {}
    fallback = int(profile.get("fallback") or 0)
    intervals: list[int] = []
    for minute in range(1440):
        val = intervals_map.get(minute)
        if val is None:
            val = intervals_map.get(str(minute))
        if val is None:
            val = fallback
        try:
            intervals.append(int(val))
        except Exception:
            intervals.append(fallback)
    return {
        "intervals": intervals,
        "computed_at": profile.get("computed_at"),
        "valid_until": profile.get("valid_until"),
        "fallback": fallback,
        "total_samples": profile.get("total_samples") or 0,
    }


# -----------------------------------------------------------------------------
# Counters (list/reset)
# -----------------------------------------------------------------------------


@app.get("/api/counters")
def get_counters() -> Dict[str, Any]:
    from .db import list_counters as _list_counters
    items = _list_counters()
    return {"items": [{"key": k, "value": v} for (k, v) in items], "total": len(items)}


@app.post("/api/counters/{key}/reset")
def reset_single_counter(key: str) -> Dict[str, Any]:
    from .db import reset_counter as _reset_counter
    _reset_counter(key)
    return {"key": key, "value": 0}


@app.post("/api/counters/reset_all")
def reset_counters_all() -> Dict[str, Any]:
    from .db import reset_all_counters as _reset_all_counters
    n = _reset_all_counters()
    return {"reset": n}


# -----------------------------------------------------------------------------
# Automations CRUD (minimal)
# -----------------------------------------------------------------------------


@app.get("/api/automations", response_model=List[Automation])
def list_automations() -> List[Automation]:
    sql = """
    SELECT id, name, enabled, priority, conditions_json, effects_json, created_at, updated_at
    FROM automations
    ORDER BY priority DESC, created_at ASC
    """
    with engine.connect() as conn:
        result: Result = conn.execute(sql_text(sql))
        rows = result.fetchall()
    return [_row_to_automation(r) for r in rows]


@app.get("/api/automations/{automation_id}", response_model=Automation)
def get_automation(automation_id: str) -> Automation:
    sql = """
    SELECT id, name, enabled, priority, conditions_json, effects_json, created_at, updated_at
    FROM automations WHERE id = :id
    """
    with engine.connect() as conn:
        row = conn.execute(sql_text(sql), {"id": automation_id}).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Automation not found")
    return _row_to_automation(row)


@app.post(
    "/api/automations", response_model=Automation, status_code=status.HTTP_201_CREATED
)
def create_automation(payload: AutomationCreate) -> Automation:
    now = datetime.now(tz=timezone.utc)
    new_id = str(uuid.uuid4())

    try:
        # validate nested structures explicitly so we fail fast with 422s if needed
        for c in payload.conditions:
            Condition.model_validate(c)
        for e in payload.effects:
            Effect.model_validate(e)
    except ValidationError as ve:
        raise HTTPException(status_code=422, detail=str(ve))

    sql = """
    INSERT INTO automations (id, name, enabled, priority, conditions_json, effects_json, created_at, updated_at)
    VALUES (:id, :name, :enabled, :priority, :conditions_json, :effects_json, :created_at, :updated_at)
    """
    with engine.begin() as conn:
        conn.execute(
            sql_text(sql),
            {
                "id": new_id,
                "name": payload.name,
                "enabled": 1 if payload.enabled else 0,
                "priority": payload.priority,
                "conditions_json": json.dumps(
                    [c.model_dump() for c in payload.conditions]
                ),
                "effects_json": json.dumps([e.model_dump() for e in payload.effects]),
                "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
            },
        )

    return Automation(
        id=new_id,
        name=payload.name,
        enabled=payload.enabled,
        priority=payload.priority,
        conditions=payload.conditions,
        effects=payload.effects,
        created_at=now,
        updated_at=now,
    )


@app.delete("/api/automations/{automation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_automation(automation_id: str):
    sql = "DELETE FROM automations WHERE id = :id"
    with engine.begin() as conn:
        result = conn.execute(sql_text(sql), {"id": automation_id})
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Automation not found")


@app.patch("/api/automations/{automation_id}/enabled")
def set_automation_enabled(automation_id: str, payload: AutomationEnablePayload) -> Dict[str, Any]:
    """
    Minimal toggle endpoint to flip `enabled` flag.
    Returns the updated state.
    """
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        res = conn.execute(
            sql_text(
                """
                UPDATE automations SET enabled = :en, updated_at = :now
                WHERE id = :id
                """
            ),
            {"en": 1 if payload.enabled else 0, "now": now, "id": automation_id},
        )
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Automation not found")
    return {"id": automation_id, "enabled": payload.enabled}


@app.patch("/api/automations/{automation_id}", response_model=Automation)
def update_automation(automation_id: str, payload: AutomationUpdate) -> Automation:
    # Validate nested structures if provided
    try:
        if payload.conditions is not None:
            for c in payload.conditions:
                Condition.model_validate(c)
        if payload.effects is not None:
            for e in payload.effects:
                Effect.model_validate(e)
    except ValidationError as ve:
        raise HTTPException(status_code=422, detail=str(ve))

    now = datetime.now(timezone.utc).isoformat()
    # Fetch existing to merge
    with engine.connect() as conn:
        row = conn.execute(
            sql_text(
                "SELECT name, enabled, priority, conditions_json, effects_json, created_at, updated_at FROM automations WHERE id = :id"
            ),
            {"id": automation_id},
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Automation not found")

    next_name = payload.name if payload.name is not None else row.name
    next_enabled = 1 if (payload.enabled if payload.enabled is not None else bool(row.enabled)) else 0
    next_priority = payload.priority if payload.priority is not None else row.priority
    next_conditions_json = (
        json.dumps([c.model_dump() for c in payload.conditions]) if payload.conditions is not None else row.conditions_json
    )
    next_effects_json = (
        json.dumps([e.model_dump() for e in payload.effects]) if payload.effects is not None else row.effects_json
    )

    with engine.begin() as conn:
        conn.execute(
            sql_text(
                """
                UPDATE automations SET
                  name = :name,
                  enabled = :enabled,
                  priority = :priority,
                  conditions_json = :conditions_json,
                  effects_json = :effects_json,
                  updated_at = :now
                WHERE id = :id
                """
            ),
            {
                "id": automation_id,
                "name": next_name,
                "enabled": next_enabled,
                "priority": next_priority,
                "conditions_json": next_conditions_json,
                "effects_json": next_effects_json,
                "now": now,
            },
        )

    return get_automation(automation_id)


# -----------------------------------------------------------------------------
# Activities (placeholder list)
# -----------------------------------------------------------------------------

@app.get("/api/activities")
def list_activities(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sport: Optional[str] = Query(None, description="Filter by sport_type"),
) -> Dict[str, Any]:
    """
    Return paginated activities from local DB.

    Acceptance: GET /api/activities?limit=5&offset=0 returns total>=0 and len(items)<=5.
    """
    where = ""
    params: Dict[str, Any] = {"limit": limit, "offset": offset}
    sport_filter: Optional[str]
    if isinstance(sport, str):
        sport_filter = sport.strip()
    else:
        sport_filter = None
    if sport_filter:
        where = "WHERE sport_type = :sport"
        params["sport"] = sport_filter
    with engine.connect() as conn:
        total = conn.execute(
            sql_text(f"SELECT COUNT(*) AS c FROM activities {where}"), params
        ).scalar_one()
        rows = conn.execute(
            sql_text(
                f"""
                SELECT id, start_date, start_date_local, start_lat, start_lng, end_lat, end_lng,
                       sport_type, name, distance,
                       moving_time, elapsed_time, total_elevation_gain, commute, workout_type, gear_id, hide_from_home
                FROM activities
                {where}
                -- Sort by parsed start_date (handle ISO8601 with 'T' and 'Z')
                ORDER BY datetime(replace(substr(start_date,1,19), 'T', ' ')) DESC, id DESC
                LIMIT :limit OFFSET :offset
                """
            ),
            params,
        ).fetchall()

    items = [
        {
            "id": r.id,
            "start_date": r.start_date,
            "start_date_local": r.start_date_local,
            "start_lat": r.start_lat,
            "start_lng": r.start_lng,
            "end_lat": r.end_lat,
            "end_lng": r.end_lng,
            "sport_type": r.sport_type,
            "name": r.name,
            "distance": r.distance,
            "moving_time": r.moving_time,
            "elapsed_time": r.elapsed_time,
            "total_elevation_gain": r.total_elevation_gain,
            "commute": bool(r.commute) if r.commute is not None else None,
            "workout_type": r.workout_type,
            "gear_id": r.gear_id,
            "hide_from_home": bool(r.hide_from_home) if r.hide_from_home is not None else None,
        }
        for r in rows
    ]
    return {"total": int(total), "items": items}


@app.delete("/api/activities/{activity_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_activity(activity_id: int) -> Response:
    """Delete a single activity from the local DB only (does not touch Strava)."""
    with engine.begin() as conn:
        res = conn.execute(sql_text("DELETE FROM activities WHERE id = :id"), {"id": activity_id})
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Activity not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/activities/clear")
def clear_activities() -> Dict[str, int]:
    """Delete all activities from the local DB. Returns deleted row count."""
    with engine.begin() as conn:
        before = conn.execute(sql_text("SELECT COUNT(*) AS c FROM activities")).scalar_one()
        conn.execute(sql_text("DELETE FROM activities"))
    # Reset the ingestion cursor so a subsequent ingest repopulates from scratch
    try:
        set_setting("last_seen_activity_time", "0")
    except Exception:
        pass
    return {"deleted": int(before)}


# -----------------------------------------------------------------------------
# Root
# -----------------------------------------------------------------------------


@app.get("/")
def root() -> Dict[str, str]:
    return {"message": "Strava Auto Server API. See /docs for OpenAPI UI."}


# -----------------------------------------------------------------------------
# Strava OAuth endpoints
# -----------------------------------------------------------------------------


@app.get("/api/auth/strava/init")
def strava_auth_init() -> Dict[str, str]:
    """
    Build Strava OAuth URL with scopes: activity:read_all,activity:write

    Acceptance: returns a URL containing client_id and redirect_uri.
    """
    client = StravaClient(engine)
    # Request profile:read_all to reliably fetch athlete gear (shoes/bikes)
    scopes = ["activity:read_all", "activity:write", "profile:read_all"]
    url = client.build_auth_url(scopes)
    return {"auth_url": url}


@app.get("/api/auth/strava/status")
def strava_auth_status() -> Dict[str, Optional[Any]]:
    """
    Show whether Strava is connected and token expiry.
    """
    with engine.connect() as conn:
        row = conn.execute(
            sql_text(
                "SELECT expires_at, scope FROM oauth_tokens WHERE provider='strava'"
            )
        ).fetchone()
    if not row:
        return {"connected": False, "expires_at": None, "scope": None}
    return {
        "connected": True,
        "expires_at": int(row.expires_at) if row.expires_at is not None else None,
        "scope": row.scope,
    }


@app.get("/api/auth/strava/callback")
async def strava_auth_callback(
    request: Request, code: Optional[str] = None, scope: Optional[str] = None
) -> Any:
    """
    OAuth redirect handler: exchanges code for tokens and stores them.

    Acceptance:
    - Hitting with ?code=... stores tokens in oauth_tokens with provider='strava'.
    - Status endpoint then shows connected=true.
    """
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    client = StravaClient(engine)
    try:
        tok = await client.exchange_code_for_token(code)
    except Exception as e:  # noqa: BLE001
        # Redirect back to frontend with error indicator
        url = f"{FRONTEND_BASE_URL}/?connected=0&error=oauth"
        return RedirectResponse(url=url, status_code=status.HTTP_302_FOUND)
    # Success: redirect to frontend root with a simple flag
    accept = request.headers.get("accept", "")
    ua = request.headers.get("user-agent", "")
    wants_json = "application/json" in accept.lower()
    is_test_client = "testclient" in ua.lower()
    if wants_json or is_test_client:
        return {
            "athlete_id": tok.athlete_id,
            "scope": getattr(tok, "scope", None),
        }
    url = f"{FRONTEND_BASE_URL}/?connected=1"
    return RedirectResponse(url=url, status_code=status.HTTP_302_FOUND)


@app.post("/api/auth/strava/disconnect")
def strava_auth_disconnect() -> Dict[str, Any]:
    """Disconnect Strava by removing stored tokens.

    Frontend can call this to reset connection; scheduler will pause automatically.
    """
    with engine.begin() as conn:
        conn.execute(sql_text("DELETE FROM oauth_tokens WHERE provider='strava'"))
    return {"connected": False}


# -----------------------------------------------------------------------------
# Admin: trigger ingest now
# -----------------------------------------------------------------------------


@app.post("/api/admin/ingest")
async def admin_run_ingest_now() -> Dict[str, Any]:
    """Manually trigger a single ingest cycle with debug context."""
    cooldown_detail = get_cooldown_detail()
    cd_until = int(cooldown_detail.get("until") or 0)
    now = int(time.time())
    if cd_until and now < cd_until:
        message = (
            f"Strava cooldown active until {human_local_from_epoch(cd_until)}"
            if cd_until
            else "Strava cooldown active"
        )
        return {
            "inserted": 0,
            "updated": 0,
            "cursor": None,
            "message": message,
            "cooldown": cooldown_detail,
        }
    # Snapshot state before
    with engine.connect() as conn:
        before = conn.execute(sql_text("SELECT COUNT(*) AS c FROM activities")).scalar_one()
    from .db import get_setting as _get_setting
    cur_before = _get_setting("last_seen_activity_time", "0")
    try:
        inserted, updated, cursor = await _scheduler._ingest_activities(engine)  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Ingest failed: {e}") from e
    with engine.connect() as conn:
        after = conn.execute(sql_text("SELECT COUNT(*) AS c FROM activities")).scalar_one()
    cur_after = _get_setting("last_seen_activity_time", "0")
    message = f"Ingested {inserted} new, {updated} updated"
    return {
        "inserted": inserted,
        "updated": updated,
        "cursor": cursor,
        "message": message,
        "debug": {
            "count_before": int(before),
            "count_after": int(after),
            "cursor_before": int(cur_before or 0),
            "cursor_after": int(cur_after or 0),
        },
    }


class ReapplyCountersPayload(BaseModel):
    dry_run: bool = False
    limit: Optional[int] = Field(default=None, ge=1, le=100000)


@app.post("/api/admin/reapply_counters")
async def admin_reapply_counters(payload: ReapplyCountersPayload) -> Dict[str, Any]:
    """Re-evaluate activities against automations that include counter templates and apply.

    - Processes activities in ascending start_date order so counters increment chronologically.
    - If dry_run=true, calculates the would-change set and next counter values without applying or incrementing.
    - Skips activities that do not match any counter-template automations.
    """
    # Load enabled automations and filter those that include a counter template in any set_title_template effect
    autos = _load_enabled_automations()
    counter_autos: list[dict[str, Any]] = []
    for a in autos:
        try:
            for e in (a.get("effects") or []):
                if e.get("type") == "set_title_template":
                    tpl = (e.get("params") or {}).get("template")
                    if isinstance(tpl, str) and "{count:" in tpl:
                        counter_autos.append(a)
                        break
        except Exception:
            continue
    if not counter_autos:
        return {"updated": 0, "skipped": 0, "applied_ids": [], "dry_run": payload.dry_run}

    # Enumerate activities in ascending time order
    limit = payload.limit
    with engine.connect() as conn:
        if limit is None:
            rows = conn.execute(
                sql_text(
                    "SELECT id FROM activities ORDER BY datetime(COALESCE(start_date, updated_at)) ASC"
                )
            ).fetchall()
        else:
            rows = conn.execute(
                sql_text(
                    "SELECT id FROM activities ORDER BY datetime(COALESCE(start_date, updated_at)) ASC LIMIT :lim"
                ),
                {"lim": int(limit)},
            ).fetchall()
    ids = [int(r.id) for r in rows]
    updated = 0
    skipped = 0
    applied_ids: list[int] = []
    client = StravaClient(engine)

    for aid in ids:
        activity = _load_activity_dict(aid)
        if not activity:
            skipped += 1
            continue
        # Evaluate only counter automations
        desired_name = activity.get("name")
        desired_sport = activity.get("sport_type")
        desired_commute = activity.get("commute")
        desired_workout = activity.get("workout_type")
        desired_gear = activity.get("gear_id")
        desired_description = None
        matched_any = False
        for a in counter_autos:
            try:
                if _scheduler._conditions_match(a.get("conditions", []), activity):  # type: ignore[attr-defined]
                    matched_any = True
                    (
                        desired_name,
                        desired_sport,
                        desired_commute,
                        desired_workout,
                        new_gear,
                    ) = _scheduler._apply_effects(  # type: ignore[attr-defined]
                        a.get("effects", []),
                        desired_name,
                        desired_sport,
                        desired_commute,
                        desired_workout,
                    )
                    if new_gear is not None:
                        desired_gear = new_gear
                    for e in a.get("effects", []):
                        if e.get("type") == "set_description":
                            desired_description = (e.get("params") or {}).get("text")
            except Exception:
                continue

        if not matched_any:
            skipped += 1
            continue

        # Compute changes; for title, render counters here (inc only if not dry_run)
        prev = {
            "name": activity.get("name"),
            "sport_type": activity.get("sport_type"),
            "commute": activity.get("commute"),
            "workout_type": activity.get("workout_type"),
            "gear_id": activity.get("gear_id"),
        }
        desired_title_template = desired_name
        # Render counter placeholders
        name_final = _render_title_preview_or_inc(desired_title_template, inc=not payload.dry_run)
        desired = {
            "name": name_final,
            "sport_type": desired_sport,
            "commute": desired_commute,
            "workout_type": desired_workout,
            "gear_id": desired_gear,
            "description": desired_description,
        }
        changes = {k: v for k, v in desired.items() if v != prev.get(k)}

        if not changes:
            skipped += 1
            continue

        if payload.dry_run:
            updated += 1
            applied_ids.append(aid)
            continue

        # Apply on Strava
        try:
            await client.update_activity(
                aid,
                name=changes.get("name"),
                sport_type=changes.get("sport_type"),
                commute=changes.get("commute"),
                workout_type=changes.get("workout_type"),
                gear_id=changes.get("gear_id"),
                hide_from_home=None,
                description=changes.get("description"),
            )
        except Exception as e:  # noqa: BLE001
            _insert_audit_run(aid, source="reapply", automation_ids=[], changes=changes, error=str(e))
            skipped += 1
            continue

        # Mirror to local DB
        now_iso = datetime.now(timezone.utc).isoformat()
        with engine.begin() as conn:
            conn.execute(
                sql_text(
                    """
                    UPDATE activities SET
                      name = COALESCE(:name, name),
                      sport_type = COALESCE(:sport_type, sport_type),
                      commute = COALESCE(:commute, commute),
                      workout_type = COALESCE(:workout_type, workout_type),
                      gear_id = COALESCE(:gear_id, gear_id),
                      updated_at = :now
                    WHERE id = :id
                    """
                ),
                {
                    "id": aid,
                    "name": name_final,
                    "sport_type": changes.get("sport_type"),
                    "commute": 1 if changes.get("commute") else 0 if changes.get("commute") is not None else None,
                    "workout_type": changes.get("workout_type"),
                    "gear_id": changes.get("gear_id"),
                    "now": now_iso,
                },
            )
        _insert_audit_run(aid, source="reapply", automation_ids=[], changes=changes, error=None)
        updated += 1
        applied_ids.append(aid)

    return {"updated": updated, "skipped": skipped, "applied_ids": applied_ids, "dry_run": payload.dry_run}


# -----------------------------------------------------------------------------
# Per-activity manual refresh + automation preview/apply
# -----------------------------------------------------------------------------


@app.post("/api/activities/{activity_id}/refresh")
async def refresh_activity_from_strava(activity_id: int) -> Dict[str, Any]:
    """Fetch latest Strava detail for a single activity and update the local row."""

    cooldown_detail = get_cooldown_detail()
    cd_until = int(cooldown_detail.get("until") or 0)
    now = int(time.time())
    if cd_until and now < cd_until:
        message = (
            f"Strava cooldown active until {human_local_from_epoch(cd_until)}"
            if cd_until
            else "Strava cooldown active"
        )
        return {
            "updated": False,
            "message": message,
            "cooldown": cooldown_detail,
        }

    client = StravaClient(engine)
    result = await _scheduler.refresh_activity_detail(  # type: ignore[attr-defined]
        engine,
        client,
        activity_id,
        respect_cooldown=False,
    )

    if result.get("cooldown"):
        try:
            detail = result["cooldown"]
            until = int(detail.get("until") or 0)
            if until:
                result["message"] = (
                    f"Strava cooldown active until {human_local_from_epoch(until)}"
                )
        except Exception:
            pass

    if "updated" not in result:
        result["updated"] = False
    return result


# Per-activity automation preview/apply
# -----------------------------------------------------------------------------


def _load_enabled_automations() -> list[dict[str, Any]]:
    with engine.connect() as conn:
        rows = conn.execute(
            sql_text(
                "SELECT id, name, priority, conditions_json, effects_json FROM automations WHERE enabled=1 ORDER BY priority DESC, created_at ASC"
            )
        ).fetchall()
    autos: list[dict[str, Any]] = []
    for r in rows:
        try:
            autos.append(
                {
                    "id": r.id,
                    "name": r.name,
                    "priority": r.priority,
                    "conditions": json.loads(r.conditions_json or "[]"),
                    "effects": json.loads(r.effects_json or "[]"),
                }
            )
        except Exception:
            continue
    return autos


def _load_activity_dict(activity_id: int) -> dict[str, Any] | None:
    with engine.connect() as conn:
        row = conn.execute(
            sql_text(
                """
                SELECT id, start_date, start_date_local, start_lat, start_lng, end_lat, end_lng,
                       sport_type, name, distance,
                       moving_time, elapsed_time, total_elevation_gain, commute, workout_type, gear_id, hide_from_home
                FROM activities WHERE id = :id
                """
            ),
            {"id": activity_id},
        ).fetchone()
    if not row:
        return None
    return {
        "id": row.id,
        "start_date": row.start_date,
        "start_date_local": row.start_date_local,
        "start_lat": row.start_lat,
        "start_lng": row.start_lng,
        "end_lat": row.end_lat,
        "end_lng": row.end_lng,
        "sport_type": row.sport_type,
        "name": row.name,
        "distance": row.distance,
        "moving_time": row.moving_time,
        "elapsed_time": row.elapsed_time,
        "total_elevation_gain": row.total_elevation_gain,
        "commute": bool(row.commute) if row.commute is not None else None,
        "workout_type": row.workout_type,
        "gear_id": row.gear_id,
        "hide_from_home": bool(row.hide_from_home) if row.hide_from_home is not None else None,
    }


@app.get("/api/activities/{activity_id}/preview")
def preview_activity_automations(activity_id: int) -> Dict[str, Any]:
    activity = _load_activity_dict(activity_id)
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")
    autos = _load_enabled_automations()
    desired = {
        "name": activity["name"],
        "sport_type": activity["sport_type"],
        "commute": activity.get("commute"),
        "workout_type": activity.get("workout_type"),
        "gear_id": activity.get("gear_id"),
        "hide_from_home": None,
    }
    matched: list[dict[str, Any]] = []
    if autos:
        name = desired["name"]
        sport = desired["sport_type"]
        commute = desired["commute"]
        wtype = desired["workout_type"]
        gear = desired["gear_id"]
        hide_home = None
        hide_clubs = None
        tpl_present = False
        tpl_value: Optional[str] = None
        for a in autos:
            if _scheduler._conditions_match(a.get("conditions", []), activity):  # type: ignore[attr-defined]
                matched.append({"id": a["id"], "name": a["name"]})
                name, sport, commute, wtype, new_gear = _scheduler._apply_effects(a.get("effects", []), name, sport, commute, wtype)  # type: ignore[attr-defined]
                if new_gear is not None:
                    gear = new_gear
                # Inspect effects for hide flags (simple pass)
                for e in a.get("effects", []):
                    if e.get("type") == "hide_from_feeds":
                        p = e.get("params") or {}
                        v_home = p.get("home", True)
                        hide_home = bool(v_home)
                        # Clubs param is currently ignored by Strava API; hide_from_home covers both feeds
                    if e.get("type") == "set_title_template":
                        tpl_present = True
                        tpl_value = (e.get("params") or {}).get("template")
                    if e.get("type") == "set_description":
                        desired["description"] = (e.get("params") or {}).get("text")
        desired = {"name": name, "sport_type": sport, "commute": commute, "workout_type": wtype, "gear_id": gear, "hide_from_home": hide_home}
    # Render any counter placeholders for preview without incrementing
    if tpl_present and isinstance(activity.get("name"), str) and isinstance(desired.get("name"), str):
        # If current already matches a rendered template pattern, show no change
        if tpl_value and _template_already_applied(activity["name"], tpl_value):
            desired["name"] = activity["name"]
        else:
            desired["name"] = _render_title_preview_or_inc(desired.get("name"), inc=False)
    else:
        desired["name"] = _render_title_preview_or_inc(desired.get("name"), inc=False)
    applies = desired != {
        "name": activity["name"],
        "sport_type": activity["sport_type"],
        "commute": activity.get("commute"),
        "workout_type": activity.get("workout_type"),
        "gear_id": activity.get("gear_id"),
    }
    return {"activity_id": activity_id, "applies": applies, "desired": desired, "matched_automations": matched}


@app.post("/api/activities/{activity_id}/apply")
async def apply_activity_automations(activity_id: int) -> Dict[str, Any]:
    activity = _load_activity_dict(activity_id)
    if not activity:
        raise HTTPException(status_code=404, detail="Activity not found")
    prev = {
        "name": activity["name"],
        "sport_type": activity["sport_type"],
        "commute": activity.get("commute"),
        "workout_type": activity.get("workout_type"),
        "gear_id": activity.get("gear_id"),
        "hide_from_home": activity.get("hide_from_home"),
        "description": None,
    }
    preview = preview_activity_automations(activity_id)
    desired = preview["desired"]
    changes = {k: v for k, v in desired.items() if v != prev.get(k)}
    if not changes:
        return {"updated": False, "changes": {}, "applies": False, "matched_automations": preview["matched_automations"]}
    client = StravaClient(engine)
    try:
        await client.update_activity(
            activity_id,
            name=_render_title_preview_or_inc(changes.get("name"), inc=True),
            sport_type=changes.get("sport_type"),
            commute=changes.get("commute"),
            workout_type=changes.get("workout_type"),
            gear_id=changes.get("gear_id"),
            hide_from_home=changes.get("hide_from_home"),
            description=changes.get("description"),
        )
    except Exception as e:  # noqa: BLE001
        # Record failed attempt
        _insert_audit_run(activity_id, source="manual", automation_ids=[m["id"] for m in preview["matched_automations"]], changes=changes, error=str(e))
        raise HTTPException(status_code=502, detail=f"Failed to apply on Strava: {e}") from e
    # Mirror to local DB
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        conn.execute(
            sql_text(
                """
                UPDATE activities SET
                  name = COALESCE(:name, name),
                  sport_type = COALESCE(:sport_type, sport_type),
                  commute = COALESCE(:commute, commute),
                  workout_type = COALESCE(:workout_type, workout_type),
                  gear_id = COALESCE(:gear_id, gear_id),
                  hide_from_home = COALESCE(:hide_from_home, hide_from_home),
                  updated_at = :now
                WHERE id = :id
                """
            ),
            {
                "id": activity_id,
                "name": _render_title_preview_or_inc(changes.get("name"), inc=False),
                "sport_type": changes.get("sport_type"),
                "commute": 1 if changes.get("commute") else 0 if changes.get("commute") is not None else None,
                "workout_type": changes.get("workout_type"),
                "gear_id": changes.get("gear_id"),
                "hide_from_home": 1 if changes.get("hide_from_home") else 0 if changes.get("hide_from_home") is not None else None,
                "now": now,
            },
        )
    # Record success
    _insert_audit_run(activity_id, source="manual", automation_ids=[m["id"] for m in preview["matched_automations"]], changes=changes, error=None)
    return {"updated": True, "changes": changes, "applies": True, "matched_automations": preview["matched_automations"]}


import re
_COUNT_RE_PREVIEW = re.compile(r"\{count:([A-Za-z0-9_\-]+)\}")


def _render_title_preview_or_inc(name: Optional[str], *, inc: bool) -> Optional[str]:
    if not name:
        return name
    if "{count:" not in name:
        return name
    from .db import inc_counter as _inc_counter, get_counter as _get_counter
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        try:
            if inc:
                return str(_inc_counter(key))
            # preview: show next value without incrementing
            return str((_get_counter(key) or 0) + 1)
        except Exception:
            return "0"
    return _COUNT_RE_PREVIEW.sub(repl, name)

def _template_already_applied(current: str, template: str) -> bool:
    try:
        start = template.index("{count:")
        end = template.index("}", start)
    except ValueError:
        return False
    prefix = template[:start]
    suffix = template[end + 1 :]
    import re as _re
    pat = _re.compile(r"^" + _re.escape(prefix) + r"\s*\d+\s*" + _re.escape(suffix) + r"$")
    return bool(pat.match(current or ""))


def _insert_audit_run(activity_id: int, *, source: str, automation_ids: list[str], changes: dict[str, Any], error: str | None) -> None:
    rid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        conn.execute(
            sql_text(
                """
                INSERT INTO automation_runs (id, activity_id, source, automation_ids, changes_json, error, created_at)
                VALUES (:id, :aid, :src, :autos, :chg, :err, :now)
                """
            ),
            {
                "id": rid,
                "aid": activity_id,
                "src": source,
                "autos": json.dumps(automation_ids),
                "chg": json.dumps(changes, separators=(",", ":")),
                "err": error,
                "now": now,
            },
        )


@app.get("/api/activities/{activity_id}/audit")
def get_activity_audit(activity_id: int, limit: int = Query(20, ge=1, le=200)) -> Dict[str, Any]:
    with engine.connect() as conn:
        rows = conn.execute(
            sql_text(
                """
                SELECT id, source, automation_ids, changes_json, error, created_at
                FROM automation_runs
                WHERE activity_id = :id
                ORDER BY datetime(created_at) DESC
                LIMIT :limit
                """
            ),
            {"id": activity_id, "limit": limit},
        ).fetchall()
    items = [
        {
            "id": r.id,
            "source": r.source,
            "automation_ids": json.loads(r.automation_ids or "[]"),
            "changes": json.loads(r.changes_json or "{}"),
            "error": r.error,
            "created_at": r.created_at,
        }
        for r in rows
    ]
    return {"items": items}
# -----------------------------------------------------------------------------
# Athlete gear (shoes/bikes)
# -----------------------------------------------------------------------------


@app.get("/api/athlete/gear")
async def get_athlete_gear() -> Dict[str, Any]:
    client = StravaClient(engine)
    try:
        data = await client.get_athlete_gear()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch athlete: {e}") from e
    # Already in canonical { shoes: [...] } shape
    return data


# -----------------------------------------------------------------------------
# Geocoding (Nominatim-backed) with SQLite cache
# -----------------------------------------------------------------------------


@app.get("/api/geocode")
async def geocode(q: str, limit: int = Query(5, ge=1, le=10)) -> Dict[str, Any]:
    if not q or not q.strip():
        raise HTTPException(status_code=400, detail="Missing q")
    # try cache
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(days=GEOCODE_TTL_DAYS)
    with engine.connect() as conn:
        row = conn.execute(
            sql_text("SELECT results_json, updated_at FROM geocode_cache WHERE query = :q"),
            {"q": q.strip()},
        ).fetchone()
    if row:
        try:
            updated = datetime.fromisoformat(str(row.updated_at))
        except Exception:
            updated = now
        if updated >= stale_before:
            try:
                return {"items": json.loads(row.results_json)}
            except Exception:
                pass
    # fetch from provider
    if GEOCODE_PROVIDER != "nominatim":
        raise HTTPException(status_code=500, detail="Only Nominatim provider is implemented")
    url = "https://nominatim.openstreetmap.org/search"
    params = {"format": "jsonv2", "q": q, "limit": str(limit), "email": GEOCODE_CONTACT_EMAIL}
    headers = {"User-Agent": f"strava-auto-server/0.1 ({GEOCODE_CONTACT_EMAIL})"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        items = [
            {
                "lat": float(it.get("lat")),
                "lon": float(it.get("lon")),
                "display_name": it.get("display_name"),
            }
            for it in (data or [])
            if it.get("lat") is not None and it.get("lon") is not None
        ][:limit]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Geocode failed: {e}") from e
    # save cache
    with engine.begin() as conn:
        conn.execute(
            sql_text(
                """
                INSERT INTO geocode_cache (query, results_json, updated_at)
                VALUES (:q, :j, :now)
                ON CONFLICT(query) DO UPDATE SET results_json = excluded.results_json, updated_at = excluded.updated_at
                """
            ),
            {"q": q.strip(), "j": json.dumps(items), "now": now.isoformat()},
        )
    return {"items": items}


@app.get("/api/reverse")
async def reverse_geocode(lat: float, lon: float) -> Dict[str, Any]:
    """Reverse geocode lat/lon to a display name (OSM Nominatim).

    Caches results in geocode_cache keyed by a rounded coordinate string.
    """
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(days=GEOCODE_TTL_DAYS)
    # Round to 5 decimals to keep cache keys stable (~1m)
    key = f"rev:{lat:.5f},{lon:.5f}"
    with engine.connect() as conn:
        row = conn.execute(
            sql_text("SELECT results_json, updated_at FROM geocode_cache WHERE query = :q"),
            {"q": key},
        ).fetchone()
    if row:
        try:
            updated = datetime.fromisoformat(str(row.updated_at))
        except Exception:
            updated = now
        if updated >= stale_before:
            try:
                items = json.loads(row.results_json)
                if isinstance(items, list) and items:
                    return {"display_name": items[0].get("display_name"), "lat": items[0].get("lat"), "lon": items[0].get("lon")}
            except Exception:
                pass
    if GEOCODE_PROVIDER != "nominatim":
        raise HTTPException(status_code=500, detail="Only Nominatim provider is implemented")
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "email": GEOCODE_CONTACT_EMAIL,
        "zoom": "16",
        "addressdetails": "1",
    }
    headers = {"User-Agent": f"strava-auto-server/0.1 ({GEOCODE_CONTACT_EMAIL})"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        item = {
            "lat": float(data.get("lat") or lat),
            "lon": float(data.get("lon") or lon),
            "display_name": data.get("display_name") or "",
        }
        # store as a single-item array for compatibility with geocode cache format
        with engine.begin() as conn:
            conn.execute(
                sql_text(
                    """
                    INSERT INTO geocode_cache (query, results_json, updated_at)
                    VALUES (:q, :j, :now)
                    ON CONFLICT(query) DO UPDATE SET results_json = excluded.results_json, updated_at = excluded.updated_at
                    """
                ),
                {"q": key, "j": json.dumps([item]), "now": now.isoformat()},
            )
        return item
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Reverse geocode failed: {e}") from e
