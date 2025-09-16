from __future__ import annotations

from datetime import datetime


def human_local_from_epoch(epoch_s: int | float | None) -> str:
    """Return a local-time human readable string for an epoch timestamp.

    Example: 2025-09-16 12:34:56 PDT
    Falls back to the raw value on error or when epoch_s is falsy.
    """
    try:
        if not epoch_s:
            return ""
        ts = int(epoch_s)
        # fromtimestamp -> local time; astimezone() to attach tzinfo and zone name
        dt = datetime.fromtimestamp(ts).astimezone()
        return dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    except Exception:
        return str(epoch_s) if epoch_s is not None else ""

