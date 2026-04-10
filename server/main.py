"""Koji API server."""

from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/api/status")
def status():
    config = get_config()
    uptime = int(time.time() - START_TIME)

    services = [
        {
            "name": "koji-server",
            "status": "healthy",
            "port": config.cluster.server_port,
            "endpoint": f"http://127.0.0.1:{config.cluster.server_port}",
        },
        {
            "name": "koji-ui",
            "status": "healthy",
            "port": config.cluster.ui_port,
            "endpoint": f"http://127.0.0.1:{config.cluster.ui_port}",
        },
        {
            "name": "ollama",
            "status": "healthy",
            "port": config.cluster.ollama_port,
            "endpoint": f"http://127.0.0.1:{config.cluster.ollama_port}",
        },
    ]

    return {
        "project": config.project,
        "cluster": config.cluster.name,
        "uptime_seconds": uptime,
        "services": services,
        "pipeline": [step.model_dump(exclude_none=True) for step in config.pipeline],
    }


@app.get("/api/config")
def config():
    return get_config().model_dump(exclude_none=True)
