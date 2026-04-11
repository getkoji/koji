"""Tests for the SQLite persistence layer."""

from __future__ import annotations

from server.db import count_jobs, get_job, init_db, list_jobs, save_job, set_db_path


class TestDB:
    def setup_method(self, tmp_path_factory=None):
        pass

    def _init(self, tmp_path):
        db_path = tmp_path / "jobs.db"
        set_db_path(db_path)
        init_db()
        return db_path

    def test_init_db_creates_table(self, tmp_path):
        import sqlite3

        db_path = self._init(tmp_path)
        conn = sqlite3.connect(str(db_path))
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'")
        assert cursor.fetchone() is not None
        conn.close()

    def test_init_db_idempotent(self, tmp_path):
        self._init(tmp_path)
        # calling again should not raise
        init_db()

    def test_save_and_get_roundtrip(self, tmp_path):
        self._init(tmp_path)
        save_job(
            id="job-1",
            status="completed",
            schema_name="invoice",
            filename="test.pdf",
            model="gpt-4o-mini",
            created_at="2025-01-01T00:00:00+00:00",
            completed_at="2025-01-01T00:00:05+00:00",
            elapsed_ms=5000,
            result={"extracted": {"total": 42}},
            error=None,
        )
        row = get_job("job-1")
        assert row is not None
        assert row["id"] == "job-1"
        assert row["status"] == "completed"
        assert row["schema_name"] == "invoice"
        assert row["filename"] == "test.pdf"
        assert row["model"] == "gpt-4o-mini"
        assert row["elapsed_ms"] == 5000
        assert row["result"] == {"extracted": {"total": 42}}
        assert row["error"] is None

    def test_get_nonexistent(self, tmp_path):
        self._init(tmp_path)
        assert get_job("does-not-exist") is None

    def test_save_failed_job(self, tmp_path):
        self._init(tmp_path)
        save_job(
            id="job-fail",
            status="failed",
            created_at="2025-01-01T00:00:00+00:00",
            completed_at="2025-01-01T00:00:02+00:00",
            elapsed_ms=2000,
            error="Connection refused",
        )
        row = get_job("job-fail")
        assert row is not None
        assert row["status"] == "failed"
        assert row["error"] == "Connection refused"

    def test_list_jobs_ordering(self, tmp_path):
        self._init(tmp_path)
        for i in range(5):
            save_job(
                id=f"job-{i}",
                status="completed",
                created_at=f"2025-01-01T00:00:{i:02d}+00:00",
            )
        jobs = list_jobs(limit=10, offset=0)
        assert len(jobs) == 5
        # newest first
        assert jobs[0]["id"] == "job-4"
        assert jobs[-1]["id"] == "job-0"

    def test_list_jobs_pagination(self, tmp_path):
        self._init(tmp_path)
        for i in range(10):
            save_job(
                id=f"job-{i}",
                status="completed",
                created_at=f"2025-01-01T00:00:{i:02d}+00:00",
            )
        page1 = list_jobs(limit=3, offset=0)
        page2 = list_jobs(limit=3, offset=3)
        assert len(page1) == 3
        assert len(page2) == 3
        # no overlap
        page1_ids = {j["id"] for j in page1}
        page2_ids = {j["id"] for j in page2}
        assert page1_ids.isdisjoint(page2_ids)

    def test_list_jobs_excludes_result(self, tmp_path):
        self._init(tmp_path)
        save_job(
            id="job-big",
            status="completed",
            created_at="2025-01-01T00:00:00+00:00",
            result={"extracted": {"big": "data"}},
        )
        jobs = list_jobs()
        assert len(jobs) == 1
        assert "result" not in jobs[0]

    def test_count_jobs(self, tmp_path):
        self._init(tmp_path)
        assert count_jobs() == 0
        for i in range(7):
            save_job(
                id=f"job-{i}",
                status="completed",
                created_at=f"2025-01-01T00:00:{i:02d}+00:00",
            )
        assert count_jobs() == 7

    def test_save_job_upsert(self, tmp_path):
        self._init(tmp_path)
        save_job(
            id="job-up",
            status="processing",
            created_at="2025-01-01T00:00:00+00:00",
        )
        save_job(
            id="job-up",
            status="completed",
            created_at="2025-01-01T00:00:00+00:00",
            completed_at="2025-01-01T00:00:05+00:00",
            elapsed_ms=5000,
        )
        row = get_job("job-up")
        assert row is not None
        assert row["status"] == "completed"
        assert count_jobs() == 1
