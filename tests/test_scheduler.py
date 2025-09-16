import os
import tempfile
import time
import unittest
import asyncio

from api import db  # type: ignore
from sqlalchemy import text as sql_text
from api import scheduler  # type: ignore


class FakeStravaClient:
    def __init__(self, engine):
        self.engine = engine
        self._name_variant = 'A'

    async def refresh_token_if_needed(self):
        return None

    async def get_athlete_activities(self, after=None):
        # Two activities, deterministic
        base_name = 'Act' + self._name_variant
        return [
            {
                'id': 101,
                'start_date': '2023-01-02T10:00:00Z',
                'start_date_local': '2023-01-02T11:00:00Z',
                'sport_type': 'Run',
                'name': base_name,
                'distance': 2000.0,
                'moving_time': 800,
                'elapsed_time': 820,
                'total_elevation_gain': 20.0,
            },
            {
                'id': 102,
                'start_date': '2023-01-03T10:00:00Z',
                'start_date_local': '2023-01-03T11:00:00Z',
                'sport_type': 'Ride',
                'name': base_name,
                'distance': 3000.0,
                'moving_time': 900,
                'elapsed_time': 920,
                'total_elevation_gain': 30.0,
            },
        ]


class TestSchedulerIngest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        db._engine = None  # type: ignore[attr-defined]
        self.engine = db.get_engine()
        db.ensure_schema()
        # Put a token so scheduler runs
        with self.engine.begin() as conn:
            conn.execute(sql_text(
                "INSERT INTO oauth_tokens(provider, access_token, refresh_token, expires_at) VALUES('strava', 'at', 'rt', :e)"
            ), {"e": int(time.time()) + 3600})

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_ingest_updates_db(self):
        # Patch StravaClient used inside scheduler
        orig = scheduler.StravaClient
        scheduler.StravaClient = FakeStravaClient  # type: ignore[assignment]
        try:
            inserted, updated, max_seen = asyncio.run(scheduler._ingest_activities(self.engine))
            self.assertEqual(inserted, 2)
            self.assertEqual(updated, 0)
            self.assertIsInstance(max_seen, int)

            # Run again with same data -> idempotent
            inserted2, updated2, _ = asyncio.run(scheduler._ingest_activities(self.engine))
            self.assertEqual(inserted2, 0)
            self.assertEqual(updated2, 0)
        finally:
            scheduler.StravaClient = orig  # restore

    def test_ingest_no_token_returns_none(self):
        # Ensure no tokens set
        with self.engine.begin() as conn:
            conn.execute(sql_text("DELETE FROM oauth_tokens"))
        inserted, updated, after = asyncio.run(scheduler._ingest_activities(self.engine))
        self.assertEqual(inserted, 0)
        self.assertEqual(updated, 0)
        self.assertIsNone(after)

    def test_start_scheduler_and_shutdown(self):
        async def run():
            s = scheduler.start_scheduler(self.engine)
            # Should have jobs scheduled
            assert len(s.get_jobs()) >= 1
            s.shutdown(wait=False)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
