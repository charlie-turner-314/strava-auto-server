"""Utilities for building and persisting Strava polling cadence profiles."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

from sqlalchemy import text as sql_text
from sqlalchemy.engine import Engine

from .db import get_setting, set_setting

MIN_POLL_INTERVAL = 60
MAX_POLL_INTERVAL = 3000
POLLING_PROFILE_KEY = "scheduler_polling_profile"


def _parse_iso8601(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _minute_of_day_from_str(value: Any, *, offset_seconds: int = 0) -> Optional[int]:
    if not value:
        return None
    try:
        s = str(value)
        if "T" not in s:
            return None
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if offset_seconds:
            dt = dt + timedelta(seconds=int(offset_seconds))
        return int(dt.hour) * 60 + int(dt.minute)
    except Exception:
        return None


def _next_local_midnight_epoch(now_epoch: Optional[float] = None) -> int:
    if now_epoch is None:
        now_epoch = time.time()
    now_dt = datetime.fromtimestamp(now_epoch)
    next_day = now_dt + timedelta(days=1)
    next_midnight = datetime(next_day.year, next_day.month, next_day.day)
    return int(next_midnight.timestamp())


def load_polling_profile() -> Dict[str, Any]:
    raw = get_setting(POLLING_PROFILE_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        intervals = data.get("intervals")
        if isinstance(intervals, dict):
            parsed: Dict[int, int] = {}
            for key, value in intervals.items():
                try:
                    parsed[int(key)] = int(value)
                except Exception:
                    continue
            data["intervals"] = parsed
        else:
            data["intervals"] = {}
        return data
    except Exception:
        return {}


def save_polling_profile(profile: Dict[str, Any]) -> None:
    payload = dict(profile)
    intervals = payload.get("intervals") or {}
    payload["intervals"] = {
        str(key): int(value)
        for key, value in intervals.items()
        if isinstance(key, int)
    }
    set_setting(POLLING_PROFILE_KEY, json.dumps(payload))


def compute_polling_profile(engine: Engine, *, default_interval: int) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)
    counts = [0.0] * 1440
    total = 0.0

    with engine.connect() as conn:
        rows = conn.execute(
            sql_text(
                "SELECT start_date, start_date_local, elapsed_time FROM activities"
            )
        ).fetchall()

    for row in rows:
        start_raw = getattr(row, "start_date", None)
        minute_ref: Optional[int] = None
        dt_utc: Optional[datetime] = None
        if start_raw:
            try:
                dt_utc = _parse_iso8601(str(start_raw))
            except Exception:
                dt_utc = None
        if dt_utc and dt_utc < cutoff:
            continue
        try:
            elapsed_seconds = int(getattr(row, "elapsed_time", 0) or 0)
        except Exception:
            elapsed_seconds = 0
        minute_ref = _minute_of_day_from_str(
            getattr(row, "start_date_local", None), offset_seconds=elapsed_seconds
        )
        if minute_ref is None and dt_utc is not None:
            try:
                dt_end = dt_utc + timedelta(seconds=elapsed_seconds)
                dt_local = dt_end.astimezone()
                minute_ref = int(dt_local.hour) * 60 + int(dt_local.minute)
            except Exception:
                minute_ref = int(dt_utc.astimezone().hour) * 60 + int(
                    dt_utc.astimezone().minute
                )
        if minute_ref is None:
            continue
        idx = max(0, min(1439, minute_ref))
        counts[idx] += 1.0
        total += 1.0

    fallback = max(MIN_POLL_INTERVAL, min(MAX_POLL_INTERVAL, int(default_interval)))

    if total <= 0:
        intervals = {i: fallback for i in range(1440)}
    else:
        smoothed = [0.0] * 1440
        for i in range(1440):
            left = counts[i - 1] if i > 0 else counts[-1]
            right = counts[(i + 1) % 1440]
            smoothed[i] = counts[i] * 0.6 + left * 0.2 + right * 0.2
        counts = smoothed
        peak = max(counts) or 1.0
        intervals: Dict[int, int] = {}
        for minute, value in enumerate(counts):
            ratio = value / peak if peak else 0.0
            interval = int(
                round(
                    MAX_POLL_INTERVAL
                    - (MAX_POLL_INTERVAL - MIN_POLL_INTERVAL) * ratio
                )
            )
            interval = max(MIN_POLL_INTERVAL, min(MAX_POLL_INTERVAL, interval))
            intervals[minute] = interval

    profile = {
        "computed_at": now.isoformat(),
        "valid_until": _next_local_midnight_epoch(),
        "total_samples": int(total),
        "intervals": intervals,
        "fallback": fallback,
    }
    save_polling_profile(profile)
    return profile


__all__ = [
    "MIN_POLL_INTERVAL",
    "MAX_POLL_INTERVAL",
    "POLLING_PROFILE_KEY",
    "compute_polling_profile",
    "load_polling_profile",
    "save_polling_profile",
]
