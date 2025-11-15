"""
APScheduler setup for polling Strava activities.

Job runs every POLLING_INTERVAL_SEC seconds and:
- Skips if no tokens in DB (logs occasionally).
- Refreshes token if needed.
- Fetches activities after `last_seen_activity_time` (settings key).
- Upserts into `activities` table, updates `updated_at`.
- Updates `last_seen_activity_time` to max start_date seen.

Idempotency: updates existing row if raw_json changed, else skips.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone, timedelta
import time
from typing import Any, Dict, Optional, Tuple, List, TypedDict

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text as sql_text
from sqlalchemy.engine import Engine

from .db import get_engine, get_setting, set_setting, inc_counter, get_counter
from .strava_client import StravaClient
from .polling_profile import (
    MIN_POLL_INTERVAL,
    MAX_POLL_INTERVAL,
    compute_polling_profile,
    load_polling_profile,
)

log = logging.getLogger("strava-auto-server.scheduler")


def _parse_iso8601(s: str) -> datetime:
    # Strava uses 'Z' suffix; Python accepts '+00:00'
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))



_MIN_POLL_INTERVAL = MIN_POLL_INTERVAL
_MAX_POLL_INTERVAL = MAX_POLL_INTERVAL


def _minute_of_day_from_epoch(epoch: float) -> int:
    lt = time.localtime(epoch)
    return int(lt.tm_hour) * 60 + int(lt.tm_min)
def _load_polling_profile() -> Dict[str, Any]:
    return load_polling_profile()


def _compute_polling_profile(
    engine: Engine, *, default_interval: int
) -> Dict[str, Any]:
    profile = compute_polling_profile(engine, default_interval=default_interval)
    log.info(
        "Polling profile computed: samples=%s fallback=%ss",
        int(profile.get("total_samples") or 0),
        profile.get("fallback"),
    )
    return profile


async def _ingest_activities(engine: Engine) -> Tuple[int, int, Optional[int]]:
    client = StravaClient(engine)
    # Cooldown guard: skip if active
    try:
        from .db import get_cooldown_detail as _get_cd_detail
        from .timefmt import human_local_from_epoch as _hl

        _cd = _get_cd_detail()
        cd_until = int(_cd.get("until") or 0)
        now = int(time.time())
        if cd_until and now < cd_until:
            reason = str(_cd.get("reason") or "")
            scope = str(_cd.get("scope") or "")
            msg = f"Cooldown active until {_hl(cd_until)} (epoch={cd_until})"
            if reason:
                msg += f"; reason: {reason}"
            if scope:
                msg += f"; scope: {scope}"
            log.warning(msg + "; skipping ingest")
            return (0, 0, None)
    except Exception:
        pass
    # Quick token presence check
    with engine.connect() as conn:
        row = conn.execute(
            sql_text("SELECT 1 FROM oauth_tokens WHERE provider='strava'")
        )
        has_token = row.fetchone() is not None
    if not has_token:
        log.error("No Strava OAuth tokens found; skipping activity ingestion")
        return (0, 0, None)

    # Refresh if needed
    try:
        await client.refresh_token_if_needed()
    except Exception as e:  # noqa: BLE001
        log.warning("Token refresh error: %s", e)

    after_raw = get_setting("last_seen_activity_time", "0")
    after = int(after_raw) if after_raw else 0
    after_param: Optional[int] = after
    # If local DB is empty, fetch the most recent page (omit 'after')
    try:
        with engine.connect() as conn:
            local_count = conn.execute(
                sql_text("SELECT COUNT(*) AS c FROM activities")
            ).scalar_one()
        if int(local_count) == 0:
            log.info(
                "Local DB empty; requesting most recent activities (no 'after' param)"
            )
            after_param = None
    except Exception:
        pass

    try:
        acts = await client.get_athlete_activities(after=after_param)
    except Exception as e:  # noqa: BLE001
        log.warning("Fetch activities error: %s", e)
        return (0, 0, after)

    if not acts:
        # If a cooldown is active (likely 429), do not attempt a fallback fetch
        try:
            from .db import get_cooldown_until as _get_cd

            if _get_cd() and int(time.time()) < _get_cd():
                log.warning("Cooldown active; skipping fallback fetch")
                return (0, 0, after)
        except Exception:
            pass
        # Fallback: if we used an 'after' cursor and received nothing, fetch the most recent page
        if after_param is not None:
            try:
                acts = await client.get_athlete_activities(after=None)
            except Exception:
                acts = []
        if not acts:
            return (0, 0, after)

    # Load enabled automations once (ordered by priority DESC)
    with engine.connect() as conn:
        auto_rows = conn.execute(
            sql_text(
                "SELECT id, name, enabled, priority, conditions_json, effects_json FROM automations WHERE enabled = 1 ORDER BY priority DESC, created_at ASC"
            )
        ).fetchall()
    automations: List[Dict[str, Any]] = []
    for r in auto_rows:
        try:
            automations.append(
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

    inserted = 0
    updated = 0
    max_seen = after if after_param is not None else 0
    now_iso = datetime.now(timezone.utc).isoformat()

    # Plan Strava writebacks after DB upserts to avoid long-held transactions
    class PendingUpdate(TypedDict, total=False):
        id: int
        name: Optional[str]
        sport_type: Optional[str]
        commute: Optional[bool]
        workout_type: Optional[int]
        matched: List[str]
        gear_id: Optional[str]
        description: Optional[str]

    pending: List[PendingUpdate] = []
    with engine.begin() as conn:
        for a in acts:
            aid = int(a.get("id"))
            # denormalized
            start_date = a.get("start_date")
            start_date_local = a.get("start_date_local")
            sl = a.get("start_latlng") or [None, None]
            el = a.get("end_latlng") or [None, None]
            start_lat = (
                float(sl[0])
                if isinstance(sl, (list, tuple)) and len(sl) >= 2 and sl[0] is not None
                else None
            )
            start_lng = (
                float(sl[1])
                if isinstance(sl, (list, tuple)) and len(sl) >= 2 and sl[1] is not None
                else None
            )
            end_lat = (
                float(el[0])
                if isinstance(el, (list, tuple)) and len(el) >= 2 and el[0] is not None
                else None
            )
            end_lng = (
                float(el[1])
                if isinstance(el, (list, tuple)) and len(el) >= 2 and el[1] is not None
                else None
            )
            sport_type = a.get("sport_type")
            name = a.get("name")
            distance = a.get("distance")
            moving_time = a.get("moving_time")
            elapsed_time = a.get("elapsed_time")
            total_elevation_gain = a.get("total_elevation_gain")
            commute = a.get("commute")
            workout_type = a.get("workout_type")
            description = a.get("description")
            hide_from_home = a.get("hide_from_home")
            raw_json = _canonical_json(a)

            # compute max start_date epoch for cursor
            try:
                if isinstance(start_date, str):
                    ts = int(_parse_iso8601(start_date).timestamp())
                    if ts > max_seen:
                        max_seen = ts
            except Exception:  # best-effort
                pass

            # check existing
            row = conn.execute(
                sql_text("SELECT raw_json FROM activities WHERE id = :id"), {"id": aid}
            ).fetchone()

            if row is None:
                conn.execute(
                    sql_text(
                        """
                        INSERT INTO activities (
                          id, start_date, start_date_local, start_lat, start_lng, end_lat, end_lng,
                          sport_type, name, distance,
                          moving_time, elapsed_time, total_elevation_gain, commute, workout_type,
                          hide_from_home,
                          raw_json, updated_at
                        ) VALUES (
                          :id, :start_date, :start_date_local, :start_lat, :start_lng, :end_lat, :end_lng,
                          :sport_type, :name, :distance,
                          :moving_time, :elapsed_time, :total_elevation_gain, :commute, :workout_type,
                          :hide_from_home,
                          :raw_json, :updated_at
                        )
                    """
                    ),
                    {
                        "id": aid,
                        "start_date": start_date,
                        "start_date_local": start_date_local,
                        "start_lat": start_lat,
                        "start_lng": start_lng,
                        "end_lat": end_lat,
                        "end_lng": end_lng,
                        "sport_type": sport_type,
                        "name": name,
                        "distance": distance,
                        "moving_time": moving_time,
                        "elapsed_time": elapsed_time,
                        "total_elevation_gain": total_elevation_gain,
                        "commute": 1 if commute else 0 if commute is not None else None,
                        "hide_from_home": (
                            1
                            if hide_from_home
                            else 0 if hide_from_home is not None else None
                        ),
                        "workout_type": workout_type,
                        "raw_json": raw_json,
                        "updated_at": now_iso,
                    },
                )
                inserted += 1
            else:
                try:
                    # Compare parsed JSON for idempotency
                    prev = json.loads(row.raw_json)
                    curr = a
                    same = prev == curr
                except Exception:
                    same = row.raw_json == raw_json
                if same:
                    # Even if JSON hasn't changed, backfill denormalized fields if missing
                    conn.execute(
                        sql_text(
                            """
                            UPDATE activities SET
                              start_lat = COALESCE(start_lat, :start_lat),
                              start_lng = COALESCE(start_lng, :start_lng),
                              end_lat = COALESCE(end_lat, :end_lat),
                              end_lng = COALESCE(end_lng, :end_lng)
                            WHERE id = :id
                            """
                        ),
                        {
                            "id": aid,
                            "start_lat": start_lat,
                            "start_lng": start_lng,
                            "end_lat": end_lat,
                            "end_lng": end_lng,
                        },
                    )
                    continue
                conn.execute(
                    sql_text(
                        """
                        UPDATE activities SET
                          start_date = :start_date,
                          start_date_local = :start_date_local,
                          start_lat = COALESCE(:start_lat, start_lat),
                          start_lng = COALESCE(:start_lng, start_lng),
                          end_lat = COALESCE(:end_lat, end_lat),
                          end_lng = COALESCE(:end_lng, end_lng),
                          sport_type = :sport_type,
                          name = :name,
                          distance = :distance,
                          moving_time = :moving_time,
                          elapsed_time = :elapsed_time,
                          total_elevation_gain = :total_elevation_gain,
                          commute = COALESCE(:commute, commute),
                          hide_from_home = COALESCE(:hide_from_home, hide_from_home),
                          workout_type = COALESCE(:workout_type, workout_type),
                          raw_json = :raw_json,
                          updated_at = :updated_at
                        WHERE id = :id
                        """
                    ),
                    {
                        "id": aid,
                        "start_date": start_date,
                        "start_date_local": start_date_local,
                        "start_lat": start_lat,
                        "start_lng": start_lng,
                        "end_lat": end_lat,
                        "end_lng": end_lng,
                        "sport_type": sport_type,
                        "name": name,
                        "distance": distance,
                        "moving_time": moving_time,
                        "elapsed_time": elapsed_time,
                        "total_elevation_gain": total_elevation_gain,
                        "commute": 1 if commute else 0 if commute is not None else None,
                        "hide_from_home": (
                            1
                            if hide_from_home
                            else 0 if hide_from_home is not None else None
                        ),
                        "workout_type": workout_type,
                        "raw_json": raw_json,
                        "updated_at": now_iso,
                    },
                )
                updated += 1

            # Evaluate automations for this activity and stage potential updates
            if automations:
                desired_name = name
                desired_sport_type = sport_type
                desired_commute: Optional[bool] = None
                desired_workout_type: Optional[int] = None
                desired_gear_id: Optional[str] = None
                desired_description: Optional[str] = None
                desired_hide_from_home: Optional[bool] = None
                # Apply effects in priority order if conditions match
                matched_ids: List[str] = []
                for auto in automations:
                    if _conditions_match(
                        auto.get("conditions", []),
                        {
                            "id": aid,
                            "sport_type": sport_type,
                            "distance": distance,
                            "moving_time": moving_time,
                            "total_elevation_gain": total_elevation_gain,
                            "name": name,
                            "start_date": start_date,
                            "start_date_local": start_date_local,
                            "start_lat": start_lat,
                            "start_lng": start_lng,
                            "end_lat": end_lat,
                            "end_lng": end_lng,
                        },
                    ):
                        matched_ids.append(str(auto.get("id")))
                        (
                            desired_name,
                            desired_sport_type,
                            desired_commute,
                            desired_workout_type,
                            new_gear_id,
                        ) = _apply_effects(
                            auto.get("effects", []),
                            desired_name,
                            desired_sport_type,
                            desired_commute,
                            desired_workout_type,
                        )
                        if new_gear_id is not None:
                            desired_gear_id = new_gear_id
                        # Inspect effects for description and hide flags
                        for e in auto.get("effects", []):
                            if e.get("type") == "set_description":
                                txt = (e.get("params") or {}).get("text")
                                if txt is not None:
                                    desired_description = str(txt)
                            if e.get("type") == "hide_from_feeds":
                                p = e.get("params") or {}
                                v_home = p.get("home", True)
                                desired_hide_from_home = bool(v_home)
                # Stage update if anything changed
                payload: PendingUpdate = {"id": aid}
                changed = False
                # Idempotency for counter templates: if desired name is a template and the current
                # name already matches a rendered value, do not attempt to re-apply
                if (
                    isinstance(desired_name, str)
                    and "{count:" in desired_name
                    and isinstance(name, str)
                ):
                    if _template_already_applied(name, desired_name):
                        desired_name = name
                if desired_name is not None and desired_name != name:
                    payload["name"] = desired_name
                    changed = True
                if desired_sport_type and desired_sport_type != sport_type:
                    payload["sport_type"] = desired_sport_type
                    changed = True
                if desired_commute is not None:
                    payload["commute"] = bool(desired_commute)
                    changed = True
                if desired_workout_type is not None:
                    payload["workout_type"] = int(desired_workout_type)
                    changed = True
                if desired_gear_id is not None:
                    payload["gear_id"] = str(desired_gear_id)
                    changed = True
                if (
                    desired_description is not None
                    and desired_description != description
                ):
                    payload["description"] = desired_description
                    changed = True
                if desired_hide_from_home is not None:
                    payload["hide_from_home"] = desired_hide_from_home
                    changed = True
                if changed:
                    payload["matched"] = matched_ids
                    pending.append(payload)

    set_setting("last_seen_activity_time", str(max_seen))
    # Sync gear only when new or updated activities are present for this ingest run
    if inserted:
        try:
            await _sync_gear(engine, client)
        except Exception as e:  # noqa: BLE001
            log.info("Gear sync skipped: %s", e)
    # Apply Strava updates outside transaction, then reflect to DB
    for upd in pending:
        try:
            # Render counter templates in titles on apply
            nm = upd.get("name")
            final_name = (
                _render_title_with_counters(nm)
                if isinstance(nm, str) and "{count:" in nm
                else nm
            )
            resp = await client.update_activity(
                upd["id"],
                name=final_name,
                sport_type=upd.get("sport_type"),
                commute=upd.get("commute"),
                workout_type=upd.get("workout_type"),
                gear_id=upd.get("gear_id"),
                hide_from_home=upd.get("hide_from_home"),
                description=upd.get("description"),
            )
        except Exception as e:  # noqa: BLE001
            log.warning("Failed to update activity %s: %s", upd.get("id"), e)
            continue
        # Write back local DB if we changed fields
        if (
            upd.get("name")
            or upd.get("sport_type")
            or upd.get("workout_type")
            or ("commute" in upd)
            or upd.get("gear_id")
            or ("hide_from_home" in upd)
        ):
            with engine.begin() as conn:
                conn.execute(
                    sql_text(
                        """
                        UPDATE activities SET
                          name = COALESCE(:name, name),
                          sport_type = COALESCE(:sport_type, sport_type),
                          workout_type = COALESCE(:workout_type, workout_type),
                          commute = COALESCE(:commute, commute),
                          gear_id = COALESCE(:gear_id, gear_id),
                          hide_from_home = COALESCE(:hide_from_home, hide_from_home),
                          updated_at = :now
                        WHERE id = :id
                        """
                    ),
                    {
                        "id": upd["id"],
                        "name": final_name,
                        "sport_type": upd.get("sport_type"),
                        "workout_type": upd.get("workout_type"),
                        "commute": (
                            1
                            if upd.get("commute")
                            else 0 if upd.get("commute") is not None else None
                        ),
                        "gear_id": upd.get("gear_id"),
                        "hide_from_home": (
                            1
                            if upd.get("hide_from_home")
                            else 0 if upd.get("hide_from_home") is not None else None
                        ),
                        "now": datetime.now(timezone.utc).isoformat(),
                    },
                )
        # Audit record for scheduler apply
        try:
            from .main import _insert_audit_run  # lazy import to avoid cycle on import

            _insert_audit_run(
                int(upd["id"]),
                source="scheduler",
                automation_ids=list(upd.get("matched", [])),
                changes={
                    k: v
                    for k, v in upd.items()
                    if k
                    in (
                        "name",
                        "sport_type",
                        "commute",
                        "workout_type",
                        "gear_id",
                        "description",
                    )
                    and v is not None
                },
                error=None,
            )
        except Exception:
            # Do not fail ingestion if audit write fails
            pass

    log.info(
        "Ingested activities: inserted=%s updated=%s after=%s -> %s",
        inserted,
        updated,
        after,
        max_seen,
    )
    return (inserted, updated, max_seen)


async def refresh_activity_detail(
    engine: Engine,
    client: StravaClient,
    activity_id: int,
    *,
    respect_cooldown: bool = True,
) -> Dict[str, Any]:
    """Fetch the latest detail for an activity and update the local row.

    Returns a dict describing the outcome. If `respect_cooldown` is True and a cooldown
    is active, the call short-circuits with the cooldown metadata without attempting
    a Strava API request.
    """

    if respect_cooldown:
        try:
            from .db import get_cooldown_detail as _get_cd_detail

            detail = _get_cd_detail()
            cd_until = int(detail.get("until") or 0)
            now = int(time.time())
            if cd_until and now < cd_until:
                return {
                    "updated": False,
                    "activity_id": activity_id,
                    "cooldown": detail,
                    "message": f"Cooldown active until {cd_until}",
                }
        except Exception:
            pass

    with engine.connect() as conn:
        exists = (
            conn.execute(
                sql_text("SELECT 1 FROM activities WHERE id = :id"),
                {"id": activity_id},
            ).fetchone()
            is not None
        )
    if not exists:
        return {
            "updated": False,
            "activity_id": activity_id,
            "message": "Activity not found locally",
        }

    try:
        detail = await client.get_activity_detail(activity_id)
    except Exception as exc:  # noqa: BLE001
        return {
            "updated": False,
            "activity_id": activity_id,
            "message": f"Failed to fetch from Strava: {exc}",
        }

    if not detail:
        return {
            "updated": False,
            "activity_id": activity_id,
            "message": "Strava returned no data",
        }

    start_ll = detail.get("start_latlng") or [None, None]
    end_ll = detail.get("end_latlng") or [None, None]

    def _to_float(val: Any) -> Optional[float]:
        try:
            if val is None:
                return None
            return float(val)
        except Exception:
            return None

    start_lat = _to_float(start_ll[0]) if isinstance(start_ll, (list, tuple)) else None
    start_lng = _to_float(start_ll[1]) if isinstance(start_ll, (list, tuple)) else None
    end_lat = _to_float(end_ll[0]) if isinstance(end_ll, (list, tuple)) else None
    end_lng = _to_float(end_ll[1]) if isinstance(end_ll, (list, tuple)) else None

    def _to_int(val: Any) -> Optional[int]:
        try:
            if val is None:
                return None
            return int(val)
        except Exception:
            return None

    distance = _to_float(detail.get("distance"))
    moving_time = _to_int(detail.get("moving_time"))
    elapsed_time = _to_int(detail.get("elapsed_time"))
    elev_gain = _to_float(detail.get("total_elevation_gain"))
    avg_cadence = _to_float(detail.get("average_cadence"))

    avg_pace = None
    try:
        if distance and moving_time and distance > 0:
            avg_pace = float(moving_time) / (distance / 1000.0)
    except Exception:
        avg_pace = None

    hide_from_home_val = detail.get("hide_from_home")
    commute_val = detail.get("commute")
    workout_type_val = detail.get("workout_type")

    now_iso = datetime.now(timezone.utc).isoformat()
    base_assignments = ["updated_at = :now", "raw_json = :raw_json", "detail_json = :detail_json"]
    base_assignment_set = set(base_assignments)
    sets: list[str] = list(base_assignments)
    params: Dict[str, Any] = {
        "id": activity_id,
        "now": now_iso,
        "raw_json": _canonical_json(detail),
        "detail_json": _canonical_json(detail),
    }

    def _assign(column: str, value: Any, *, boolean: bool = False) -> None:
        if value is None:
            return
        key = column
        if boolean:
            params[key] = 1 if bool(value) else 0
        else:
            params[key] = value
        sets.append(f"{column} = :{key}")

    _assign("start_date", detail.get("start_date"))
    _assign("start_date_local", detail.get("start_date_local"))
    _assign("start_lat", start_lat)
    _assign("start_lng", start_lng)
    _assign("end_lat", end_lat)
    _assign("end_lng", end_lng)
    _assign("sport_type", detail.get("sport_type"))
    _assign("name", detail.get("name"))
    _assign("distance", distance)
    _assign("moving_time", moving_time)
    _assign("elapsed_time", elapsed_time)
    _assign("total_elevation_gain", elev_gain)
    _assign("gear_id", detail.get("gear_id"))
    _assign("commute", commute_val, boolean=True)
    _assign("workout_type", workout_type_val)
    _assign("hide_from_home", hide_from_home_val, boolean=True)
    _assign("avg_cadence", avg_cadence)
    _assign("avg_pace_s_per_km", avg_pace)

    update_sql = "UPDATE activities SET " + ", ".join(sets) + " WHERE id = :id"
    with engine.begin() as conn:
        conn.execute(sql_text(update_sql), params)

    changed_assignments = [s for s in sets if s not in base_assignment_set]
    changed = bool(changed_assignments)
    if changed:
        message = "Activity refreshed from Strava"
    else:
        message = "Strava detail fetched (no field changes)"

    return {
        "updated": changed,
        "activity_id": activity_id,
        "message": message,
        "applied_fields": [s.split(" = ")[0] for s in changed_assignments],
    }


def start_scheduler(engine: Optional[Engine] = None) -> AsyncIOScheduler:
    """Create and start the AsyncIOScheduler for polling with adaptive cadence."""

    eng = engine or get_engine()
    # Environment variable remains the fallback/default interval when no historical data exists.
    default_interval = int(os.getenv("POLLING_INTERVAL_SEC", "120"))
    default_interval = max(
        _MIN_POLL_INTERVAL, min(_MAX_POLL_INTERVAL, default_interval)
    )
    scheduler = AsyncIOScheduler()

    profile = _load_polling_profile()
    if not profile:
        profile = _compute_polling_profile(eng, default_interval=default_interval)

    state: Dict[str, Any] = {
        "no_token_count": 0,
        "last_run_ts": 0.0,
        "skip_runs": 0,
        "profile": profile,
        "default_interval": default_interval,
    }

    async def job_wrapper() -> None:
        now_epoch = time.time()
        prof = state.get("profile") or {}
        valid_until = int(prof.get("valid_until") or 0)
        if not prof or now_epoch >= valid_until:
            prof = _compute_polling_profile(
                eng, default_interval=state["default_interval"]
            )
            state["profile"] = prof
        intervals = prof.get("intervals") or {}
        minute = _minute_of_day_from_epoch(now_epoch)
        desired = intervals.get(minute)
        if desired is None:
            desired = intervals.get(str(minute), state["default_interval"])
        desired = int(desired or state["default_interval"])

        last_run = float(state.get("last_run_ts") or 0.0)
        since_last = now_epoch - last_run if last_run else None

        def _persist_schedule(next_epoch: float) -> None:
            try:
                set_setting("scheduler_current_interval_sec", str(int(desired)))
                set_setting("scheduler_next_run_epoch", str(int(max(0, next_epoch))))
            except Exception:
                pass

        if last_run:
            _persist_schedule(last_run + desired)
        else:
            _persist_schedule(now_epoch)

        if (
            last_run
            and since_last is not None
            and since_last < max(desired - 1, _MIN_POLL_INTERVAL / 2)
        ):
            state["skip_runs"] = state.get("skip_runs", 0) + 1
            if state["skip_runs"] % 5 == 0:
                log.debug(
                    "Skipping ingest; desired interval=%ss, last run %.1fs ago",
                    desired,
                    since_last,
                )
            return

        state["skip_runs"] = 0
        state["last_run_ts"] = now_epoch

        try:
            inserted, updated, after = await _ingest_activities(eng)
            # Track whether we are currently connected
            if after is None:
                state["no_token_count"] += 1
                if state["no_token_count"] % 10 == 1:
                    log.info(
                        "Scheduler: no Strava tokens found; waiting for OAuth connect"
                    )
            else:
                state["no_token_count"] = 0
        except Exception as e:  # noqa: BLE001
            # Never crash the scheduler on transient errors
            log.exception("Scheduler run failed: %s", e)
        finally:
            finish = time.time()
            state["last_run_ts"] = finish
            _persist_schedule(finish + desired)

    scheduler.add_job(
        job_wrapper,
        "interval",
        seconds=_MIN_POLL_INTERVAL,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    log.info(
        "Scheduler started (base=%ss, default=%ss)",
        _MIN_POLL_INTERVAL,
        default_interval,
    )
    return scheduler


# ---------------- Automation helpers (minimal, in-sync with frontend) -------


def _conditions_match(
    conditions: List[Dict[str, Any]], activity: Dict[str, Any]
) -> bool:
    def compare_num(actual: Optional[float], op: str, target: Any) -> bool:
        try:
            a = float(actual or 0)
            t = float(target)
        except Exception:
            return False
        if op == "gt":
            return a > t
        if op == "ge":
            return a >= t
        if op == "lt":
            return a < t
        if op == "le":
            return a <= t
        if op == "eq":
            return a == t
        return False

    for c in conditions:
        ctype = c.get("type")
        op = c.get("op")
        val = c.get("value")
        if ctype == "sport_type":
            if op == "equals" and (activity.get("sport_type") or "") != str(val):
                return False
        elif ctype == "day_of_week":
            # Accept array of short names (Mon..Sun) or numbers (0=Mon..6=Sun Python semantics)
            raw = val if isinstance(val, list) else [val]
            tokens = [str(x).strip() for x in raw if str(x).strip()]
            src = activity.get("start_date_local") or activity.get("start_date")
            if not src:
                return False
            try:
                dt = _parse_iso8601(str(src))
                py_day = dt.weekday()  # 0=Mon..6=Sun
                names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                day_ok = False
                for t in tokens:
                    if t.isdigit():
                        if int(t) == py_day:
                            day_ok = True
                            break
                    else:
                        if names[py_day].lower().startswith(t.lower()):
                            day_ok = True
                            break
                if op == "in":
                    if not day_ok:
                        return False
                elif op == "not_in":
                    if day_ok:
                        return False
            except Exception:
                return False
        elif ctype == "distance":
            if not compare_num(activity.get("distance"), op, val):
                return False
        elif ctype in ("start_near", "end_near"):
            # value: { lat, lon, radius_m }
            try:
                tgt_lat = float(val.get("lat"))
                tgt_lng = float(val.get("lon"))
                radius = float(val.get("radius_m", 100.0))
            except Exception:
                return False
            lat = (
                activity.get("start_lat")
                if ctype == "start_near"
                else activity.get("end_lat")
            )
            lng = (
                activity.get("start_lng")
                if ctype == "start_near"
                else activity.get("end_lng")
            )
            if lat is None or lng is None:
                return False
            if op != "within":
                return False
            if _haversine_m(float(lat), float(lng), tgt_lat, tgt_lng) > radius:
                return False
        elif ctype == "moving_time":
            if not compare_num(activity.get("moving_time"), op, val):
                return False
        elif ctype == "moving_pace":
            # seconds per km, using moving_time and distance (m)
            try:
                mt = float(activity.get("moving_time") or 0)
                dist_m = float(activity.get("distance") or 0)
                pace = mt / (dist_m / 1000.0) if dist_m > 0 else None
            except Exception:
                pace = None
            if pace is None:
                return False
            if not compare_num(pace, op, val):
                return False
        elif ctype == "total_elevation_gain":
            if not compare_num(activity.get("total_elevation_gain"), op, val):
                return False
        elif ctype == "title":
            if (
                op == "contains"
                and str(val).lower() not in str(activity.get("name") or "").lower()
            ):
                return False
        elif ctype in ("nearby_activity", "adjacent_activity"):
            # value: { minutes: int, sport_type?: str }
            try:
                window_min = int((val or {}).get("minutes", 15))
            except Exception:
                window_min = 15
            if window_min <= 0:
                return False
            # Determine reference timestamp from activity start_date (prefer UTC)
            src = activity.get("start_date") or activity.get("start_date_local")
            if not src:
                return False
            try:
                ref_dt = _parse_iso8601(str(src))
            except Exception:
                return False
            lo = ref_dt.timestamp() - window_min * 60
            hi = ref_dt.timestamp() + window_min * 60
            # Build time bounds depending on op
            conds: list[str] = ["id <> :id"]
            params: Dict[str, Any] = {"id": int(activity.get("id") or 0)}
            if op == "before":
                conds.append("start_date >= :lo_iso")
                conds.append("start_date <= :ref_iso")
            elif op == "after":
                conds.append("start_date >= :ref_iso")
                conds.append("start_date <= :hi_iso")
            else:
                # Unknown op
                return False
            from datetime import datetime, timezone

            lo_iso = datetime.fromtimestamp(lo, tz=timezone.utc).isoformat()
            ref_iso = ref_dt.astimezone(timezone.utc).isoformat()
            hi_iso = datetime.fromtimestamp(hi, tz=timezone.utc).isoformat()
            params.update({"lo_iso": lo_iso, "ref_iso": ref_iso, "hi_iso": hi_iso})
            st = (val or {}).get("sport_type")
            if st:
                conds.append("sport_type = :st")
                params["st"] = str(st)
            where = " AND ".join(conds)
            # Query existence of any activity within the window
            try:
                from .db import get_engine as _get_engine

                eng = _get_engine()
                with eng.connect() as conn:
                    q = f"SELECT id FROM activities WHERE {where} ORDER BY start_date LIMIT 1"
                    row = conn.execute(sql_text(q), params).fetchone()
                if not row:
                    return False
            except Exception:
                return False
        else:
            # Unknown condition: ignore (non-blocking)
            continue
    return True


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters between two lat/lon points."""
    from math import radians, cos, sin, asin, sqrt

    R = 6371000.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    c = 2 * asin(sqrt(a))
    return R * c


def _apply_effects(
    effects: List[Dict[str, Any]],
    name: Optional[str],
    sport_type: Optional[str],
    commute: Optional[bool],
    workout_type: Optional[int],
) -> Tuple[Optional[str], Optional[str], Optional[bool], Optional[int], Optional[str]]:
    new_name = name or ""
    new_sport = sport_type
    new_commute = commute
    new_workout = workout_type
    new_gear: Optional[str] = None
    for e in effects:
        et = e.get("type")
        p = e.get("params") or {}
        if et == "set_title_suffix":
            suffix = str(p.get("suffix", ""))
            if suffix and not new_name.endswith(suffix):
                new_name = f"{new_name}{suffix}"
        elif et == "set_title_prefix":
            prefix = str(p.get("prefix", ""))
            if prefix and not new_name.startswith(prefix):
                new_name = f"{prefix}{new_name}"
        elif et == "set_commute":
            v = p.get("commute", True)
            new_commute = bool(v)
        elif et == "set_sport_type":
            st = p.get("sport_type")
            if st:
                new_sport = str(st)
        elif et == "set_long_run_tag":
            # Strava workout_type=2 denotes Long Run for running activities
            new_workout = 2
        elif et == "set_shoes_by_id":
            gid = p.get("gear_id")
            if gid:
                new_gear = str(gid)
        elif et == "set_title_template":
            tpl = p.get("template")
            if isinstance(tpl, str) and tpl:
                new_name = tpl
    return new_name, new_sport, new_commute, new_workout, new_gear


import re

_COUNT_RE = re.compile(r"\{count:([A-Za-z0-9_\-]+)\}")


def _render_title_with_counters(name: Optional[str]) -> Optional[str]:
    if not name:
        return name

    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        try:
            return str(inc_counter(key))
        except Exception:
            return "0"

    return _COUNT_RE.sub(repl, name)


def _template_already_applied(current: str, template: str) -> bool:
    """Return True if current already looks like a rendered version of template.

    We treat everything outside the first {count:...} token as literal prefix/suffix and
    check if current matches prefix + number + suffix.
    """
    try:
        start = template.index("{count:")
        end = template.index("}", start)
    except ValueError:
        return False
    prefix = template[:start]
    suffix = template[end + 1 :]
    # Build a tolerant regex allowing optional spaces around the number
    pat = re.compile(r"^" + re.escape(prefix) + r"\s*\d+\s*" + re.escape(suffix) + r"$")
    return bool(pat.match(current or ""))


async def _sync_gear(engine: Engine, client: StravaClient) -> None:
    data = await client.get_athlete_gear()
    shoes = data.get("shoes") or []
    if not shoes:
        return
    now = datetime.now(timezone.utc).isoformat()
    with engine.begin() as conn:
        for s in shoes:
            try:
                params = {
                    "id": str(s.get("id")),
                    "name": str(s.get("name", "")),
                    "type": "shoe",
                    "is_primary": 1 if s.get("primary") else 0,
                    "distance": (
                        float(s.get("distance"))
                        if s.get("distance") is not None
                        else None
                    ),
                    "now": now,
                }
            except Exception:
                continue
            # Upsert: UPDATE then INSERT if missing
            res = conn.execute(
                sql_text(
                    """
                    UPDATE gear SET name=:name, type=:type, is_primary=:is_primary, distance=:distance, updated_at=:now
                    WHERE id=:id
                    """
                ),
                params,
            )
            if getattr(res, "rowcount", 0) == 0:
                conn.execute(
                    sql_text(
                        """
                        INSERT INTO gear (id, name, type, is_primary, distance, created_at, updated_at)
                        VALUES (:id, :name, :type, :is_primary, :distance, :now, :now)
                        """
                    ),
                    params,
                )
