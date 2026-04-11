"""In-memory job store for async processing."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

JOB_TTL_SECONDS = 3600  # 1 hour
MAX_RECENT_JOBS = 50


class JobStatus(StrEnum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class Job(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: JobStatus = JobStatus.pending
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime | None = None
    result: Any | None = None
    error: str | None = None
    schema_name: str | None = None


class JobStore:
    """Simple in-memory job store with TTL eviction."""

    def __init__(self, ttl_seconds: int = JOB_TTL_SECONDS):
        self._jobs: dict[str, Job] = {}
        self._ttl_seconds = ttl_seconds

    def create(self, schema_name: str | None = None) -> Job:
        """Create a new pending job and evict stale ones."""
        self._evict_stale()
        job = Job(schema_name=schema_name)
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def mark_processing(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.status = JobStatus.processing

    def mark_completed(self, job_id: str, result: Any) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.status = JobStatus.completed
            job.result = result
            job.completed_at = datetime.now(UTC)

    def mark_failed(self, job_id: str, error: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.status = JobStatus.failed
            job.error = error
            job.completed_at = datetime.now(UTC)

    def list_recent(self, limit: int = MAX_RECENT_JOBS) -> list[Job]:
        """Return most recent jobs, newest first."""
        jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    def _evict_stale(self) -> None:
        """Remove jobs older than TTL."""
        now = datetime.now(UTC)
        stale_ids = [
            job_id for job_id, job in self._jobs.items() if (now - job.created_at).total_seconds() > self._ttl_seconds
        ]
        for job_id in stale_ids:
            del self._jobs[job_id]


# Global singleton
job_store = JobStore()
