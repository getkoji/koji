"""Koji API server."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from server.config import KojiConfig, load_config
from server.db import count_jobs as db_count_jobs
from server.db import get_job as db_get_job
from server.db import init_db, save_job
from server.db import list_jobs as db_list_jobs
from server.jobs import job_store
from server.schemas import router as schemas_router
from server.webhooks import fire_webhooks
from services.integrity import IntakeLimits, IntegrityError, check_bytes, check_parsed

START_TIME = time.time()

app = FastAPI(
    title="Koji Server",
    description="Documents in. Structured data out.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(schemas_router)

init_db()

_config: KojiConfig | None = None


def get_config() -> KojiConfig:
    global _config
    if _config is None:
        config_path = os.environ.get("KOJI_CONFIG_PATH", "/etc/koji/koji.yaml")
        _config = load_config(config_path)
    return _config


# ---------------------------------------------------------------------------
# Log streaming helpers
# ---------------------------------------------------------------------------

VALID_LOG_SERVICES = {"server", "parse", "extract", "ui", "ollama"}

SERVICE_TO_COMPOSE = {
    "server": "koji-server",
    "parse": "koji-parse",
    "extract": "koji-extract",
    "ui": "koji-ui",
    "ollama": "ollama",
}

# Regex to parse docker compose log lines.
# Format: "service-name  | 2024-01-01T00:00:00.000Z  some message"
_LOG_LINE_RE = re.compile(r"^(?P<compose_svc>\S+)\s+\|\s+(?P<ts>\S+)\s+(?P<msg>.*)$")

# Reverse lookup: compose service name -> user-facing name
_COMPOSE_TO_SERVICE = {v: k for k, v in SERVICE_TO_COMPOSE.items()}


def _compose_file_path() -> Path:
    """Return the path to the docker-compose file used by Koji."""
    return Path(".koji") / "docker-compose.yaml"


def _parse_log_line(raw: str) -> dict | None:
    """Parse a raw docker compose log line into a structured dict."""
    m = _LOG_LINE_RE.match(raw.strip())
    if not m:
        # Fallback: treat the entire line as the message
        stripped = raw.strip()
        if not stripped:
            return None
        return {"service": "unknown", "timestamp": "", "line": stripped}
    compose_svc = m.group("compose_svc")
    service = _COMPOSE_TO_SERVICE.get(compose_svc, compose_svc)
    return {
        "service": service,
        "timestamp": m.group("ts"),
        "line": m.group("msg"),
    }


@app.get("/api/logs/recent")
async def logs_recent(service: str | None = Query(None)):
    """Return the last 100 log lines as JSON."""
    if service and service not in VALID_LOG_SERVICES:
        return JSONResponse(
            {"error": f"Unknown service: {service}. Valid: {', '.join(sorted(VALID_LOG_SERVICES))}"},
            status_code=400,
        )

    compose_file = _compose_file_path()
    if not compose_file.exists():
        return JSONResponse({"lines": [], "error": "No compose file found"})

    cmd = ["docker", "compose", "-f", str(compose_file), "logs", "--tail=100", "--no-color"]
    if service:
        cmd.append(SERVICE_TO_COMPOSE[service])

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
    except (TimeoutError, FileNotFoundError):
        return JSONResponse({"lines": [], "error": "Failed to read logs"})

    lines: list[dict] = []
    for raw_line in stdout.decode(errors="replace").splitlines():
        parsed = _parse_log_line(raw_line)
        if parsed:
            lines.append(parsed)

    return JSONResponse({"lines": lines[-100:]})


async def _log_event_generator(service: str | None):
    """Async generator that yields SSE events from docker compose logs."""
    compose_file = _compose_file_path()
    if not compose_file.exists():
        yield f"data: {json.dumps({'error': 'No compose file found'})}\n\n"
        return

    cmd = ["docker", "compose", "-f", str(compose_file), "logs", "-f", "--tail=50", "--no-color"]
    if service:
        cmd.append(SERVICE_TO_COMPOSE[service])

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        assert proc.stdout is not None  # noqa: S101
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            parsed = _parse_log_line(line.decode(errors="replace"))
            if parsed:
                yield f"data: {json.dumps(parsed)}\n\n"
    except asyncio.CancelledError:
        pass
    finally:
        try:
            proc.terminate()
            await proc.wait()
        except ProcessLookupError:
            pass


@app.get("/api/logs/stream")
async def logs_stream(service: str | None = Query(None)):
    """Stream docker compose logs via Server-Sent Events."""
    if service and service not in VALID_LOG_SERVICES:
        return JSONResponse(
            {"error": f"Unknown service: {service}. Valid: {', '.join(sorted(VALID_LOG_SERVICES))}"},
            status_code=400,
        )

    return StreamingResponse(
        _log_event_generator(service),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "koji-server",
        "version": "0.1.0",
    }


def _ping_service(name: str, url: str, path: str = "/health") -> dict:
    """Ping a service and return status with response time."""
    try:
        start = time.monotonic()
        if name == "ollama":
            resp = httpx.get(url, timeout=3)
        else:
            resp = httpx.get(f"{url}{path}", timeout=3)
        elapsed_ms = round((time.monotonic() - start) * 1000)
        if resp.status_code == 200:
            return {"status": "healthy", "url": url, "response_ms": elapsed_ms}
        return {"status": "unhealthy", "url": url, "response_ms": elapsed_ms}
    except (httpx.ConnectError, httpx.TimeoutException):
        return {"status": "unreachable", "url": url, "response_ms": None}


@app.get("/api/status")
def status():
    config = get_config()
    uptime = int(time.time() - START_TIME)

    # Server is healthy if we're responding to this request
    server_url = f"http://127.0.0.1:{config.cluster.server_port}"
    services = {
        "server": {"status": "healthy", "url": server_url, "response_ms": 0},
    }

    # Ping each downstream service concurrently would be ideal,
    # but for simplicity we do sequential pings (total < 10s worst case)
    # Internal Docker network: services are reachable by compose service name
    # with their internal (non-mapped) ports.
    service_defs = [
        ("parse", "http://koji-parse:9410"),
        ("extract", "http://koji-extract:9420"),
        ("ollama", "http://ollama:11434"),
    ]

    for name, url in service_defs:
        services[name] = _ping_service(name, url)

    return {
        "services": services,
        "cluster": {
            "project": config.project,
            "name": config.cluster.name,
            "uptime_seconds": uptime,
        },
        "pipeline": [step.model_dump(exclude_none=True) for step in config.pipeline],
    }


@app.get("/api/config")
def config():
    return get_config().model_dump(exclude_none=True)


def _persist_job(
    job_id: str,
    status: str,
    schema_name: str | None,
    created_at: str,
    completed_at: str | None = None,
    elapsed_ms: int | None = None,
    result: dict | None = None,
    error: str | None = None,
    filename: str | None = None,
    model: str | None = None,
) -> None:
    """Save a job to SQLite for history."""
    try:
        save_job(
            id=job_id,
            status=status,
            schema_name=schema_name,
            filename=filename,
            model=model,
            created_at=created_at,
            completed_at=completed_at,
            elapsed_ms=elapsed_ms,
            result=result,
            error=error,
        )
    except Exception:
        pass  # don't let DB errors break the job flow


@app.get("/api/jobs/history")
def job_history(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Return paginated job history from SQLite."""
    jobs = db_list_jobs(limit=limit, offset=offset)
    total = db_count_jobs()
    return JSONResponse({"jobs": jobs, "total": total, "limit": limit, "offset": offset})


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    """Get status and result of a job. Falls back to SQLite if not in memory."""
    job = job_store.get(job_id)
    if job is not None:
        payload: dict = {
            "job_id": job.id,
            "status": job.status.value,
            "created_at": job.created_at.isoformat(),
            "schema_name": job.schema_name,
        }
        if job.completed_at:
            payload["completed_at"] = job.completed_at.isoformat()
        if job.result is not None:
            payload["result"] = job.result
        if job.error is not None:
            payload["error"] = job.error
        return JSONResponse(payload)

    # Fall back to SQLite
    row = db_get_job(job_id)
    if row is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
    payload = {"job_id": row["id"], **{k: v for k, v in row.items() if k != "id"}}
    return JSONResponse(payload)


@app.get("/api/jobs")
def list_jobs():
    """List recent jobs."""
    jobs = job_store.list_recent()
    return JSONResponse(
        [
            {
                "job_id": j.id,
                "status": j.status.value,
                "created_at": j.created_at.isoformat(),
                "completed_at": j.completed_at.isoformat() if j.completed_at else None,
                "schema_name": j.schema_name,
            }
            for j in jobs
        ]
    )


def get_service_url(service: str) -> str:
    """Get a service URL on the internal docker network."""
    config = get_config()
    project = config.project
    ports = {"parse": 9410, "extract": 9420}
    port = ports[service]
    return f"http://koji-{project}-{service}:{port}"


@app.post("/api/parse")
async def parse(file: UploadFile = File(...)):
    """Forward a document to the parse service and return markdown."""
    parse_url = get_service_url("parse")
    content = await file.read()

    try:
        check_bytes(content, file.filename)
    except IntegrityError as e:
        return JSONResponse({"error": str(e), "filename": file.filename}, status_code=400)

    async with httpx.AsyncClient(timeout=300) as client:
        try:
            resp = await client.post(
                f"{parse_url}/parse",
                files={
                    "file": (
                        file.filename,
                        content,
                        file.content_type or "application/octet-stream",
                    )
                },
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
        except httpx.ConnectError:
            return JSONResponse(
                {"error": "Parse service unavailable"},
                status_code=502,
            )


async def _run_process(
    content: bytes,
    filename: str | None,
    content_type: str,
    schema: str | None,
) -> dict:
    """Core process logic shared by sync and async paths."""
    parse_url = get_service_url("parse")

    # Parse the schema up-front so we can pull intake limits before any
    # work is done. Invalid schema is a user error → surfaced as 400.
    schema_def: dict | None = None
    if schema:
        try:
            schema_def = yaml.safe_load(schema)
        except Exception:
            try:
                schema_def = json.loads(schema)
            except Exception:
                raise ValueError("Invalid schema format")

    limits = IntakeLimits.from_schema(schema_def)

    # Fail-fast integrity check before spending parse compute or LLM tokens.
    try:
        check_bytes(content, filename, limits)
    except IntegrityError as e:
        raise ValueError(str(e))

    async with httpx.AsyncClient(timeout=1800) as client:
        # Step 1: Parse
        parse_resp = await client.post(
            f"{parse_url}/parse",
            files={"file": (filename, content, content_type)},
        )
        if parse_resp.status_code != 200:
            raise RuntimeError(f"Parse failed: {parse_resp.text}")
        parse_result = parse_resp.json()

        try:
            check_parsed(parse_result.get("pages"), limits)
        except IntegrityError as e:
            raise ValueError(str(e))

        # If no schema, return parse result only
        if not schema_def:
            return parse_result

        extract_url = get_service_url("extract")
        extract_payload: dict = {
            "markdown": parse_result["markdown"],
            "schema_def": schema_def,
        }
        # Forward the classify+split step from koji.yaml when present, so
        # /api/process gets the same classifier behavior as /api/extract.
        classify_step = get_config().classify_step()
        if classify_step is not None:
            classify_dict = classify_step.model_dump(exclude_none=True)
            classify_dict.pop("step", None)
            extract_payload["classify_config"] = classify_dict

        extract_resp = await client.post(f"{extract_url}/extract", json=extract_payload)
        if extract_resp.status_code != 200:
            raise RuntimeError(f"Extract failed: {extract_resp.text}")
        extract_result = extract_resp.json()

        # Base envelope shared by both response shapes.
        response: dict = {
            "filename": parse_result.get("filename"),
            "pages": parse_result.get("pages"),
            "parse_seconds": parse_result.get("elapsed_seconds"),
            "model": extract_result.get("model"),
            "schema": extract_result.get("schema"),
            "elapsed_ms": extract_result.get("elapsed_ms"),
            "document_map_summary": extract_result.get("document_map_summary"),
        }
        if "sections" in extract_result:
            # Classifier enabled → wrapped shape
            response["sections"] = extract_result["sections"]
            response["classifier"] = extract_result.get("classifier")
        else:
            # Flat shape (unchanged from pre-classifier)
            response["extracted"] = extract_result.get("extracted")
            response["tool_calls"] = extract_result.get("tool_calls")
            response["rounds"] = extract_result.get("rounds")
            response["confidence"] = extract_result.get("confidence")
            response["confidence_scores"] = extract_result.get("confidence_scores")
            response["routing_plan"] = extract_result.get("routing_plan")
            response["groups"] = extract_result.get("groups")
        return response


async def _process_job_bg(
    job_id: str,
    content: bytes,
    filename: str | None,
    content_type: str,
    schema: str | None,
) -> None:
    """Background task that runs process pipeline for a job."""
    job_store.mark_processing(job_id)
    job = job_store.get(job_id)
    t0 = time.monotonic()
    try:
        result = await _run_process(content, filename, content_type, schema)
        job_store.mark_completed(job_id, result)
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if job:
            _persist_job(
                job_id=job_id,
                status="completed",
                schema_name=job.schema_name,
                filename=filename,
                model=result.get("model") if isinstance(result, dict) else None,
                created_at=job.created_at.isoformat(),
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
                elapsed_ms=elapsed_ms,
                result=result,
            )
    except Exception as e:
        job_store.mark_failed(job_id, str(e))
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if job:
            _persist_job(
                job_id=job_id,
                status="failed",
                schema_name=job.schema_name,
                filename=filename,
                created_at=job.created_at.isoformat(),
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
                elapsed_ms=elapsed_ms,
                error=str(e),
            )


@app.post("/api/process")
async def process(
    file: UploadFile = File(...),
    schema: str | None = Form(None),
    async_mode: bool = Query(False, alias="async"),
):
    """Full pipeline: parse a document, then extract if a schema is provided."""
    content = await file.read()
    filename = file.filename
    content_type = file.content_type or "application/octet-stream"

    if async_mode:
        job = job_store.create(schema_name=schema[:50] if schema else None)
        asyncio.create_task(_process_job_bg(job.id, content, filename, content_type, schema))
        return JSONResponse({"job_id": job.id, "status": "pending"}, status_code=202)

    # Synchronous (original behavior)
    config = get_config()
    t0 = time.monotonic()
    try:
        result = await _run_process(content, filename, content_type, schema)
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        # Webhook payload mirrors whichever response shape the pipeline
        # produced: `sections` when the classifier ran, `extracted`
        # otherwise. Subscribers see exactly what the API returned.
        webhook_payload: dict = {
            "filename": filename,
            "schema": schema,
            "elapsed_ms": elapsed_ms,
        }
        if "sections" in result:
            webhook_payload["sections"] = result["sections"]
        else:
            webhook_payload["extracted"] = result.get("extracted")
        asyncio.create_task(fire_webhooks(config, "job.completed", webhook_payload))
        now = datetime.now(UTC)
        _persist_job(
            job_id=str(uuid.uuid4()),
            status="completed",
            schema_name=schema[:50] if schema else None,
            filename=filename,
            model=result.get("model") if isinstance(result, dict) else None,
            created_at=now.isoformat(),
            completed_at=now.isoformat(),
            elapsed_ms=elapsed_ms,
            result=result,
        )
        return JSONResponse(result)
    except httpx.ConnectError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"filename": filename, "error": str(e)}))
        return JSONResponse({"error": "Service unavailable"}, status_code=502)
    except ValueError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"filename": filename, "error": str(e)}))
        return JSONResponse({"error": str(e)}, status_code=400)
    except RuntimeError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"filename": filename, "error": str(e)}))
        return JSONResponse({"error": str(e)}, status_code=502)


class ExtractRequest(BaseModel):
    markdown: str
    schema: str
    strategy: str | None = None
    model: str | None = None


async def _run_extract(req: ExtractRequest) -> dict:
    """Core extract logic shared by sync and async paths."""
    try:
        schema_def = yaml.safe_load(req.schema)
    except Exception:
        try:
            schema_def = json.loads(req.schema)
        except Exception:
            raise ValueError("Invalid schema format")

    extract_url = get_service_url("extract")
    payload: dict = {
        "markdown": req.markdown,
        "schema_def": schema_def,
    }
    if req.strategy:
        payload["strategy"] = req.strategy
    if req.model:
        payload["model"] = req.model

    # If koji.yaml declares a `step: classify` pipeline entry, forward its
    # config to the extract service so the classify+split stage (oss-28) runs.
    # Absence of the step leaves the payload untouched — every existing
    # deployment sees byte-identical behavior.
    classify_step = get_config().classify_step()
    if classify_step is not None:
        classify_dict = classify_step.model_dump(exclude_none=True)
        # Drop the `step` key — intelligent_extract only cares about
        # model / types / require_apply_to.
        classify_dict.pop("step", None)
        payload["classify_config"] = classify_dict

    async with httpx.AsyncClient(timeout=1800) as client:
        resp = await client.post(f"{extract_url}/extract", json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"Extract failed: {resp.text}")
        return resp.json()


async def _extract_job_bg(job_id: str, req: ExtractRequest) -> None:
    """Background task that runs extraction for a job."""
    job_store.mark_processing(job_id)
    job = job_store.get(job_id)
    t0 = time.monotonic()
    try:
        result = await _run_extract(req)
        job_store.mark_completed(job_id, result)
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if job:
            _persist_job(
                job_id=job_id,
                status="completed",
                schema_name=job.schema_name,
                model=result.get("model") if isinstance(result, dict) else None,
                created_at=job.created_at.isoformat(),
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
                elapsed_ms=elapsed_ms,
                result=result,
            )
    except Exception as e:
        job_store.mark_failed(job_id, str(e))
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if job:
            _persist_job(
                job_id=job_id,
                status="failed",
                schema_name=job.schema_name,
                created_at=job.created_at.isoformat(),
                completed_at=job.completed_at.isoformat() if job.completed_at else None,
                elapsed_ms=elapsed_ms,
                error=str(e),
            )


@app.post("/api/extract")
async def extract_endpoint(
    req: ExtractRequest,
    async_mode: bool = Query(False, alias="async"),
):
    """Extract structured data from markdown using a schema. No file upload needed."""
    if async_mode:
        job = job_store.create(schema_name=req.schema[:50] if req.schema else None)
        asyncio.create_task(_extract_job_bg(job.id, req))
        return JSONResponse({"job_id": job.id, "status": "pending"}, status_code=202)

    # Synchronous (original behavior)
    config = get_config()
    t0 = time.monotonic()
    try:
        result = await _run_extract(req)
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        webhook_payload: dict = {
            "filename": None,
            "schema": req.schema,
            "elapsed_ms": elapsed_ms,
        }
        if "sections" in result:
            webhook_payload["sections"] = result["sections"]
        else:
            webhook_payload["extracted"] = result.get("extracted")
        asyncio.create_task(fire_webhooks(config, "job.completed", webhook_payload))
        now = datetime.now(UTC)
        _persist_job(
            job_id=str(uuid.uuid4()),
            status="completed",
            schema_name=req.schema[:50] if req.schema else None,
            model=result.get("model") if isinstance(result, dict) else None,
            created_at=now.isoformat(),
            completed_at=now.isoformat(),
            elapsed_ms=elapsed_ms,
            result=result,
        )
        return JSONResponse(result)
    except httpx.ConnectError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"error": str(e)}))
        return JSONResponse({"error": "Extract service unavailable"}, status_code=502)
    except ValueError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"error": str(e)}))
        return JSONResponse({"error": str(e)}, status_code=400)
    except RuntimeError as e:
        asyncio.create_task(fire_webhooks(config, "job.failed", {"error": str(e)}))
        return JSONResponse({"error": str(e)}, status_code=502)
