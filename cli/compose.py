"""Generate docker-compose configuration for a Koji cluster."""

from __future__ import annotations

import yaml

from cli.config import KojiConfig

# Registry for pre-built Koji images. Override the tag via cluster.version.
GHCR_NAMESPACE = "ghcr.io/getkoji"


def _image_or_build(
    service_name: str,
    dockerfile: str,
    version: str,
    project_dir: str,
    dev: bool,
) -> dict:
    """Return either an `image:` ref (pull mode) or a `build:` block (dev mode)."""
    if dev:
        return {
            "build": {
                "context": project_dir,
                "dockerfile": dockerfile,
            },
        }
    return {"image": f"{GHCR_NAMESPACE}/{service_name}:{version}"}


def generate_compose(config: KojiConfig, project_dir: str, dev: bool | None = None) -> dict:
    """Generate a docker-compose dict from a KojiConfig.

    Architecture:
      koji-db        — Postgres 16 (required, always runs)
      koji-api       — Hono/Node API server (connects to Postgres via @koji/db)
      koji-dashboard — Next.js dashboard (talks to koji-api)
      koji-parse     — Python docling service (document → markdown)
      koji-extract   — Python extraction service (markdown + schema → fields)
      ollama         — local LLM (optional)
    """
    cluster = config.cluster
    project = config.project
    svc_cfg = config.services
    version = cluster.version
    dev_mode = cluster.dev if dev is None else dev
    net = f"koji-{project}"

    db_url = f"postgres://koji:koji@koji-{project}-db:5432/koji"

    services: dict = {
        # ── Postgres ──
        "koji-db": {
            "image": "postgres:16-alpine",
            "container_name": f"koji-{project}-db",
            "ports": ["127.0.0.1:5432:5432"],
            "environment": {
                "POSTGRES_USER": "koji",
                "POSTGRES_PASSWORD": "koji",
                "POSTGRES_DB": "koji",
            },
            "volumes": [
                f"koji-{project}-pgdata:/var/lib/postgresql/data",
                # Init scripts run on first boot (empty pgdata volume)
                # only. packages/db/src/migrate.ts re-runs the same
                # provisioning idempotently on every API boot so
                # existing volumes also get the app_user role.
                f"{project_dir}/docker/db-init:/docker-entrypoint-initdb.d:ro",
            ],
            "healthcheck": {
                "test": ["CMD", "pg_isready", "-U", "koji"],
                "interval": "5s",
                "timeout": "3s",
                "retries": 5,
            },
            "restart": "unless-stopped",
            "networks": [net],
        },
        # ── API server (Hono + @koji/db) ──
        "koji-api": {
            **_image_or_build("api", "docker/api.Dockerfile", version, project_dir, dev_mode),
            "container_name": f"koji-{project}-api",
            "ports": [f"127.0.0.1:{cluster.server_port}:9401"],
            "environment": {
                "DATABASE_URL": db_url,
                "PORT": "9401",
                "KOJI_PARSE_URL": f"http://koji-{project}-parse:9410",
                "KOJI_EXTRACT_URL": f"http://koji-{project}-extract:9420",
                "KOJI_MASTER_KEY": "${KOJI_MASTER_KEY:-}",
                "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
                "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}",
            },
            "depends_on": {
                "koji-db": {"condition": "service_healthy"},
            },
            "healthcheck": {
                "test": ["CMD", "wget", "-q", "--spider", "http://localhost:9401/health"],
                "interval": "5s",
                "timeout": "3s",
                "retries": 3,
            },
            "restart": "unless-stopped",
            "networks": [net],
        },
    }

    # ── Dashboard (Next.js) ──
    if svc_cfg.dashboard:
        services["koji-dashboard"] = {
            **_image_or_build("dashboard", "docker/dashboard.Dockerfile", version, project_dir, dev_mode),
            "container_name": f"koji-{project}-dashboard",
            "ports": [f"127.0.0.1:{cluster.ui_port}:3000"],
            "environment": {
                "NEXT_PUBLIC_API_URL": f"http://koji-{project}-api:9401",
            },
            "depends_on": {
                "koji-api": {"condition": "service_healthy"},
            },
            "restart": "unless-stopped",
            "networks": [net],
        }

    # ── Parse service ──
    if svc_cfg.parse:
        services["koji-parse"] = {
            **_image_or_build("parse", "docker/parse.Dockerfile", version, project_dir, dev_mode),
            "container_name": f"koji-{project}-parse",
            "ports": [f"127.0.0.1:{cluster.parse_port}:9410"],
            "volumes": [
                f"koji-{project}-hf-cache:/root/.cache/huggingface",
                f"koji-{project}-torch-cache:/root/.cache/torch",
            ],
            "healthcheck": {
                "test": [
                    "CMD",
                    "python",
                    "-c",
                    "import urllib.request; urllib.request.urlopen('http://localhost:9410/health')",
                ],
                "interval": "10s",
                "timeout": "5s",
                "retries": 3,
            },
            "restart": "unless-stopped",
            "networks": [net],
        }

    # ── Extract service ──
    # Determine extract model from pipeline config
    extract_model = "openai/gpt-4o-mini"
    for step in config.pipeline:
        if step.step == "extract" and step.model:
            extract_model = step.model  # keep full prefix: "openai/gpt-4o-mini"
            break

    extract_env: dict = {
        "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}",
        "KOJI_EXTRACT_MODEL": extract_model,
    }
    extract_svc: dict = {
        **_image_or_build("extract", "docker/extract.Dockerfile", version, project_dir, dev_mode),
        "container_name": f"koji-{project}-extract",
        "ports": [f"127.0.0.1:{cluster.extract_port}:9420"],
        "environment": extract_env,
        "dns": ["8.8.8.8", "8.8.4.4"],
        "healthcheck": {
            "test": [
                "CMD",
                "python",
                "-c",
                "import urllib.request; urllib.request.urlopen('http://localhost:9420/health')",
            ],
            "interval": "10s",
            "timeout": "5s",
            "retries": 3,
        },
        "restart": "unless-stopped",
        "networks": [net],
    }

    if svc_cfg.ollama:
        extract_env["KOJI_OLLAMA_URL"] = f"http://koji-{project}-ollama:11434"
        extract_svc["depends_on"] = {
            "ollama": {"condition": "service_healthy"},
        }

    services["koji-extract"] = extract_svc

    # ── MinIO (S3-compatible object storage) ──
    minio_secret = config.storage.secret_key
    services["koji-minio"] = {
        "image": "minio/minio:latest",
        "container_name": f"koji-{project}-minio",
        "command": "server /data --console-address :9001",
        "ports": [
            f"127.0.0.1:{cluster.minio_port}:9000",
            f"127.0.0.1:{cluster.minio_console_port}:9001",
        ],
        "environment": {
            "MINIO_ROOT_USER": config.storage.access_key,
            "MINIO_ROOT_PASSWORD": minio_secret,
        },
        "volumes": [
            f"koji-{project}-minio-data:/data",
        ],
        "healthcheck": {
            "test": ["CMD", "mc", "ready", "local"],
            "interval": "10s",
            "timeout": "5s",
            "retries": 5,
        },
        "restart": "unless-stopped",
        "networks": [net],
    }

    # MinIO init — create the default bucket on first boot
    services["koji-minio-init"] = {
        "image": "minio/mc:latest",
        "container_name": f"koji-{project}-minio-init",
        "depends_on": {
            "koji-minio": {"condition": "service_healthy"},
        },
        "entrypoint": "/bin/sh -c",
        "command": [
            f"mc alias set koji http://koji-{project}-minio:9000 {config.storage.access_key} {minio_secret} && "
            f"mc mb koji/{config.storage.bucket} --ignore-existing"
        ],
        "networks": [net],
    }

    # Wire S3 env vars into the API server
    services["koji-api"]["environment"]["KOJI_S3_ENDPOINT"] = f"http://koji-{project}-minio:9000"
    services["koji-api"]["environment"]["KOJI_S3_BUCKET"] = config.storage.bucket
    services["koji-api"]["environment"]["KOJI_S3_ACCESS_KEY"] = config.storage.access_key
    services["koji-api"]["environment"]["KOJI_S3_SECRET_KEY"] = minio_secret
    services["koji-api"]["environment"]["KOJI_S3_REGION"] = config.storage.region
    services["koji-api"]["environment"]["KOJI_S3_FORCE_PATH_STYLE"] = str(config.storage.force_path_style).lower()
    services["koji-api"]["environment"]["KOJI_S3_PUBLIC_ENDPOINT"] = f"http://127.0.0.1:{cluster.minio_port}"
    services["koji-api"]["depends_on"]["koji-minio"] = {"condition": "service_healthy"}

    # Wire parse/extract as API dependencies
    if svc_cfg.parse:
        services["koji-api"]["depends_on"]["koji-parse"] = {"condition": "service_healthy"}
    services["koji-api"]["depends_on"]["koji-extract"] = {"condition": "service_healthy"}

    # ── Mailpit (email catcher for dev / self-hosted) ──
    services["koji-mailpit"] = {
        "image": "axllent/mailpit:latest",
        "container_name": f"koji-{project}-mailpit",
        "ports": [
            f"127.0.0.1:{cluster.mailpit_ui_port}:8025",
            f"127.0.0.1:{cluster.mailpit_smtp_port}:1025",
        ],
        "restart": "unless-stopped",
        "networks": [net],
    }

    # Wire SMTP into the API server
    services["koji-api"]["environment"]["SMTP_HOST"] = f"koji-{project}-mailpit"
    services["koji-api"]["environment"]["SMTP_PORT"] = "1025"
    services["koji-api"]["environment"]["SMTP_FROM"] = "koji@localhost"

    # ── Ollama (optional) ──
    if svc_cfg.ollama:
        services["ollama"] = {
            "image": "ollama/ollama:latest",
            "container_name": f"koji-{project}-ollama",
            "ports": [f"127.0.0.1:{cluster.ollama_port}:11434"],
            "volumes": [
                f"koji-{project}-ollama-data:/root/.ollama",
            ],
            "healthcheck": {
                "test": ["CMD", "ollama", "list"],
                "interval": "10s",
                "timeout": "5s",
                "retries": 3,
            },
            "restart": "unless-stopped",
            "networks": [net],
        }

    # ── Volumes ──
    volumes: dict = {
        f"koji-{project}-pgdata": {},
        f"koji-{project}-minio-data": {},
    }
    if svc_cfg.ollama:
        volumes[f"koji-{project}-ollama-data"] = {}
    if svc_cfg.parse:
        volumes[f"koji-{project}-hf-cache"] = {}
        volumes[f"koji-{project}-torch-cache"] = {}

    return {
        "name": f"koji-{project}",
        "services": services,
        "networks": {
            net: {"driver": "bridge"},
        },
        "volumes": volumes,
    }


def write_compose(
    config: KojiConfig,
    project_dir: str,
    output_dir: str,
    dev: bool | None = None,
) -> str:
    """Generate and write docker-compose.yaml. Returns the file path."""
    compose = generate_compose(config, project_dir, dev=dev)
    output_path = f"{output_dir}/docker-compose.yaml"

    with open(output_path, "w") as f:
        yaml.dump(compose, f, default_flow_style=False, sort_keys=False)

    return output_path
