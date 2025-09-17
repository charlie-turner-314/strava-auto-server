import os
import tempfile
import unittest
from datetime import datetime, timezone

from sqlalchemy import text as sql_text

os.environ['DISABLE_SCHEDULER'] = '0'  # allow testing scheduler branch

from fastapi.testclient import TestClient  # type: ignore


class TestMainEndpoints(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        os.environ['APP_ENV'] = 'prod'
        # Fresh import
        from api import db  # type: ignore
        db._engine = None  # type: ignore[attr-defined]

        import importlib
        import api.main as main  # type: ignore
        main = importlib.reload(main)
        # Monkeypatch start_scheduler after reload, before client enters lifespan
        def fake_start_scheduler(_engine):
            raise RuntimeError('boom')
        main.start_scheduler = fake_start_scheduler  # type: ignore[attr-defined]
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.main = main

    def tearDown(self):
        try:
            self.client.__exit__(None, None, None)
        finally:
            self.client.close()
            self.tmpdir.cleanup()

    def test_root_and_healthz(self):
        r = self.client.get('/')
        self.assertEqual(r.status_code, 200)
        self.assertIn('message', r.json())

        # Health success
        r = self.client.get('/healthz')
        self.assertEqual(r.status_code, 200)
        self.assertIn('db', r.json())

        # Force health DB error path by monkeypatching engine.connect
        class BadConn:
            def __enter__(self):
                raise RuntimeError('db down')
            def __exit__(self, exc_type, exc, tb):
                return False
        class BadEngine:
            def connect(self):
                return BadConn()
        old_engine = self.main.engine
        try:
            self.main.engine = BadEngine()  # type: ignore
            r = self.client.get('/healthz')
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['db']['ok'], False)
        finally:
            self.main.engine = old_engine

    def test_strava_auth_endpoints(self):
        # init returns URL with client_id and redirect
        os.environ['STRAVA_CLIENT_ID'] = '12345'
        os.environ['STRAVA_REDIRECT_URI'] = 'http://example/cb'
        # Rebuild client to pick up env; direct call to function to avoid reload
        r = self.client.get('/api/auth/strava/init')
        self.assertEqual(r.status_code, 200)
        url = r.json()['auth_url']
        self.assertIn('client_id=12345', url)
        self.assertIn('redirect_uri=http%3A%2F%2Fexample%2Fcb', url)

        # status when no tokens
        r = self.client.get('/api/auth/strava/status')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['connected'], False)

        # callback missing code -> 400
        r = self.client.get('/api/auth/strava/callback')
        self.assertEqual(r.status_code, 400)

        # callback success with monkeypatch exchange
        import types
        class DummyTok:
            athlete_id = 42
        async def fake_exchange(self, code: str):  # type: ignore[no-redef]
            return DummyTok()
        # Patch StravaClient.exchange_code_for_token on the instance created in endpoint
        # We cannot easily inject instance; instead monkeypatch the class method
        orig_exchange = self.main.StravaClient.exchange_code_for_token
        try:
            self.main.StravaClient.exchange_code_for_token = fake_exchange  # type: ignore[attr-defined]
            r = self.client.get('/api/auth/strava/callback?code=abc')
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['athlete_id'], 42)
        finally:
            self.main.StravaClient.exchange_code_for_token = orig_exchange  # type: ignore[attr-defined]

    def test_polling_profile_endpoint(self):
        now = datetime.now(timezone.utc)
        with self.main.engine.begin() as conn:
            conn.execute(sql_text("DELETE FROM activities"))
            conn.execute(
                sql_text(
                    """
                    INSERT INTO activities (id, start_date, start_date_local, elapsed_time, raw_json, updated_at)
                    VALUES (:id, :sd, :sdl, :elapsed, :raw, :updated)
                    """
                ),
                {
                    "id": 1,
                    "sd": now.isoformat(),
                    "sdl": now.astimezone().isoformat(),
                    "elapsed": 120,
                    "raw": "{}",
                    "updated": datetime.now(timezone.utc).isoformat(),
                },
            )

        # Force computation so polling profile is populated
        from api import scheduler as _scheduler  # type: ignore

        _scheduler._compute_polling_profile(self.main.engine, default_interval=300)

        r = self.client.get('/api/admin/polling_profile')
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(len(data['intervals']), 1440)
        self.assertEqual(data['total_samples'], 1)
        self.assertIn('fallback', data)
