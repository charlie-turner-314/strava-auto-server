import os
import tempfile
import time
import unittest
from typing import Any, Dict, Optional

from api import db  # type: ignore
from sqlalchemy import text as sql_text
from api.strava_client import StravaClient  # type: ignore


class _FakeResp:
    def __init__(
        self, status_code: int, json_data: Any, headers: Optional[Dict[str, str]] = None
    ):
        self.status_code = status_code
        self._json_data = json_data
        self.headers = headers or {}
        self.text = "<json>"
        self.request = None  # not used in success paths

    def json(self) -> Any:
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("error", request=None, response=None)


class TestStravaClient(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "test.db")
        os.environ["DATABASE_URL"] = f"sqlite:///{self.db_path}"
        os.environ["STRAVA_CLIENT_ID"] = "12345"
        os.environ["STRAVA_REDIRECT_URI"] = "http://localhost/callback"
        os.environ["STRAVA_CLIENT_SECRET"] = "secret"
        db._engine = None  # type: ignore[attr-defined]
        self.engine = db.get_engine()
        db.ensure_schema()
        with self.engine.begin() as conn:
            conn.execute(sql_text("DELETE FROM strava_request_log"))

    def tearDown(self):
        self.tmpdir.cleanup()

    async def test_build_auth_url_contains_params(self):
        client = StravaClient(self.engine)
        url = client.build_auth_url(["activity:read_all", "activity:write"])
        self.assertIn("client_id=12345", url)
        self.assertIn("redirect_uri=http%3A%2F%2Flocalhost%2Fcallback", url)

    async def test_exchange_and_refresh_and_get_activities(self):
        client = StravaClient(self.engine)

        # Patch HTTP POST for token exchange
        async def fake_post(url, data=None, **kwargs):
            now = int(time.time())
            return _FakeResp(
                200,
                {
                    "access_token": "at1",
                    "refresh_token": "rt1",
                    "expires_at": now + 3600,
                    "scope": "read,activity:read_all",
                    "athlete": {"id": 42},
                },
            )

        client._http.post = fake_post  # type: ignore[method-assign]
        t = await client.exchange_code_for_token("code123")
        self.assertEqual(t.athlete_id, 42)

        # Force expiry and refresh
        with self.engine.begin() as conn:
            conn.execute(
                sql_text("UPDATE oauth_tokens SET expires_at = :e"),
                {"e": int(time.time()) - 10},
            )

        async def fake_post_refresh(url, data=None, **kwargs):
            now = int(time.time())
            return _FakeResp(
                200,
                {
                    "access_token": "at2",
                    "refresh_token": "rt2",
                    "expires_at": now + 7200,
                    "scope": "read,activity:read_all",
                    "athlete": {"id": 42},
                },
            )

        client._http.post = fake_post_refresh  # type: ignore[method-assign]
        await client.refresh_token_if_needed()
        # Verify expiry moved into the future; read via scalar for portability
        new_exp = None
        for _ in range(10):
            with self.engine.connect() as conn:
                exp = (
                    conn.execute(
                        sql_text(
                            "SELECT expires_at FROM oauth_tokens WHERE provider='strava'"
                        )
                    ).scalar_one_or_none()
                )
                if exp:
                    new_exp = int(exp)
                    break
            time.sleep(0.05)
        self.assertIsNotNone(new_exp)
        self.assertGreater(new_exp, int(time.time()))

        # Patch GET for activities
        async def fake_get(url, params=None, headers=None, **kwargs):
            data = [
                {
                    "id": 1,
                    "start_date": "2023-01-01T10:00:00Z",
                    "start_date_local": "2023-01-01T11:00:00Z",
                    "sport_type": "Run",
                    "name": "Morning Run",
                    "distance": 1000.0,
                    "moving_time": 300,
                    "elapsed_time": 320,
                    "total_elevation_gain": 10.0,
                }
            ]
            headers = {
                "X-RateLimit-Usage": "10,100",
                "X-RateLimit-Limit": "100,1000",
            }
            return _FakeResp(200, data, headers)

        client._http.get = fake_get  # type: ignore[method-assign]
        acts = await client.get_athlete_activities(after=0)
        self.assertEqual(len(acts), 1)

    async def test_get_activities_retries_then_succeeds(self):
        client = StravaClient(self.engine)
        # Seed a token row so client tries request
        with self.engine.begin() as conn:
            conn.execute(
                sql_text(
                    "INSERT INTO oauth_tokens(provider, access_token, refresh_token, expires_at) VALUES('strava','at','rt',:e)"
                ),
                {"e": int(time.time()) + 3600},
            )

        attempts = {"n": 0}

        class _Resp:
            def __init__(self, status_code, json_data=None, headers=None):
                self.status_code = status_code
                self._json = json_data
                self.headers = headers or {}
                self.request = None
                self.text = "x"

            def raise_for_status(self):
                if self.status_code >= 400:
                    import httpx

                    raise httpx.HTTPStatusError("error", request=None, response=None)

            def json(self):
                return self._json

        async def fake_get(url, params=None, headers=None, **kwargs):
            attempts["n"] += 1
            if attempts["n"] < 3:
                return _Resp(
                    500,
                    None,
                    {"X-RateLimit-Usage": "0,0", "X-RateLimit-Limit": "100,1000"},
                )
            return _Resp(200, [])

        client._http.get = fake_get  # type: ignore
        data = await client.get_athlete_activities(after=None)
        self.assertEqual(data, [])
        self.assertGreaterEqual(attempts["n"], 3)

    async def test_activity_detail_request_logged(self):
        client = StravaClient(self.engine)
        now = int(time.time())
        with self.engine.begin() as conn:
            conn.execute(
                sql_text(
                    "INSERT INTO oauth_tokens(provider, access_token, refresh_token, expires_at) VALUES('strava','at','rt',:e)"
                ),
                {"e": now + 3600},
            )

        async def fake_get(url, headers=None, params=None, **kwargs):
            return _FakeResp(
                200,
                {"id": 7},
                {"X-RateLimit-Usage": "1,10", "X-RateLimit-Limit": "100,1000"},
            )

        client._http.get = fake_get  # type: ignore[method-assign]
        data = await client.get_activity_detail(123)
        self.assertEqual(data.get("id"), 7)
        with self.engine.connect() as conn:
            count = conn.execute(
                sql_text("SELECT COUNT(*) FROM strava_request_log")
            ).scalar_one()
        self.assertEqual(count, 1)

    async def test_activity_laps_request_logged(self):
        client = StravaClient(self.engine)
        now = int(time.time())
        with self.engine.begin() as conn:
            conn.execute(
                sql_text(
                    "INSERT INTO oauth_tokens(provider, access_token, refresh_token, expires_at) VALUES('strava','at','rt',:e)"
                ),
                {"e": now + 3600},
            )

        async def fake_get(url, headers=None, **kwargs):
            return _FakeResp(
                200,
                [{"lap_index": 0}],
                {"X-RateLimit-Usage": "1,10", "X-RateLimit-Limit": "100,1000"},
            )

        client._http.get = fake_get  # type: ignore[method-assign]
        laps = await client.get_activity_laps(77)
        self.assertEqual(len(laps), 1)
        with self.engine.connect() as conn:
            count = conn.execute(
                sql_text("SELECT COUNT(*) FROM strava_request_log")
            ).scalar_one()
        self.assertEqual(count, 1)

    async def test_epoch_fallback_logs_second_request(self):
        client = StravaClient(self.engine)
        now = int(time.time())
        with self.engine.begin() as conn:
            conn.execute(
                sql_text(
                    "INSERT INTO oauth_tokens(provider, access_token, refresh_token, expires_at) VALUES('strava','at','rt',:e)"
                ),
                {"e": now + 3600},
            )

        calls = {"n": 0}

        async def fake_get(url, params=None, headers=None, **kwargs):
            calls["n"] += 1
            headers = {"X-RateLimit-Usage": "1,10", "X-RateLimit-Limit": "100,1000"}
            if calls["n"] == 1:
                return _FakeResp(200, [], headers)
            return _FakeResp(200, [{"id": 1}], headers)

        client._http.get = fake_get  # type: ignore[method-assign]
        data = await client.get_athlete_activities(after=None)
        self.assertEqual(len(data), 1)
        with self.engine.connect() as conn:
            count = conn.execute(
                sql_text("SELECT COUNT(*) FROM strava_request_log")
            ).scalar_one()
        self.assertEqual(count, 2)


if __name__ == "__main__":
    unittest.main()
