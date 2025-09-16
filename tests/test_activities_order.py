import os
import tempfile
import unittest
from datetime import datetime, timezone

from sqlalchemy import text as sql_text


class TestActivitiesOrder(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, 'test.db')
        os.environ['DATABASE_URL'] = f'sqlite:///{self.db_path}'
        os.environ['DISABLE_SCHEDULER'] = '1'
        from api import db, main  # type: ignore
        db._engine = None  # reset engine
        self.engine = db.get_engine()
        db.ensure_schema()
        self.main = main

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_order_by_start_date_desc(self):
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            (1, '2023-01-01T10:00:00Z'),
            (2, '2024-05-10T12:00:00Z'),
            (3, '2022-12-31T23:59:59Z'),
        ]
        with self.engine.begin() as conn:
            for _id, sd in rows:
                conn.execute(sql_text(
                    "INSERT INTO activities(id, start_date, start_date_local, raw_json, updated_at) VALUES (:i, :sd, :sdl, :raw, :u)"
                ), {"i": _id, "sd": sd, "sdl": sd, "raw": '{}', "u": now})

        data = self.main.list_activities(limit=3, offset=0)
        ids = [item['id'] for item in data['items']]
        # Expect most recent first: id 2 (2024), then 1 (2023), then 3 (2022)
        self.assertEqual(ids, [2, 1, 3])


if __name__ == '__main__':
    unittest.main()

