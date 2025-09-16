import os
import tempfile
import unittest

from api import db  # type: ignore
from sqlalchemy import text as sql_text


class TestDBSchema(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        # reset shared engine
        db._engine = None  # type: ignore[attr-defined]

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_ensure_schema_creates_tables(self):
        eng = db.get_engine()
        db.ensure_schema()
        with eng.connect() as conn:
            rows = conn.execute(sql_text("SELECT name FROM sqlite_master WHERE type='table'"))
            names = {r.name for r in rows.fetchall()}
        self.assertTrue({'automations', 'oauth_tokens', 'activities', 'settings'}.issubset(names))


if __name__ == '__main__':
    unittest.main()
