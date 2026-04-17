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

    By default, services reference pre-built images on ghcr.io/getkoji. Pass
    ``dev=True`` (or set ``cluster.dev: true`` in koji.yaml) to build images
    from local source instead — the contributor workflow.
    """
    cluster = config.cluster
    project = config.project
    svc_cfg = config.services
    version = cluster.version
    # Explicit `dev` arg wins; otherwise fall back to the cluster config flag.
    dev_mode = cluster.dev if dev is None else dev

    services: dict = {
        "koji-server": {
            **_image_or_build("server", "docker/server.Dockerfile", version, project_dir, dev_mode),
            "container_name": f"koji-{project}-server",
            "ports": [f"127.0.0.1:{cluster.server_port}:9401"],
            "volumes": [
                f"{project_dir}/koji.yaml:/etc/koji/koji.yaml:ro",
            ],
            "environment": {
                "KOJI_CONFIG_PATH": "/etc/koji/koji.yaml",
            },
            "healthcheck": {
                "test": [
                    "CMD",
                    "python",
                    "-c",
                    "import urllib.request; urllib.request.urlopen('http://localhost:9401/health')",
                ],
                "interval": "5s",
                "timeout": "3s",
                "retries": 3,
            },
            "restart": "unless-stopped",
            "networks": [f"koji-{project}"],
        },
        "koji-ui": {
            **_image_or_build("ui", "docker/ui.Dockerfile", version, project_dir, dev_mode),
            "container_name": f"koji-{project}-ui",
            "ports": [f"127.0.0.1:{cluster.ui_port}:9400"],
            "environment": {
                "KOJI_SERVER_URL": f"http://koji-{project}-server:9401",
                "PORT": "9400",
            },
            "depends_on": {
                "koji-server": {"condition": "service_healthy"},
            },
            "restart": "unless-stopped",
            "networks": [f"koji-{project}"],
        },
    }

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
            "networks": [f"koji-{project}"],
        }

    # Build extract service
    extract_env: dict = {
        "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}",
    }
    extract_svc: dict = {
        **_image_or_build("extract", "docker/extract.Dockerfile", version, project_dir, dev_mode),
        "container_name": f"koji-{project}-extract",
        "ports": [f"127.0.0.1:{cluster.extract_port}:9420"],
        "environment": extract_env,
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
        "networks": [f"koji-{project}"],
    }

    if svc_cfg.ollama:
        extract_env["KOJI_OLLAMA_URL"] = f"http://koji-{project}-ollama:11434"
        extract_svc["depends_on"] = {
            "ollama": {"condition": "service_healthy"},
        }

    services["koji-extract"] = extract_svc

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
            "networks": [f"koji-{project}"],
        }

    # Build volumes dict — only include volumes for enabled services
    volumes: dict = {}
    if svc_cfg.ollama:
        volumes[f"koji-{project}-ollama-data"] = {}
    if svc_cfg.parse:
        volumes[f"koji-{project}-hf-cache"] = {}
        volumes[f"koji-{project}-torch-cache"] = {}

    return {
        "name": f"koji-{project}",
        "services": services,
        "networks": {
            f"koji-{project}": {
                "driver": "bridge",
            },
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
