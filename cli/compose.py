"""Generate docker-compose configuration for a Koji cluster."""

from __future__ import annotations

import yaml

from server.config import KojiConfig


def generate_compose(config: KojiConfig, project_dir: str) -> dict:
    """Generate a docker-compose dict from a KojiConfig."""
    cluster = config.cluster
    project = config.project

    return {
        "name": f"koji-{project}",
        "services": {
            "koji-server": {
                "build": {
                    "context": project_dir,
                    "dockerfile": "docker/server.Dockerfile",
                },
                "container_name": f"koji-{project}-server",
                "ports": [f"127.0.0.1:{cluster.server_port}:9401"],
                "volumes": [
                    f"{project_dir}/koji.yaml:/etc/koji/koji.yaml:ro",
                ],
                "environment": {
                    "KOJI_CONFIG_PATH": "/etc/koji/koji.yaml",
                },
                "healthcheck": {
                    "test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:9401/health')"],
                    "interval": "5s",
                    "timeout": "3s",
                    "retries": 3,
                },
                "restart": "unless-stopped",
                "networks": [f"koji-{project}"],
            },
            "koji-ui": {
                "build": {
                    "context": project_dir,
                    "dockerfile": "docker/ui.Dockerfile",
                },
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
            "koji-parse": {
                "build": {
                    "context": project_dir,
                    "dockerfile": "docker/parse.Dockerfile",
                },
                "container_name": f"koji-{project}-parse",
                "ports": [f"127.0.0.1:{cluster.parse_port}:9410"],
                "healthcheck": {
                    "test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:9410/health')"],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 3,
                },
                "restart": "unless-stopped",
                "networks": [f"koji-{project}"],
            },
            "koji-extract": {
                "build": {
                    "context": project_dir,
                    "dockerfile": "docker/extract.Dockerfile",
                },
                "container_name": f"koji-{project}-extract",
                "ports": [f"127.0.0.1:{cluster.extract_port}:9420"],
                "environment": {
                    "KOJI_OLLAMA_URL": f"http://koji-{project}-ollama:11434",
                    "OPENAI_API_KEY": "${OPENAI_API_KEY:-}",
                    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY:-}",
                },
                "healthcheck": {
                    "test": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:9420/health')"],
                    "interval": "10s",
                    "timeout": "5s",
                    "retries": 3,
                },
                "depends_on": {
                    "ollama": {"condition": "service_healthy"},
                },
                "restart": "unless-stopped",
                "networks": [f"koji-{project}"],
            },
            "ollama": {
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
            },
        },
        "networks": {
            f"koji-{project}": {
                "driver": "bridge",
            },
        },
        "volumes": {
            f"koji-{project}-ollama-data": {},
        },
    }


def write_compose(config: KojiConfig, project_dir: str, output_dir: str) -> str:
    """Generate and write docker-compose.yaml. Returns the file path."""
    compose = generate_compose(config, project_dir)
    output_path = f"{output_dir}/docker-compose.yaml"

    with open(output_path, "w") as f:
        yaml.dump(compose, f, default_flow_style=False, sort_keys=False)

    return output_path
