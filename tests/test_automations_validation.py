import os
import tempfile
import unittest

os.environ['DISABLE_SCHEDULER'] = '1'

from fastapi.testclient import TestClient  # type: ignore


class TestAutomationsValidation(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        os.environ['APP_ENV'] = 'test'
        # Reset engine before importing app
        from api import db  # type: ignore
        db._engine = None  # type: ignore[attr-defined]
        # Import app fresh
        import importlib
        import api.main as main  # type: ignore
        main = importlib.reload(main)
        self.client = TestClient(main.app)
        self.client.__enter__()

    def tearDown(self):
        try:
            self.client.__exit__(None, None, None)
        finally:
            self.client.close()
            self.tmpdir.cleanup()

    def test_rejects_non_array_conditions(self):
        payload = {
            "name": "Invalid Auto",
            "enabled": True,
            "priority": 0,
            "conditions": {},  # invalid: must be array
            "effects": [],
        }
        r = self.client.post('/api/automations', json=payload)
        self.assertEqual(r.status_code, 422, r.text)

    def test_rejects_invalid_effect_item(self):
        payload = {
            "name": "Invalid Auto 2",
            "enabled": True,
            "priority": 0,
            "conditions": [],
            "effects": [{"params": {}}],  # missing required 'type'
        }
        r = self.client.post('/api/automations', json=payload)
        self.assertEqual(r.status_code, 422, r.text)

