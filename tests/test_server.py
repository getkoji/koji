"""Tests for the job store logic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from server.jobs import JobStatus, JobStore


class TestJobStore:
    def setup_method(self):
        self.store = JobStore(ttl_seconds=3600)

    def test_create_job(self):
        job = self.store.create(schema_name="invoice")
        assert job.id is not None
        assert job.status == JobStatus.pending
        assert job.schema_name == "invoice"
        assert job.created_at is not None
        assert job.completed_at is None
        assert job.result is None
        assert job.error is None

    def test_get_job(self):
        job = self.store.create()
        fetched = self.store.get(job.id)
        assert fetched is not None
        assert fetched.id == job.id

    def test_get_nonexistent_job(self):
        assert self.store.get("nonexistent-id") is None

    def test_mark_processing(self):
        job = self.store.create()
        self.store.mark_processing(job.id)
        fetched = self.store.get(job.id)
        assert fetched is not None
        assert fetched.status == JobStatus.processing

    def test_mark_completed(self):
        job = self.store.create()
        self.store.mark_processing(job.id)
        result = {"extracted": {"name": "Test"}}
        self.store.mark_completed(job.id, result)
        fetched = self.store.get(job.id)
        assert fetched is not None
        assert fetched.status == JobStatus.completed
        assert fetched.result == result
        assert fetched.completed_at is not None

    def test_mark_failed(self):
        job = self.store.create()
        self.store.mark_processing(job.id)
        self.store.mark_failed(job.id, "Connection refused")
        fetched = self.store.get(job.id)
        assert fetched is not None
        assert fetched.status == JobStatus.failed
        assert fetched.error == "Connection refused"
        assert fetched.completed_at is not None

    def test_list_recent_empty(self):
        assert self.store.list_recent() == []

    def test_list_recent_ordering(self):
        job1 = self.store.create(schema_name="first")
        job2 = self.store.create(schema_name="second")
        job3 = self.store.create(schema_name="third")
        recent = self.store.list_recent()
        assert len(recent) == 3
        # Newest first
        assert recent[0].id == job3.id
        assert recent[1].id == job2.id
        assert recent[2].id == job1.id

    def test_list_recent_limit(self):
        for i in range(10):
            self.store.create(schema_name=f"job-{i}")
        recent = self.store.list_recent(limit=5)
        assert len(recent) == 5

    def test_ttl_eviction(self):
        # Create a store with 1 second TTL
        store = JobStore(ttl_seconds=1)
        job = store.create(schema_name="old")

        # Manually backdate the job
        job.created_at = datetime.now(UTC) - timedelta(seconds=2)

        # Creating a new job should trigger eviction
        new_job = store.create(schema_name="new")
        assert store.get(job.id) is None
        assert store.get(new_job.id) is not None

    def test_ttl_does_not_evict_fresh_jobs(self):
        store = JobStore(ttl_seconds=3600)
        job = store.create(schema_name="fresh")
        # Creating another job should not evict the first
        store.create(schema_name="newer")
        assert store.get(job.id) is not None

    def test_job_unique_ids(self):
        ids = {self.store.create().id for _ in range(100)}
        assert len(ids) == 100
