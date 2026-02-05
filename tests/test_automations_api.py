import os
import tempfile
import unittest
from datetime import datetime, timezone

os.environ['DISABLE_SCHEDULER'] = '1'

from fastapi.testclient import TestClient  # type: ignore
from sqlalchemy import text as sql_text


class TestAutomationsAPI(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        os.environ['APP_ENV'] = 'prod'
        os.environ['APP_AUTH_SECRET'] = 'test-secret'
        os.environ['APP_COOKIE_SECURE'] = '0'
        # Reset engine before importing app
        from api import db  # type: ignore
        db._engine = None  # type: ignore[attr-defined]
        # Import app after env set and engine reset
        import importlib
        import api.main as main  # type: ignore
        main = importlib.reload(main)

        self.main = main
        self.client = TestClient(main.app)
        self.client.__enter__()

    def tearDown(self):
        try:
            self.client.__exit__(None, None, None)
        finally:
            self.client.close()
        self.tmpdir.cleanup()

    def _login(self, athlete_id: int = 42) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.main.engine.begin() as conn:
            conn.execute(
                sql_text(
                    """
                    INSERT INTO users (athlete_id, firstname, lastname, username, created_at, updated_at)
                    VALUES (:aid, :fn, :ln, :un, :now, :now)
                    ON CONFLICT(athlete_id) DO UPDATE SET
                      firstname = excluded.firstname,
                      lastname = excluded.lastname,
                      username = excluded.username,
                      updated_at = excluded.updated_at
                    """
                ),
                {
                    "aid": int(athlete_id),
                    "fn": "Test",
                    "ln": "User",
                    "un": "tester",
                    "now": now,
                },
            )
        token, _ = self.main._issue_session(int(athlete_id))
        self.client.cookies.set(self.main.COOKIE_NAME, token)

    def test_create_list_toggle_delete(self):
        self._login()
        # Create
        payload = {
            "name": "Test Auto",
            "enabled": True,
            "priority": 5,
            "conditions": [],
            "effects": [],
        }
        r = self.client.post('/api/automations', json=payload)
        self.assertEqual(r.status_code, 201, r.text)
        data = r.json()
        self.assertEqual(data['name'], 'Test Auto')
        aid = data['id']

        # List
        r = self.client.get('/api/automations')
        self.assertEqual(r.status_code, 200)
        items = r.json()
        self.assertTrue(any(x['id'] == aid for x in items))

        # Toggle enabled off
        r = self.client.patch(f'/api/automations/{aid}/enabled', json={"enabled": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['enabled'], False)

        # Delete
        r = self.client.delete(f'/api/automations/{aid}')
        self.assertEqual(r.status_code, 204, r.text)


if __name__ == '__main__':
    unittest.main()
