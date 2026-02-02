import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from sqlalchemy import text as sql_text

from fastapi.testclient import TestClient  # type: ignore


class TestMainEndpoints(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        os.environ['APP_ENV'] = 'prod'
        os.environ['APP_AUTH_SECRET'] = 'test-secret'
        os.environ['STRAVA_CLIENT_ID'] = '12345'
        os.environ['STRAVA_CLIENT_SECRET'] = 'secret'
        os.environ['STRAVA_REDIRECT_URI'] = 'http://example/cb'
        os.environ['STRAVA_WEBHOOK_VERIFY_TOKEN'] = 'test-verify'
        os.environ['STRAVA_WEBHOOK_CALLBACK_URL'] = 'https://example.com/webhooks'
        # Fresh import
        from api import db  # type: ignore
        db._engine = None  # type: ignore[attr-defined]

        import importlib
        import api.main as main  # type: ignore
        main = importlib.reload(main)
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.main = main

    def tearDown(self):
        try:
            self.client.__exit__(None, None, None)
        finally:
            self.client.close()
            self.tmpdir.cleanup()

    def _login_with_strava(self, athlete_id: int = 42) -> None:
        init_resp = self.client.get('/api/auth/strava/init')
        assert init_resp.status_code == 200, init_resp.text
        auth_url = init_resp.json()['auth_url']
        state = parse_qs(urlparse(auth_url).query).get('state', [''])[0]
        assert state, "Missing OAuth state param"

        class DummyTok:
            def __init__(self, aid: int):
                self.athlete_id = aid
                self.scope = "read,activity:read_all"

        async def fake_exchange(self, code: str):  # type: ignore[no-redef]
            now = int(time.time())
            with self.engine.begin() as conn:
                conn.execute(
                    sql_text("DELETE FROM oauth_tokens WHERE provider='strava' AND athlete_id = :aid"),
                    {"aid": int(athlete_id)},
                )
                conn.execute(
                    sql_text(
                        """
                        INSERT INTO oauth_tokens (provider, athlete_id, access_token, refresh_token, expires_at, scope)
                        VALUES ('strava', :aid, :at, :rt, :exp, :sc)
                        """
                    ),
                    {
                        "aid": int(athlete_id),
                        "at": "at",
                        "rt": "rt",
                        "exp": now + 3600,
                        "sc": "read,activity:read_all",
                    },
                )
            return DummyTok(athlete_id), {"id": athlete_id, "firstname": "Test", "lastname": "User", "username": "tester"}

        orig_exchange = self.main.StravaClient.exchange_code_for_token
        try:
            self.main.StravaClient.exchange_code_for_token = fake_exchange  # type: ignore[attr-defined]
            resp = self.client.get(f'/api/auth/strava/callback?code=abc&state={state}')
            assert resp.status_code == 200, resp.text
        finally:
            self.main.StravaClient.exchange_code_for_token = orig_exchange  # type: ignore[attr-defined]

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
        r = self.client.get('/api/auth/strava/init')
        self.assertEqual(r.status_code, 200)
        url = r.json()['auth_url']
        self.assertIn('client_id=12345', url)
        self.assertIn('redirect_uri=http%3A%2F%2Fexample%2Fcb', url)

        # status requires auth
        r = self.client.get('/api/auth/strava/status')
        self.assertEqual(r.status_code, 401)

        # callback missing code -> 400
        r = self.client.get('/api/auth/strava/callback')
        self.assertEqual(r.status_code, 400)

        # callback success with monkeypatch exchange
        state = parse_qs(urlparse(url).query).get('state', [''])[0]
        class DummyTok:
            athlete_id = 42
            scope = "read"
        async def fake_exchange(self, code: str):  # type: ignore[no-redef]
            now = int(time.time())
            with self.engine.begin() as conn:
                conn.execute(
                    sql_text("DELETE FROM oauth_tokens WHERE provider='strava' AND athlete_id = :aid"),
                    {"aid": 42},
                )
                conn.execute(
                    sql_text(
                        """
                        INSERT INTO oauth_tokens (provider, athlete_id, access_token, refresh_token, expires_at, scope)
                        VALUES ('strava', :aid, :at, :rt, :exp, :sc)
                        """
                    ),
                    {"aid": 42, "at": "at", "rt": "rt", "exp": now + 3600, "sc": "read"},
                )
            return DummyTok(), {"id": 42, "firstname": "Test", "lastname": "User", "username": "tester"}
        # Patch StravaClient.exchange_code_for_token on the instance created in endpoint
        # We cannot easily inject instance; instead monkeypatch the class method
        orig_exchange = self.main.StravaClient.exchange_code_for_token
        try:
            self.main.StravaClient.exchange_code_for_token = fake_exchange  # type: ignore[attr-defined]
            r = self.client.get(f'/api/auth/strava/callback?code=abc&state={state}')
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['athlete_id'], 42)
            r = self.client.get('/api/auth/strava/status')
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['connected'], True)
        finally:
            self.main.StravaClient.exchange_code_for_token = orig_exchange  # type: ignore[attr-defined]

    def test_webhook_verify_and_event(self):
        # Verify handshake
        r = self.client.get('/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=abc123')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['hub.challenge'], 'abc123')

        # Invalid token returns 403
        r = self.client.get('/api/webhooks/strava?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123')
        self.assertEqual(r.status_code, 403)

        # Event handler (stub process_webhook_event)
        async def fake_process(_engine, _payload):  # type: ignore[no-redef]
            return {"handled": True}
        orig = self.main._scheduler.process_webhook_event
        try:
            self.main._scheduler.process_webhook_event = fake_process  # type: ignore[attr-defined]
            payload = {
                "aspect_type": "create",
                "event_time": int(datetime.now(timezone.utc).timestamp()),
                "object_id": 123,
                "object_type": "activity",
                "owner_id": 1,
                "subscription_id": 99,
                "updates": {},
            }
            r = self.client.post('/api/webhooks/strava', json=payload)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()['status'], 'processed')
        finally:
            self.main._scheduler.process_webhook_event = orig  # type: ignore[attr-defined]

    def test_get_shoe_stats(self):
        now = datetime.now(timezone.utc)
        with self.main.engine.begin() as conn:
            conn.execute(sql_text("DELETE FROM activities"))
            conn.execute(sql_text("DELETE FROM gear"))
            conn.execute(
                sql_text(
                    """
                    INSERT INTO gear (id, athlete_id, name, type, is_primary, distance, created_at, updated_at)
                    VALUES (:id, :aid, :name, :type, :is_primary, :distance, :created, :updated)
                    """
                ),
                {
                    "id": "shoe-1",
                    "aid": 42,
                    "name": "Tempo Next",
                    "type": "shoe",
                    "is_primary": 1,
                    "distance": 90000.0,
                    "created": now.isoformat(),
                    "updated": now.isoformat(),
                },
            )
            conn.execute(
                sql_text(
                    """
                    INSERT INTO gear (id, athlete_id, name, type, is_primary, distance, created_at, updated_at)
                    VALUES (:id, :aid, :name, :type, :is_primary, :distance, :created, :updated)
                    """
                ),
                {
                    "id": "shoe-2",
                    "aid": 42,
                    "name": "Daily Trainer",
                    "type": "shoe",
                    "is_primary": 0,
                    "distance": 12000.0,
                    "created": now.isoformat(),
                    "updated": now.isoformat(),
                },
            )
            conn.execute(
                sql_text(
                    """
                    INSERT INTO activities (
                        id, athlete_id, start_date, start_date_local, sport_type, name,
                        distance, moving_time, elapsed_time, total_elevation_gain,
                        avg_cadence, raw_json, updated_at, gear_id
                    )
                    VALUES (:id, :aid, :start_date, :start_date_local, :sport_type, :name,
                            :distance, :moving_time, :elapsed_time, :gain,
                            :avg_cadence, :raw_json, :updated_at, :gear_id)
                    """
                ),
                {
                    "id": 101,
                    "aid": 42,
                    "start_date": now.isoformat(),
                    "start_date_local": now.isoformat(),
                    "sport_type": "Run",
                    "name": "Long Run",
                    "distance": 10000.0,
                    "moving_time": 3600,
                    "elapsed_time": 3660,
                    "gain": 120.0,
                    "avg_cadence": 80.0,
                    "raw_json": "{}",
                    "updated_at": now.isoformat(),
                    "gear_id": "shoe-1",
                },
            )
            conn.execute(
                sql_text(
                    """
                    INSERT INTO activities (
                        id, athlete_id, start_date, start_date_local, sport_type, name,
                        distance, moving_time, elapsed_time, total_elevation_gain,
                        avg_cadence, raw_json, updated_at, gear_id
                    )
                    VALUES (:id, :aid, :start_date, :start_date_local, :sport_type, :name,
                            :distance, :moving_time, :elapsed_time, :gain,
                            :avg_cadence, :raw_json, :updated_at, :gear_id)
                    """
                ),
                {
                    "id": 102,
                    "aid": 42,
                    "start_date": now.isoformat(),
                    "start_date_local": now.isoformat(),
                    "sport_type": "Run",
                    "name": "Tempo",
                    "distance": 5000.0,
                    "moving_time": 1500,
                    "elapsed_time": 1520,
                    "gain": 40.0,
                    "avg_cadence": 90.0,
                    "raw_json": "{}",
                    "updated_at": now.isoformat(),
                    "gear_id": "shoe-1",
                },
            )
            conn.execute(
                sql_text(
                    """
                    INSERT INTO activities (
                        id, athlete_id, start_date, start_date_local, sport_type, name,
                        distance, moving_time, elapsed_time, total_elevation_gain,
                        avg_cadence, raw_json, updated_at, gear_id
                    )
                    VALUES (:id, :aid, :start_date, :start_date_local, :sport_type, :name,
                            :distance, :moving_time, :elapsed_time, :gain,
                            :avg_cadence, :raw_json, :updated_at, :gear_id)
                    """
                ),
                {
                    "id": 103,
                    "aid": 42,
                    "start_date": now.isoformat(),
                    "start_date_local": now.isoformat(),
                    "sport_type": "Run",
                    "name": "Recovery",
                    "distance": 8000.0,
                    "moving_time": 2400,
                    "elapsed_time": 2420,
                    "gain": 30.0,
                    "avg_cadence": 82.0,
                    "raw_json": "{}",
                    "updated_at": now.isoformat(),
                    "gear_id": "shoe-2",
                },
            )

        self._login_with_strava()
        response = self.client.get('/api/gear/shoes')
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn('items', payload)
        shoes = {item['gear_id']: item for item in payload['items']}
        self.assertIn('shoe-1', shoes)
        self.assertIn('shoe-2', shoes)

        first = shoes['shoe-1']
        self.assertEqual(first['activity_count'], 2)
        self.assertAlmostEqual(first['total_distance'], 15000.0, places=3)
        self.assertAlmostEqual(first['total_moving_time'], 5100.0, places=3)
        self.assertAlmostEqual(first['avg_cadence'], 85.0, places=3)
        self.assertAlmostEqual(first['avg_pace_s_per_km'], 340.0, places=3)
        self.assertTrue(first['is_primary'])
        self.assertEqual(first['lifetime_distance'], 90000.0)

        second = shoes['shoe-2']
        self.assertEqual(second['activity_count'], 1)
        self.assertAlmostEqual(second['total_distance'], 8000.0, places=3)
        self.assertAlmostEqual(second['avg_cadence'], 82.0, places=3)
        self.assertFalse(second['is_primary'])
