"""Generate docker-compose configuration for a Koji cluster."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

import yaml

from cli.config import KojiConfig

KOJI_DIR = ".koji"


def _find_koji_dir() -> Path:
    """Walk up from cwd to find the nearest .koji/ directory."""
    current = Path.cwd()
    for parent in [current, *current.parents]:
        candidate = parent / KOJI_DIR
        if candidate.is_dir():
            return candidate
    return current / KOJI_DIR


def _resolve_master_key() -> str:
    """Return the master key, generating and persisting one if needed.

    Checked in order:
    1. KOJI_MASTER_KEY env var (explicit override)
    2. .koji/master.key file (searched upward from cwd)
    3. Auto-generate, save to .koji/master.key in cwd, and return

    The upward search prevents accidentally generating a new key when
    running from a subdirectory — losing the master key means all
    encrypted credentials in the database become unrecoverable.
    """
    env_key = os.environ.get("KOJI_MASTER_KEY")
    if env_key and len(env_key) >= 32:
        return env_key

    # Search upward for an existing key
    koji_dir = _find_koji_dir()
    key_path = koji_dir / "master.key"
    if key_path.exists():
        stored = key_path.read_text().strip()
        if stored and len(stored) >= 32:
            return stored

    # Generate a new key — always in cwd/.koji/
    key_path = Path.cwd() / KOJI_DIR / "master.key"
    new_key = secrets.token_hex(32)
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(new_key)
    key_path.chmod(0o600)
    return new_key


# Registry for pre-built Koji images. Override the tag via cluster.version.
GHCR_NAMESPACE = "ghcr.io/getkoji"

# S3-compatible object store for local clusters. Pinned deliberately: this
# replaced minio/minio:latest after MinIO withdrew their public images, and a
# floating third-party tag is exactly what made that an outage rather than a
# planned upgrade.
#
# SeaweedFS rather than the s3mock the e2e workflow uses, because a local
# cluster has to keep its documents. `koji stop` runs `docker compose down`,
# which destroys containers, and s3mock ignores every persistence setting it
# documents — it writes to a random /tmp directory, so every stop would discard
# every stored document. s3mock is right for CI precisely because it is
# ephemeral; it is wrong here for the same reason.
S3_IMAGE = "chrislusf/seaweedfs:4.48"


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
      ollama         — local LLM (optional)
    """
    cluster = config.cluster
    project = config.project
    svc_cfg = config.services
    version = cluster.version
    dev_mode = cluster.dev if dev is None else dev
    net = f"koji-{project}"

    db_port = cluster.db_port
    db_url = f"postgres://koji:koji@koji-{project}-db:5432/koji"

    services: dict = {
        # ── Postgres ──
        "koji-db": {
            "image": "postgres:16-alpine",
            "container_name": f"koji-{project}-db",
            "ports": [f"127.0.0.1:{db_port}:5432"],
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
                "KOJI_MASTER_KEY": _resolve_master_key(),
                "KOJI_S3_ENDPOINT": f"http://koji-{project}-s3:8333",
                "KOJI_S3_PUBLIC_ENDPOINT": f"http://localhost:{cluster.s3_port}",
                "KOJI_S3_ACCESS_KEY": config.storage.access_key,
                "KOJI_S3_SECRET_KEY": config.storage.secret_key,
                "KOJI_S3_BUCKET": config.storage.bucket,
                "KOJI_S3_REGION": config.storage.region,
                "KOJI_S3_FORCE_PATH_STYLE": "true",
                "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
                "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}",
            },
            "depends_on": {
                "koji-db": {"condition": "service_healthy"},
                "koji-s3-init": {"condition": "service_completed_successfully"},
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
    api_internal_url = f"http://koji-{project}-api:9401"
    if svc_cfg.dashboard:
        dashboard_block = _image_or_build("dashboard", "docker/dashboard.Dockerfile", version, project_dir, dev_mode)
        # In dev/build mode, pass the API URL as a build arg so the
        # middleware can proxy /api/* to the correct container.
        if "build" in dashboard_block:
            dashboard_block["build"]["args"] = {
                "KOJI_API_INTERNAL": api_internal_url,
            }
        services["koji-dashboard"] = {
            **dashboard_block,
            "container_name": f"koji-{project}-dashboard",
            "ports": [f"127.0.0.1:{cluster.ui_port}:3000"],
            "environment": {
                "KOJI_API_URL": api_internal_url,
                "KOJI_API_INTERNAL": api_internal_url,
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

    # ── S3-compatible object storage ──
    #
    # This was MinIO until MinIO withdrew their public container images: the
    # Docker Hub repository 404s and quay.io/minio/minio requires auth, so
    # `koji start` could not pull an image on any machine without a warm cache.
    #
    # s3mock covers the entire S3 surface Koji uses — Put/Get/Head/Delete plus
    # presigned URLs — and is pinned rather than tracking :latest, because a
    # floating third-party tag is what broke this to begin with. It has no
    # console UI, which is the one thing lost in the swap.
    s3_secret = config.storage.secret_key
    services["koji-s3"] = {
        "image": S3_IMAGE,
        "container_name": f"koji-{project}-s3",
        # `server` runs master, volume, filer and the S3 gateway in one process,
        # which is what a single-node local cluster wants. -dir is the only
        # persistence knob needed: everything lives under it.
        "command": "server -dir=/data -s3 -s3.port=8333 -ip=0.0.0.0",
        "ports": [
            f"127.0.0.1:{cluster.s3_port}:8333",
        ],
        "volumes": [
            f"koji-{project}-s3-data:/data",
        ],
        "restart": "unless-stopped",
        "networks": [net],
    }

    # Bucket init. Reuses the api image rather than pulling another one: it
    # already carries node, the AWS SDK and the script.
    #
    # The script retries a cold endpoint, which is why koji-s3 needs no
    # healthcheck — the init container is the readiness gate, and the API waits
    # for it to exit successfully.
    services["koji-s3-init"] = {
        **_image_or_build("api", "docker/api.Dockerfile", version, project_dir, dev_mode),
        "container_name": f"koji-{project}-s3-init",
        "depends_on": ["koji-s3"],
        "command": ["node", "api/scripts/s3-ensure-bucket.mjs"],
        "environment": {
            "KOJI_S3_ENDPOINT": f"http://koji-{project}-s3:8333",
            "KOJI_S3_BUCKET": config.storage.bucket,
            "KOJI_S3_ACCESS_KEY": config.storage.access_key,
            "KOJI_S3_SECRET_KEY": s3_secret,
            "KOJI_S3_REGION": config.storage.region,
        },
        "restart": "no",
        "networks": [net],
    }

    services["koji-api"]["environment"]["KOJI_S3_ENDPOINT"] = f"http://koji-{project}-s3:8333"
    services["koji-api"]["environment"]["KOJI_S3_BUCKET"] = config.storage.bucket
    services["koji-api"]["environment"]["KOJI_S3_ACCESS_KEY"] = config.storage.access_key
    services["koji-api"]["environment"]["KOJI_S3_SECRET_KEY"] = s3_secret
    services["koji-api"]["environment"]["KOJI_S3_REGION"] = config.storage.region
    services["koji-api"]["environment"]["KOJI_S3_FORCE_PATH_STYLE"] = str(config.storage.force_path_style).lower()
    services["koji-api"]["environment"]["KOJI_S3_PUBLIC_ENDPOINT"] = f"http://127.0.0.1:{cluster.s3_port}"
    services["koji-api"]["depends_on"]["koji-s3-init"] = {"condition": "service_completed_successfully"}

    # Wire parse as API dependency
    if svc_cfg.parse:
        services["koji-api"]["depends_on"]["koji-parse"] = {"condition": "service_healthy"}

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
        f"koji-{project}-s3-data": {},
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
