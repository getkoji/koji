"""Koji API server."""

from __future__ import annotations

import json
import os
import time

import httpx
import yaml
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from server.config import KojiConfig, load_config

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


@app.post("/api/process")
async def process(file: UploadFile = File(...), schema: str | None = Form(None)):
    """Full pipeline: parse a document, then extract if a schema is provided."""
    parse_url = get_service_url("parse")
    content = await file.read()

    async with httpx.AsyncClient(timeout=1800) as client:
        # Step 1: Parse
        try:
            parse_resp = await client.post(
                f"{parse_url}/parse",
                files={
                    "file": (
                        file.filename,
                        content,
                        file.content_type or "application/octet-stream",
                    )
                },
            )
            if parse_resp.status_code != 200:
                return JSONResponse(parse_resp.json(), status_code=parse_resp.status_code)
            parse_result = parse_resp.json()
        except httpx.ConnectError:
            return JSONResponse({"error": "Parse service unavailable"}, status_code=502)

        # If no schema, return parse result only
        if not schema:
            return JSONResponse(parse_result)

        # Step 2: Extract
        try:
            schema_def = yaml.safe_load(schema)
        except Exception:
            try:
                schema_def = json.loads(schema)
            except Exception:
                return JSONResponse({"error": "Invalid schema format"}, status_code=400)

        extract_url = get_service_url("extract")
        try:
            extract_resp = await client.post(
                f"{extract_url}/extract",
                json={
                    "markdown": parse_result["markdown"],
                    "schema_def": schema_def,
                },
            )
            if extract_resp.status_code != 200:
                return JSONResponse(extract_resp.json(), status_code=extract_resp.status_code)
            extract_result = extract_resp.json()
        except httpx.ConnectError:
            return JSONResponse({"error": "Extract service unavailable"}, status_code=502)

        return JSONResponse(
            {
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
        )


class ExtractRequest(BaseModel):
    markdown: str
    schema: str
    strategy: str | None = None
    model: str | None = None


@app.post("/api/extract")
async def extract_endpoint(req: ExtractRequest):
    """Extract structured data from markdown using a schema. No file upload needed."""
    try:
        schema_def = yaml.safe_load(req.schema)
    except Exception:
        try:
            schema_def = json.loads(req.schema)
        except Exception:
            return JSONResponse({"error": "Invalid schema format"}, status_code=400)

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
        try:
            resp = await client.post(
                f"{extract_url}/extract",
                json=payload,
            )
            return JSONResponse(resp.json(), status_code=resp.status_code)
        except httpx.ConnectError:
            return JSONResponse({"error": "Extract service unavailable"}, status_code=502)
