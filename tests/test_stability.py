from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cherry_history
import server


class CherryHistoryStabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.snapshot_cache = dict(cherry_history.SNAPSHOT_CACHE)
        self.persist_cache = dict(cherry_history.PERSIST_CACHE)

    def tearDown(self) -> None:
        cherry_history.SNAPSHOT_CACHE.clear()
        cherry_history.SNAPSHOT_CACHE.update(self.snapshot_cache)
        cherry_history.PERSIST_CACHE.clear()
        cherry_history.PERSIST_CACHE.update(self.persist_cache)

    def test_storage_signature_skips_files_that_disappear(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            existing = Path(tmpdir) / "000001.ldb"
            existing.write_bytes(b"x")
            missing = Path(tmpdir) / "000002.log"

            with mock.patch.object(cherry_history, "_iter_leveldb_files", side_effect=[[existing, missing], []]):
                signature = cherry_history.storage_signature()

            self.assertEqual(signature, ((existing.name, 1, existing.stat().st_mtime_ns),))

    def test_get_snapshot_returns_stale_cache_when_rebuild_fails(self) -> None:
        cached_snapshot = {"assistants": [], "topics": {"cached": {"id": "cached"}}}
        cherry_history.SNAPSHOT_CACHE["signature"] = (("old.ldb", 1, 1),)
        cherry_history.SNAPSHOT_CACHE["value"] = cached_snapshot

        with mock.patch.object(cherry_history, "storage_signature", return_value=(("new.ldb", 2, 2),)):
            with mock.patch.object(cherry_history, "_build_snapshot", side_effect=RuntimeError("boom")):
                self.assertIs(cherry_history.get_snapshot(), cached_snapshot)

    def test_get_persist_state_returns_stale_cache_when_reader_fails(self) -> None:
        cached_state = {"assistants": {"assistants": []}, "llm": {}, "codeTools": {}, "openclaw": {}, "raw": {}}
        cherry_history.PERSIST_CACHE["signature"] = (("old.log", 1, 1),)
        cherry_history.PERSIST_CACHE["value"] = cached_state

        with mock.patch.object(cherry_history, "local_storage_signature", return_value=(("new.log", 2, 2),)):
            with mock.patch.object(cherry_history, "_read_persist_outer", side_effect=RuntimeError("boom")):
                self.assertIs(cherry_history.get_persist_state(), cached_state)


class ServerStabilityTests(unittest.TestCase):
    def test_request_token_from_headers_ignores_bad_cookie(self) -> None:
        headers = {"Cookie": "broken"}
        with mock.patch.object(server.SimpleCookie, "load", side_effect=server.CookieError("bad cookie")):
            self.assertEqual(server.request_token_from_headers(headers), "")


if __name__ == "__main__":
    unittest.main()
