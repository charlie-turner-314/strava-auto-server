"""
Backfill script to enrich activities with:
- Laps (distance, times, cadence)
- Activity detail (gear_id, avg_cadence, computed avg pace, elevation, start/end lat/lon)
- Gear list (shoes with lifetime distance)

Run: python -m api.backfill
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
from sqlalchemy import text as sql_text

from .db import get_engine, ensure_schema, get_cooldown_detail
from .strava_client import StravaClient
from . import scheduler as _scheduler

log = logging.getLogger("strava-auto-server.backfill")

COOLDOWN_BUFFER_SECONDS = 30
COOLDOWN_TICK_SECONDS = 30


async def _wait_for_cooldown(tag: str) -> None:
    """Poll cooldown state and sleep until it clears, keeping a buffer for the app."""

    while True:
        try:
            detail = get_cooldown_detail()
        except Exception:
            return
        until_raw = detail.get("until") if detail else 0
        try:
            cd_until = int(until_raw or 0)
        except Exception:
            cd_until = 0
        now = int(time.time())
        if not cd_until or now >= cd_until:
            return
        reason = str(detail.get("reason") or "Strava cooldown") if detail else "Strava cooldown"
        scope = str(detail.get("scope") or "") if detail else ""
        wait_core = max(0, cd_until - now)
        total_wait = wait_core + COOLDOWN_BUFFER_SECONDS
        scope_note = f" ({scope})" if scope else ""
        log.info(
            "%s: cooldown active%s (%s); sleeping %.0fs (%.0fs buffer)",
            tag,
            scope_note,
            reason,
            total_wait,
            COOLDOWN_BUFFER_SECONDS,
        )
        end_time = time.time() + total_wait
        while True:
            remaining = end_time - time.time()
            if remaining <= 0:
                break
            await asyncio.sleep(min(remaining, COOLDOWN_TICK_SECONDS))


async def backfill() -> None:
    ensure_schema()
    engine = get_engine()
    client = StravaClient(engine)

    # Sync gear first (lifetime distances)
    try:
        await _wait_for_cooldown("gear sync")
        await _scheduler._sync_gear(engine, client)  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        log.warning("Gear sync failed: %s", e)

    # Iterate activities (only running sports for laps)
    with engine.connect() as conn:
        rows = conn.execute(
            sql_text(
                """
                SELECT id, sport_type FROM activities
                ORDER BY id DESC
                """
            )
        ).fetchall()

    for r in rows:
        aid = int(r.id)
        sport = (r.sport_type or "").lower()
        # Fetch detail
        await _wait_for_cooldown(f"activity {aid} detail")
        try:
            detail = await client.get_activity_detail(aid)
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else None
            if status == 429:
                log.warning("Detail fetch hit Strava 429 for %s; entering cooldown", aid)
            else:
                log.warning("Detail fetch failed for %s: %s", aid, e)
            await _wait_for_cooldown(f"activity {aid} detail after error")
            await asyncio.sleep(0.5)
            continue
        except Exception as e:  # noqa: BLE001
            log.warning("Detail fetch failed for %s: %s", aid, e)
            await asyncio.sleep(0.5)
            continue

        # Extract fields
        start_ll = detail.get("start_latlng") or [None, None]
        end_ll = detail.get("end_latlng") or [None, None]
        start_lat = float(start_ll[0]) if isinstance(start_ll, list) and len(start_ll) >= 2 and start_ll[0] is not None else None
        start_lng = float(start_ll[1]) if isinstance(start_ll, list) and len(start_ll) >= 2 and start_ll[1] is not None else None
        end_lat = float(end_ll[0]) if isinstance(end_ll, list) and len(end_ll) >= 2 and end_ll[0] is not None else None
        end_lng = float(end_ll[1]) if isinstance(end_ll, list) and len(end_ll) >= 2 and end_ll[1] is not None else None
        gear_id = detail.get("gear_id")
        distance = detail.get("distance")
        moving_time = detail.get("moving_time")
        elapsed_time = detail.get("elapsed_time")
        elev_gain = detail.get("total_elevation_gain")
        avg_cadence = detail.get("average_cadence")
        avg_pace = None
        try:
            if distance and moving_time and float(distance) > 0:
                avg_pace = float(moving_time) / (float(distance) / 1000.0)
        except Exception:
            avg_pace = None

        detail_json = _scheduler._canonical_json(detail)

        # Update activities row
        with engine.begin() as conn:
            conn.execute(
                sql_text(
                    """
                    UPDATE activities SET
                      start_lat = COALESCE(:start_lat, start_lat),
                      start_lng = COALESCE(:start_lng, start_lng),
                      end_lat = COALESCE(:end_lat, end_lat),
                      end_lng = COALESCE(:end_lng, end_lng),
                      gear_id = COALESCE(:gear_id, gear_id),
                      distance = COALESCE(:distance, distance),
                      moving_time = COALESCE(:moving_time, moving_time),
                      elapsed_time = COALESCE(:elapsed_time, elapsed_time),
                      total_elevation_gain = COALESCE(:elev, total_elevation_gain),
                      avg_cadence = COALESCE(:avg_cadence, avg_cadence),
                      avg_pace_s_per_km = COALESCE(:avg_pace, avg_pace_s_per_km),
                      detail_json = :detail_json
                    WHERE id = :id
                    """
                ),
                {
                    "id": aid,
                    "start_lat": start_lat,
                    "start_lng": start_lng,
                    "end_lat": end_lat,
                    "end_lng": end_lng,
                    "gear_id": gear_id,
                    "distance": distance,
                    "moving_time": moving_time,
                    "elapsed_time": elapsed_time,
                    "elev": elev_gain,
                    "avg_cadence": avg_cadence,
                    "avg_pace": avg_pace,
                    "detail_json": detail_json,
                },
            )

        # Laps for runs
        if sport in ("run", "trailrun", "virtualrun"):
            try:
                await _wait_for_cooldown(f"activity {aid} laps")
                laps = await client.get_activity_laps(aid)
            except httpx.HTTPStatusError as e:
                status = e.response.status_code if e.response is not None else None
                if status == 429:
                    log.warning("Laps fetch hit Strava 429 for %s; entering cooldown", aid)
                else:
                    log.warning("Laps fetch failed for %s: %s", aid, e)
                await _wait_for_cooldown(f"activity {aid} laps after error")
                await asyncio.sleep(0.5)
                continue
            except Exception as e:  # noqa: BLE001
                log.warning("Laps fetch failed for %s: %s", aid, e)
                await asyncio.sleep(0.5)
                continue
            if laps:
                with engine.begin() as conn:
                    for i, lap in enumerate(laps):
                        li = int(lap.get("lap_index") or i)
                        conn.execute(
                            sql_text(
                                """
                                INSERT INTO laps (activity_id, lap_index, name, start_date, elapsed_time, moving_time, distance, avg_cadence, avg_heartrate)
                                VALUES (:aid, :li, :name, :start_date, :et, :mt, :dist, :cad, :hr)
                                ON CONFLICT(activity_id, lap_index) DO UPDATE SET
                                  name=excluded.name,
                                  start_date=excluded.start_date,
                                  elapsed_time=excluded.elapsed_time,
                                  moving_time=excluded.moving_time,
                                  distance=excluded.distance,
                                  avg_cadence=excluded.avg_cadence,
                                  avg_heartrate=excluded.avg_heartrate
                                """
                            ),
                            {
                                "aid": aid,
                                "li": li,
                                "name": lap.get("name"),
                                "start_date": lap.get("start_date"),
                                "et": lap.get("elapsed_time"),
                                "mt": lap.get("moving_time"),
                                "dist": lap.get("distance"),
                                "cad": lap.get("average_cadence"),
                                "hr": lap.get("average_heartrate"),
                            },
                        )
        await asyncio.sleep(0.2)  # be gentle on API


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(backfill())


if __name__ == "__main__":
    main()
