"""
Minimal DB helpers for shared engine and schema.

Acceptance checks in repo request:
- ensure_schema creates automations, oauth_tokens, activities, settings tables.
- get_engine reads DATABASE_URL.

Nice-to-have added: get_setting/set_setting for scheduler cursor.
"""

from __future__ import annotations

import os
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, List, Tuple

from sqlalchemy import create_engine, text as sql_text
from sqlalchemy.engine import Engine

log = logging.getLogger("strava-auto-server.db")

_engine: Optional[Engine] = None


def get_engine() -> Engine:
    """Return a process-wide shared SQLAlchemy Engine.

    Uses env var `DATABASE_URL`.
    """
    global _engine
    if _engine is None:
        database_url = os.getenv("DATABASE_URL", "sqlite:////data/app.db")
        # Ensure /data exists for the default sqlite path
        if database_url.startswith("sqlite:////data"):
            os.makedirs("data", exist_ok=True)
        connect_args = (
            {"check_same_thread": False} if database_url.startswith("sqlite") else {}
        )
        _engine = create_engine(database_url, future=True, connect_args=connect_args)
        log.info("DB engine initialized: %s", database_url)
    return _engine


def ensure_schema() -> None:
    """Create required tables if missing.

    Tables:
    - automations (kept compatible with existing code)
    - oauth_tokens (single-row by provider for this MVP)
    - activities (denormalized columns + raw_json)
    - settings (key/value)
    """
    ddl_automations = """
    CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        conditions_json TEXT NOT NULL,
        effects_json TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
    );
    """

    ddl_oauth_tokens = """
    CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        athlete_id INTEGER,
        created_at TIMESTAMP,
        updated_at TIMESTAMP
    );
    """

    ddl_activities = """
    CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY,
        start_date TEXT,
        start_date_local TEXT,
        start_lat REAL,
        start_lng REAL,
        end_lat REAL,
        end_lng REAL,
        sport_type TEXT,
        name TEXT,
        distance REAL,
        moving_time INTEGER,
        elapsed_time INTEGER,
        total_elevation_gain REAL,
        -- Optional fields (added later via ALTER if missing)
        commute INTEGER,
        workout_type INTEGER,
        hide_from_home INTEGER,
        detail_json TEXT,
        raw_json TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL
    );
    """

    ddl_settings = """
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """

    ddl_automation_runs = """
    CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        activity_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        automation_ids TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMP NOT NULL
    );
    """

    ddl_geocode_cache = """
    CREATE TABLE IF NOT EXISTS geocode_cache (
        query TEXT PRIMARY KEY,
        results_json TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL
    );
    """

    ddl_gear = """
    CREATE TABLE IF NOT EXISTS gear (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        is_primary INTEGER,
        distance REAL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
    );
    """

    ddl_laps = """
    CREATE TABLE IF NOT EXISTS laps (
        activity_id INTEGER NOT NULL,
        lap_index INTEGER NOT NULL,
        name TEXT,
        start_date TEXT,
        elapsed_time INTEGER,
        moving_time INTEGER,
        distance REAL,
        avg_cadence REAL,
        avg_heartrate REAL,
        PRIMARY KEY (activity_id, lap_index)
    );
    """

    ddl_strava_req_log = """
    CREATE TABLE IF NOT EXISTS strava_request_log (
        ts INTEGER NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        usage_min INTEGER,
        usage_day INTEGER,
        limit_min INTEGER,
        limit_day INTEGER,
        retry_after INTEGER
    );
    """

    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(sql_text(ddl_automations))
        conn.execute(sql_text(ddl_oauth_tokens))
        conn.execute(sql_text(ddl_activities))
        conn.execute(sql_text(ddl_settings))
        conn.execute(sql_text(ddl_automation_runs))
        conn.execute(sql_text(ddl_geocode_cache))
        conn.execute(sql_text(ddl_gear))
        conn.execute(sql_text(ddl_laps))
        conn.execute(sql_text(ddl_strava_req_log))
        # Lightweight index to speed up ordering by start_date
        conn.execute(
            sql_text(
                "CREATE INDEX IF NOT EXISTS idx_activities_start_date ON activities(start_date)"
            )
        )
        conn.execute(
            sql_text(
                "CREATE INDEX IF NOT EXISTS idx_runs_activity ON automation_runs(activity_id)"
            )
        )
        conn.execute(
            sql_text("CREATE INDEX IF NOT EXISTS idx_req_ts ON strava_request_log(ts)")
        )
        # Best-effort ensure new columns exist when upgrading an existing DB
        try:
            cols = conn.execute(sql_text("PRAGMA table_info(activities)")).fetchall()
            existing = {str(r[1]) for r in cols}  # r[1] is name
            if "start_lat" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN start_lat REAL")
                )
            if "start_lng" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN start_lng REAL")
                )
            if "end_lat" not in existing:
                conn.execute(sql_text("ALTER TABLE activities ADD COLUMN end_lat REAL"))
            if "end_lng" not in existing:
                conn.execute(sql_text("ALTER TABLE activities ADD COLUMN end_lng REAL"))
            if "commute" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN commute INTEGER")
                )
            if "workout_type" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN workout_type INTEGER")
                )
            if "gear_id" not in existing:
                conn.execute(sql_text("ALTER TABLE activities ADD COLUMN gear_id TEXT"))
            if "avg_cadence" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN avg_cadence REAL")
                )
            if "avg_pace_s_per_km" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN avg_pace_s_per_km REAL")
                )
            if "hide_from_home" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN hide_from_home INTEGER")
                )
            if "detail_json" not in existing:
                conn.execute(
                    sql_text("ALTER TABLE activities ADD COLUMN detail_json TEXT")
                )
        except Exception:
            # On non-SQLite backends, PRAGMA may fail; ignore as these are optional fields
            pass
    log.info("DB schema ensured (automations, oauth_tokens, activities, settings)")


def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    """Fetch a setting value or default if not set."""
    eng = get_engine()
    with eng.connect() as conn:
        row = conn.execute(
            sql_text("SELECT value FROM settings WHERE key = :k"), {"k": key}
        ).fetchone()
        if row is None:
            return default
        return str(row.value)


def set_setting(key: str, value: str) -> None:
    """Insert or update a setting value."""
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(
            sql_text(
                """
                INSERT INTO settings (key, value)
                VALUES (:k, :v)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """
            ),
            {"k": key, "v": value},
        )
        # Touch updated_at in case future schema adds it (no-op today)
    log.debug("Setting saved: %s=%s", key, value)


def set_cooldown_until(epoch_s: int) -> None:
    set_setting("strava_cooldown_until", str(int(epoch_s)))


def set_cooldown(
    epoch_s: int, *, reason: str | None = None, scope: str | None = None
) -> None:
    """Set cooldown with optional reason/scope metadata.

    Stores in settings:
    - strava_cooldown_until (int epoch seconds)
    - strava_cooldown_reason (str)
    - strava_cooldown_scope (str)
    - strava_cooldown_set_at (int epoch seconds)
    """
    set_cooldown_until(epoch_s)
    try:
        from datetime import datetime, timezone

        now = int(datetime.now(timezone.utc).timestamp())
    except Exception:
        now = 0
    if reason is not None:
        set_setting("strava_cooldown_reason", str(reason))
    if scope is not None:
        set_setting("strava_cooldown_scope", str(scope))
    set_setting("strava_cooldown_set_at", str(int(now)))


def get_cooldown_until() -> int:
    val = get_setting("strava_cooldown_until", "0")
    try:
        return int(val or 0)
    except Exception:
        return 0


def get_cooldown_detail() -> Dict[str, int | str]:
    """Return cooldown details: until, reason, scope, set_at."""
    until = get_cooldown_until()
    reason = get_setting("strava_cooldown_reason", "") or ""
    scope = get_setting("strava_cooldown_scope", "") or ""
    set_at_raw = get_setting("strava_cooldown_set_at", "0")
    try:
        set_at = int(set_at_raw or 0)
    except Exception:
        set_at = 0
    return {"until": until, "reason": reason, "scope": scope, "set_at": set_at}


def log_strava_request(
    *,
    path: str,
    status: int,
    usage_min: int | None,
    usage_day: int | None,
    limit_min: int | None,
    limit_day: int | None,
    retry_after: int | None,
) -> None:
    eng = get_engine()
    ts = int(datetime.now(timezone.utc).timestamp())
    with eng.begin() as conn:
        conn.execute(
            sql_text(
                """
                INSERT INTO strava_request_log (ts, path, status, usage_min, usage_day, limit_min, limit_day, retry_after)
                VALUES (:ts, :path, :status, :um, :ud, :lm, :ld, :ra)
                """
            ),
            {
                "ts": ts,
                "path": path,
                "status": int(status),
                "um": usage_min,
                "ud": usage_day,
                "lm": limit_min,
                "ld": limit_day,
                "ra": retry_after,
            },
        )
        # periodic cleanup: drop entries older than 3 days
        cutoff = ts - 3 * 86400
        conn.execute(
            sql_text("DELETE FROM strava_request_log WHERE ts < :cut"), {"cut": cutoff}
        )


def get_counter(key: str) -> int:
    """Return current integer counter value for key (default 0)."""
    eng = get_engine()
    with eng.connect() as conn:
        row = conn.execute(
            sql_text("SELECT value FROM settings WHERE key = :k"),
            {"k": f"counter:{key}"},
        ).fetchone()
        if not row:
            return 0
        try:
            return int(row.value)
        except Exception:
            return 0


def inc_counter(key: str) -> int:
    """Atomically increment and return the new counter value."""
    eng = get_engine()
    with eng.begin() as conn:
        row = conn.execute(
            sql_text("SELECT value FROM settings WHERE key = :k"),
            {"k": f"counter:{key}"},
        ).fetchone()
        cur = 0
        if row and row.value is not None:
            try:
                cur = int(row.value)
            except Exception:
                cur = 0
        nxt = cur + 1
        conn.execute(
            sql_text(
                """
                INSERT INTO settings(key, value)
                VALUES (:k, :v)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """
            ),
            {"k": f"counter:{key}", "v": str(nxt)},
        )
    return nxt


def set_counter(key: str, value: int) -> int:
    """Set counter value for key and return the stored integer."""
    v = int(value)
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(
            sql_text(
                """
                INSERT INTO settings(key, value)
                VALUES (:k, :v)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """
            ),
            {"k": f"counter:{key}", "v": str(v)},
        )
    return v


def list_counters() -> List[Tuple[str, int]]:
    """Return a list of (key, value) for all counters in settings.

    Keys are returned without the "counter:" prefix for display/API convenience.
    """
    eng = get_engine()
    items: List[Tuple[str, int]] = []
    with eng.connect() as conn:
        rows = conn.execute(
            sql_text(
                "SELECT key, value FROM settings WHERE key LIKE 'counter:%' ORDER BY key ASC"
            )
        ).fetchall()
    for r in rows:
        k: str = str(r.key)
        v_raw = r.value
        try:
            v = int(v_raw) if v_raw is not None else 0
        except Exception:
            v = 0
        # strip prefix
        if k.startswith("counter:"):
            k = k[len("counter:") :]
        items.append((k, v))
    return items


def reset_counter(key: str) -> None:
    """Delete a single counter so it resets to 0."""
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(
            sql_text("DELETE FROM settings WHERE key = :k"), {"k": f"counter:{key}"}
        )


def reset_all_counters() -> int:
    """Delete all counter:* keys. Returns number of rows removed."""
    eng = get_engine()
    with eng.begin() as conn:
        res = conn.execute(sql_text("DELETE FROM settings WHERE key LIKE 'counter:%'"))
        # rowcount may be None on some DBs; coerce to int
        try:
            return int(getattr(res, "rowcount", 0) or 0)
        except Exception:
            return 0
