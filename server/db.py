"""SQLite persistence layer for job history."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

_DB_PATH: Path | None = None


def _get_db_path() -> Path:
    """Return the database file path, defaulting to .koji/jobs.db."""
    if _DB_PATH is not None:
        return _DB_PATH
    return Path(".koji") / "jobs.db"


def set_db_path(path: Path) -> None:
    """Override the database path (used in tests)."""
    global _DB_PATH
    _DB_PATH = path


def _connect() -> sqlite3.Connection:
    db_path = _get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create the jobs table if it doesn't exist."""
    conn = _connect()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                schema_name TEXT,
                filename TEXT,
                model TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                elapsed_ms INTEGER,
                result_json TEXT,
                error TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()


def save_job(
    *,
    id: str,
    status: str,
    schema_name: str | None = None,
    filename: str | None = None,
    model: str | None = None,
    created_at: str,
    completed_at: str | None = None,
    elapsed_ms: int | None = None,
    result: dict | None = None,
    error: str | None = None,
) -> None:
    """Insert or replace a job row."""
    result_json = json.dumps(result) if result is not None else None
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO jobs
                (id, status, schema_name, filename, model, created_at,
                 completed_at, elapsed_ms, result_json, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                status,
                schema_name,
                filename,
                model,
                created_at,
                completed_at,
                elapsed_ms,
                result_json,
                error,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def get_job(job_id: str) -> dict | None:
    """Fetch a single job by ID, including result_json."""
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return _row_to_dict(row, include_result=True)
    finally:
        conn.close()


def list_jobs(limit: int = 50, offset: int = 0) -> list[dict]:
    """Return recent jobs (newest first), without result_json."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [_row_to_dict(r, include_result=False) for r in rows]
    finally:
        conn.close()


def count_jobs() -> int:
    """Return total number of jobs."""
    conn = _connect()
    try:
        row = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()
        return row[0]
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row, *, include_result: bool) -> dict:
    """Convert a sqlite3.Row to a plain dict."""
    d: dict = {
        "id": row["id"],
        "status": row["status"],
        "schema_name": row["schema_name"],
        "filename": row["filename"],
        "model": row["model"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
        "elapsed_ms": row["elapsed_ms"],
        "error": row["error"],
    }
    if include_result and row["result_json"]:
        d["result"] = json.loads(row["result_json"])
    return d
