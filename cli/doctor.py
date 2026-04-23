"""Koji doctor — environment health checks."""

from __future__ import annotations

import os
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from cli.config import KojiConfig, load_config

Status = Literal["pass", "warn", "fail"]


@dataclass
class CheckResult:
    status: Status
    label: str
    detail: str = ""


def check_docker_installed() -> CheckResult:
    """Check that the docker CLI is available."""
    try:
        result = subprocess.run(["docker", "--version"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            version = result.stdout.strip()
            return CheckResult("pass", "Docker installed", f"({version})")
        return CheckResult("fail", "Docker installed", "(docker --version failed)")
    except FileNotFoundError:
        return CheckResult("fail", "Docker installed", "(docker not found in PATH)")
    except subprocess.TimeoutExpired:
        return CheckResult("fail", "Docker installed", "(timed out)")


def check_compose_available() -> CheckResult:
    """Check that docker compose is available."""
    try:
        result = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            version = result.stdout.strip()
            return CheckResult("pass", "Docker Compose available", f"({version})")
        return CheckResult("fail", "Docker Compose available", "(docker compose version failed)")
    except FileNotFoundError:
        return CheckResult("fail", "Docker Compose available", "(docker not found in PATH)")
    except subprocess.TimeoutExpired:
        return CheckResult("fail", "Docker Compose available", "(timed out)")


def check_docker_running() -> CheckResult:
    """Check that the Docker daemon is running."""
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return CheckResult("pass", "Docker daemon running")
        return CheckResult("fail", "Docker daemon running", "(Docker daemon not responding)")
    except FileNotFoundError:
        return CheckResult("fail", "Docker daemon running", "(docker not found)")
    except subprocess.TimeoutExpired:
        return CheckResult("fail", "Docker daemon running", "(timed out)")


def check_config_exists(config_path: Path | None = None) -> CheckResult:
    """Check that koji.yaml exists in the current directory."""
    path = config_path or Path.cwd() / "koji.yaml"
    if path.exists():
        return CheckResult("pass", "koji.yaml found")
    return CheckResult("fail", "koji.yaml found", "(not found in current directory)")


def check_config_valid(config_path: Path | None = None) -> CheckResult:
    """Check that koji.yaml parses without errors."""
    path = config_path or Path.cwd() / "koji.yaml"
    if not path.exists():
        return CheckResult("fail", "koji.yaml valid", "(file not found)")
    try:
        config = load_config(path)
        return CheckResult("pass", "koji.yaml valid", f"(project: {config.project})")
    except Exception as e:
        return CheckResult("fail", "koji.yaml valid", f"({e})")


def _port_available(port: int) -> bool:
    """Check if a port is available by trying to bind to it."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def _cluster_is_running() -> bool:
    """Check if a Koji cluster is running in the current directory."""
    state_path = Path.cwd() / ".koji" / "cluster.json"
    if not state_path.exists():
        return False
    # Verify the compose project is actually running
    compose_file = Path.cwd() / ".koji" / "docker-compose.yaml"
    if not compose_file.exists():
        return False
    try:
        result = subprocess.run(
            ["docker", "compose", "-f", str(compose_file), "ps", "-q"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def check_ports_available(config: KojiConfig | None = None) -> CheckResult:
    """Check that required ports are not already in use."""
    if config is None:
        config = KojiConfig()

    # If the cluster is already running, these ports are expected to be in use
    if _cluster_is_running():
        return CheckResult("pass", "Ports available", "(cluster is running)")

    cluster = config.cluster
    ports = {
        "ui": cluster.ui_port,
        "server": cluster.server_port,
        "ollama": cluster.ollama_port,
        "parse": cluster.parse_port,
        "extract": cluster.extract_port,
    }

    in_use = [f"{name}:{port}" for name, port in ports.items() if not _port_available(port)]

    if not in_use:
        return CheckResult("pass", "Ports available", f"(base: {cluster.base_port})")
    return CheckResult(
        "fail",
        "Ports available",
        f"(in use: {', '.join(in_use)})",
    )


def _load_dotenv() -> dict[str, str]:
    """Read key=value pairs from .env in the current directory (or repo root)."""
    env_vars: dict[str, str] = {}
    for candidate in [Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"]:
        if candidate.exists():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, value = line.partition("=")
                    env_vars[key.strip()] = value.strip().strip('"').strip("'")
            break
    return env_vars


def check_api_keys() -> CheckResult:
    """Check whether OPENAI_API_KEY is set (in environment or .env)."""
    if os.environ.get("OPENAI_API_KEY"):
        return CheckResult("pass", "OPENAI_API_KEY set")

    # Check .env file as fallback
    dotenv = _load_dotenv()
    if dotenv.get("OPENAI_API_KEY"):
        return CheckResult(
            "pass",
            "OPENAI_API_KEY set",
            '(found in .env — remember to run: eval "$(kdev env)")',
        )

    return CheckResult(
        "warn",
        "OPENAI_API_KEY not set",
        "(needed for OpenAI models, not required for ollama)",
    )


def run_all_checks(config_path: Path | None = None) -> list[CheckResult]:
    """Run all doctor checks and return results."""
    results: list[CheckResult] = []

    results.append(check_docker_installed())
    results.append(check_compose_available())
    results.append(check_docker_running())
    results.append(check_config_exists(config_path))

    # Only validate config if the file exists
    path = config_path or Path.cwd() / "koji.yaml"
    config = None
    if path.exists():
        results.append(check_config_valid(config_path))
        try:
            config = load_config(path)
        except Exception:
            config = None

    results.append(check_ports_available(config))
    results.append(check_api_keys())

    return results
