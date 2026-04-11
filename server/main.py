"""Koji API server."""

from __future__ import annotations

import asyncio
import json
import os
import time

import httpx
import yaml
from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from server.config import KojiConfig, load_config
from server.jobs import job_store
from server.schemas import router as schemas_router
from server.webhooks import fire_webhooks

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

_config: KojiConfig | None = None


def get_config() -> KojiConfig:
    global _config
    if _config is None:
        config_path = os.environ.get("KOJI_CONFIG_PATH", "/etc/koji/koji.yaml")
        _config = load_config(config_path)
    return _config


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


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    """Get status and result of a job."""
    job = job_store.get(job_id)
    if job is None:
        return JSONResponse({"error": "Job not found"}, status_code=404)
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

    async with httpx.AsyncClient(timeout=1800) as client:
        # Step 1: Parse
        parse_resp = await client.post(
            f"{parse_url}/parse",
            files={"file": (filename, content, content_type)},
        )
        if parse_resp.status_code != 200:
            raise RuntimeError(f"Parse failed: {parse_resp.text}")
        parse_result = parse_resp.json()

        # If no schema, return parse result only
        if not schema:
            return parse_result

        # Step 2: Extract
        try:
            schema_def = yaml.safe_load(schema)
        except Exception:
            try:
                schema_def = json.loads(schema)
            except Exception:
                raise ValueError("Invalid schema format")

        extract_url = get_service_url("extract")
        extract_resp = await client.post(
            f"{extract_url}/extract",
            json={"markdown": parse_result["markdown"], "schema_def": schema_def},
        )
        if extract_resp.status_code != 200:
            raise RuntimeError(f"Extract failed: {extract_resp.text}")
        extract_result = extract_resp.json()

        return {
            "filename": parse_result.get("filename"),
            "pages": parse_result.get("pages"),
            "parse_seconds": parse_result.get("elapsed_seconds"),
            "extracted": extract_result.get("extracted"),
            "model": extract_result.get("model"),
            "schema": extract_result.get("schema"),
            "elapsed_ms": extract_result.get("elapsed_ms"),
            "tool_calls": extract_result.get("tool_calls"),
            "rounds": extract_result.get("rounds"),
        }


async def _process_job_bg(
    job_id: str,
    content: bytes,
    filename: str | None,
    content_type: str,
    schema: str | None,
) -> None:
    """Background task that runs process pipeline for a job."""
    job_store.mark_processing(job_id)
    try:
        result = await _run_process(content, filename, content_type, schema)
        job_store.mark_completed(job_id, result)
    except Exception as e:
        job_store.mark_failed(job_id, str(e))


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
        asyncio.create_task(
            fire_webhooks(
                config,
                "job.completed",
                {
                    "filename": filename,
                    "schema": schema,
                    "extracted": result.get("extracted"),
                    "elapsed_ms": elapsed_ms,
                },
            )
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

    async with httpx.AsyncClient(timeout=1800) as client:
        resp = await client.post(f"{extract_url}/extract", json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"Extract failed: {resp.text}")
        return resp.json()


async def _extract_job_bg(job_id: str, req: ExtractRequest) -> None:
    """Background task that runs extraction for a job."""
    job_store.mark_processing(job_id)
    try:
        result = await _run_extract(req)
        job_store.mark_completed(job_id, result)
    except Exception as e:
        job_store.mark_failed(job_id, str(e))


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
        asyncio.create_task(
            fire_webhooks(
                config,
                "job.completed",
                {
                    "filename": None,
                    "schema": req.schema,
                    "extracted": result.get("extracted"),
                    "elapsed_ms": elapsed_ms,
                },
            )
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
