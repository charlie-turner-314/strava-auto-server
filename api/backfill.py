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
from typing import Any

from sqlalchemy import text as sql_text

from .db import get_engine, ensure_schema
from .strava_client import StravaClient
from . import scheduler as _scheduler

log = logging.getLogger("strava-auto-server.backfill")


async def backfill() -> None:
    ensure_schema()
    engine = get_engine()
    client = StravaClient(engine)

    # Sync gear first (lifetime distances)
    try:
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
        try:
            detail = await client.get_activity_detail(aid)
        except Exception as e:  # noqa: BLE001
            log.warning("Detail fetch failed for %s: %s", aid, e)
            await asyncio.sleep(0.2)
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
                      avg_pace_s_per_km = COALESCE(:avg_pace, avg_pace_s_per_km)
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
                },
            )

        # Laps for runs
        if sport in ("run", "trailrun", "virtualrun"):
            try:
                laps = await client.get_activity_laps(aid)
            except Exception as e:  # noqa: BLE001
                log.warning("Laps fetch failed for %s: %s", aid, e)
                await asyncio.sleep(0.2)
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

