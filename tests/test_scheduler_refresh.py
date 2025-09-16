import os
import tempfile
import time
import unittest

from sqlalchemy import text as sql_text

from api import db  # type: ignore
from api import scheduler  # type: ignore


class DummyClient:
    def __init__(self, payload):
        self.payload = payload

    async def get_activity_detail(self, activity_id: int):
        return dict(self.payload)


class SchedulerRefreshTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "refresh.db")
        os.environ["DATABASE_URL"] = f"sqlite:///{self.db_path}"
        db._engine = None  # type: ignore[attr-defined]
        self.engine = db.get_engine()
        db.ensure_schema()
        with self.engine.begin() as conn:
            conn.execute(
                sql_text(
                    "INSERT INTO activities (id, start_date, start_date_local, sport_type, name, raw_json, updated_at) VALUES (:id, :sd, :sdl, :sport, :name, :raw, :now)"
                ),
                {
                    "id": 123,
                    "sd": "2024-01-01T10:00:00Z",
                    "sdl": "2024-01-01T21:00:00",
                    "sport": "Run",
                    "name": "Morning",
                    "raw": "{}",
                    "now": "2024-01-01T10:05:00Z",
                },
            )

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    async def test_refresh_activity_detail_updates_fields(self) -> None:
        payload = {
            "id": 123,
            "start_date": "2024-01-01T10:00:00Z",
            "start_date_local": "2024-01-01T21:00:00",
            "start_latlng": [37.0, -122.0],
            "end_latlng": [37.1, -122.1],
            "distance": 5000.0,
            "moving_time": 1600,
            "elapsed_time": 1700,
            "total_elevation_gain": 80.0,
            "average_cadence": 85.5,
            "gear_id": "gear123",
            "commute": True,
            "workout_type": 2,
            "hide_from_home": False,
            "sport_type": "Run",
            "name": "Evening Run",
        }
        client = DummyClient(payload)

        result = await scheduler.refresh_activity_detail(
            self.engine,
            client,  # type: ignore[arg-type]
            123,
            respect_cooldown=False,
        )

        self.assertTrue(result["updated"], result)
        self.assertIn("Activity refreshed", result["message"])

        with self.engine.connect() as conn:
            row = conn.execute(
                sql_text(
                    "SELECT distance, moving_time, commute, gear_id, hide_from_home FROM activities WHERE id = :id"
                ),
                {"id": 123},
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertAlmostEqual(row.distance, 5000.0)
        self.assertEqual(row.moving_time, 1600)
        self.assertEqual(row.commute, 1)
        self.assertEqual(row.gear_id, "gear123")
        self.assertEqual(row.hide_from_home, 0)

    async def test_refresh_respects_cooldown(self) -> None:
        now = int(time.time())
        db.set_cooldown(now + 60, reason="test", scope="read")
        client = DummyClient({})

        result = await scheduler.refresh_activity_detail(
            self.engine,
            client,  # type: ignore[arg-type]
            123,
            respect_cooldown=True,
        )

        self.assertFalse(result["updated"])
        self.assertIn("cooldown", result)


if __name__ == "__main__":
    unittest.main()
