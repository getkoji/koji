"""Stream or tail Docker container logs for Koji services."""

from __future__ import annotations

import subprocess
from pathlib import Path

from rich.console import Console

KOJI_DIR = ".koji"

VALID_SERVICES = {"server", "parse", "extract", "dashboard", "ollama"}

# Maps user-facing service names to docker-compose service names.
SERVICE_TO_COMPOSE = {
    "server": "koji-api",
    "parse": "koji-parse",
    "extract": "koji-extract",
    "dashboard": "koji-dashboard",
    "ollama": "ollama",
}


def tail_logs(
    state: dict,
    *,
    service: str | None = None,
    follow: bool = False,
    tail: int = 100,
    console: Console,
) -> None:
    """Stream or tail logs for one or all Koji services."""
    if service and service not in VALID_SERVICES:
        console.print(
            f"[red]Unknown service [bold]{service}[/bold]. Valid services: {', '.join(sorted(VALID_SERVICES))}[/red]"
        )
        raise SystemExit(1)

    koji_dir = Path.cwd() / KOJI_DIR
    compose_file = koji_dir / "docker-compose.yaml"

    if not compose_file.exists():
        console.print("[red]No docker-compose.yaml found. Is a cluster running?[/red]")
        raise SystemExit(1)

    cmd = [
        "docker",
        "compose",
        "-f",
        str(compose_file),
        "logs",
        f"--tail={tail}",
    ]

    if follow:
        cmd.append("--follow")

    if service:
        cmd.append(SERVICE_TO_COMPOSE[service])

    project = state.get("project", "koji")
    svc_label = service or "all services"
    if follow:
        console.print(f"[bold]Streaming logs from [cyan]{project}[/cyan] ({svc_label})...[/bold]\n")
    else:
        console.print(f"[bold]Logs from [cyan]{project}[/cyan] ({svc_label}, last {tail} lines):[/bold]\n")

    try:
        subprocess.run(cmd, check=False)
    except KeyboardInterrupt:
        # Graceful exit on Ctrl-C when following
        console.print("\n[dim]Log streaming stopped.[/dim]")
