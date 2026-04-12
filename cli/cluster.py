"""Cluster lifecycle management."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import httpx
from rich.console import Console

from server.config import KojiConfig, load_config

from .compose import write_compose
from .doctor import _port_available

console = Console()

KOJI_DIR = ".koji"


def get_project_dir() -> str:
    return str(Path.cwd())


def get_koji_dir() -> Path:
    koji_dir = Path.cwd() / KOJI_DIR
    koji_dir.mkdir(exist_ok=True)
    return koji_dir


def load_project_config() -> KojiConfig:
    """Load koji.yaml from the current directory."""
    config_path = Path.cwd() / "koji.yaml"
    if not config_path.exists():
        console.print("[red]No koji.yaml found in current directory.[/red]")
        console.print("Run [bold]koji init[/bold] to create one, or cd to a directory with a koji.yaml.")
        raise SystemExit(1)
    return load_config(config_path)


def save_cluster_state(config: KojiConfig) -> None:
    """Save cluster metadata for status/stop commands."""
    koji_dir = get_koji_dir()
    state = {
        "project": config.project,
        "cluster_name": config.cluster.name,
        "base_port": config.cluster.base_port,
        "ui_port": config.cluster.ui_port,
        "server_port": config.cluster.server_port,
        "parse_port": config.cluster.parse_port,
        "extract_port": config.cluster.extract_port,
        "ollama_port": config.cluster.ollama_port,
        "started_at": time.time(),
    }
    with open(koji_dir / "cluster.json", "w") as f:
        json.dump(state, f, indent=2)


def load_cluster_state() -> dict | None:
    """Load saved cluster state."""
    state_path = Path.cwd() / KOJI_DIR / "cluster.json"
    if not state_path.exists():
        return None
    with open(state_path) as f:
        return json.load(f)


def run_compose(args: list[str], koji_dir: Path) -> subprocess.CompletedProcess:
    """Run a docker compose command."""
    compose_file = str(koji_dir / "docker-compose.yaml")
    cmd = ["docker", "compose", "-f", compose_file, *args]
    return subprocess.run(cmd, capture_output=True, text=True)


def _get_port_map(config: KojiConfig) -> dict[str, int]:
    """Return a mapping of service name to port for all cluster services."""
    cluster = config.cluster
    return {
        "UI": cluster.ui_port,
        "Server": cluster.server_port,
        "Ollama": cluster.ollama_port,
        "Parse": cluster.parse_port,
        "Extract": cluster.extract_port,
    }


def find_available_base_port(current_base: int) -> int | None:
    """Scan upward from current base_port in increments of 100 to find a free range.

    Returns the first base_port where all 5 derived ports are available,
    or None if nothing found within a reasonable range.
    """
    from server.config import ClusterConfig

    # Start at the next multiple of 100 above current
    candidate = ((current_base // 100) + 1) * 100
    for _ in range(50):  # don't scan forever
        test_config = KojiConfig(cluster=ClusterConfig(base_port=candidate))
        ports = _get_port_map(test_config)
        if all(_port_available(p) for p in ports.values()):
            return candidate
        candidate += 100
    return None


def check_port_conflicts(config: KojiConfig) -> None:
    """Check all required ports and exit with a helpful message if any are in use."""
    ports = _get_port_map(config)
    results = {name: _port_available(port) for name, port in ports.items()}

    if all(results.values()):
        return  # all clear

    console.print("\n[bold red]Port conflict detected:[/bold red]")
    for name, port in ports.items():
        available = results[name]
        if available:
            console.print(f"  [green]✓[/green] {port} ({name}) — available")
        else:
            console.print(f"  [red]✗[/red] {port} ({name}) — already in use")

    suggestion = find_available_base_port(config.cluster.base_port)
    if suggestion is not None:
        console.print(f"\nSuggestion: set [bold]base_port: {suggestion}[/bold] in koji.yaml")
    else:
        console.print("\nCould not find a free port range. Free up ports and try again.")

    console.print()
    raise SystemExit(1)


def start_cluster(config: KojiConfig, dev: bool = False) -> None:
    """Start the Koji cluster.

    By default, pre-built images are pulled from ghcr.io/getkoji. Pass
    ``dev=True`` (or set ``cluster.dev: true`` in koji.yaml) to build images
    from local source — the contributor workflow.
    """
    project_dir = get_project_dir()
    koji_dir = get_koji_dir()

    # CLI flag wins; otherwise fall back to the cluster config flag.
    dev_mode = dev or config.cluster.dev

    # Check for port conflicts before doing anything with Docker
    check_port_conflicts(config)

    console.print(f"\n[bold]Starting Koji cluster [cyan]{config.project}[/cyan]...[/bold]\n")

    # Generate docker-compose
    compose_path = write_compose(config, project_dir, str(koji_dir), dev=dev_mode)
    console.print(f"  Generated {compose_path}")

    if dev_mode:
        console.print("  Building containers from source (dev mode)...")
        result = run_compose(["build", "--quiet"], koji_dir)
        if result.returncode != 0:
            console.print(f"[red]Build failed:[/red]\n{result.stderr}")
            raise SystemExit(1)
    else:
        console.print(f"  Pulling images (ghcr.io/getkoji, tag: {config.cluster.version})...")
        # Stream pull output so users see progress on large downloads.
        compose_file = str(koji_dir / "docker-compose.yaml")
        pull_result = subprocess.run(
            ["docker", "compose", "-f", compose_file, "pull"],
        )
        if pull_result.returncode != 0:
            console.print("[red]Pull failed.[/red] Run [bold]koji start --dev[/bold] to build from source instead.")
            raise SystemExit(1)

    console.print("  Starting services...")
    result = run_compose(["up", "-d"], koji_dir)
    if result.returncode != 0:
        console.print(f"[red]Start failed:[/red]\n{result.stderr}")
        raise SystemExit(1)

    # Save state
    save_cluster_state(config)

    # Wait for server health
    server_url = f"http://127.0.0.1:{config.cluster.server_port}"
    healthy = wait_for_health(server_url, timeout=30)

    if not healthy:
        console.print("[yellow]  Server is still starting up...[/yellow]")

    # Print status
    console.print(f"\n[bold green]Koji cluster [cyan]{config.project}[/cyan] is running:[/bold green]\n")
    console.print(f"  [bold]Dashboard:[/bold]   http://127.0.0.1:{config.cluster.ui_port}")
    console.print(f"  [bold]API Server:[/bold]  http://127.0.0.1:{config.cluster.server_port}")
    console.print(f"  [bold]Parse:[/bold]       http://127.0.0.1:{config.cluster.parse_port}")
    console.print(f"  [bold]Extract:[/bold]     http://127.0.0.1:{config.cluster.extract_port}")
    console.print(f"  [bold]Ollama:[/bold]      http://127.0.0.1:{config.cluster.ollama_port}")
    console.print()


def stop_cluster() -> None:
    """Stop the Koji cluster."""
    koji_dir = Path.cwd() / KOJI_DIR
    state = load_cluster_state()

    if not (koji_dir / "docker-compose.yaml").exists():
        console.print("[yellow]No running cluster found in this directory.[/yellow]")
        raise SystemExit(1)

    project_name = state["project"] if state else "unknown"
    console.print(f"\n[bold]Stopping Koji cluster [cyan]{project_name}[/cyan]...[/bold]")

    result = run_compose(["down"], koji_dir)
    if result.returncode != 0:
        console.print(f"[red]Stop failed:[/red]\n{result.stderr}")
        raise SystemExit(1)

    console.print("[bold green]Cluster stopped.[/bold green]\n")


def cluster_status() -> None:
    """Show cluster status."""
    state = load_cluster_state()
    if state is None:
        console.print("[yellow]No cluster state found. Is a cluster running in this directory?[/yellow]")
        raise SystemExit(1)

    console.print(f"\n[bold]Koji cluster [cyan]{state['project']}[/cyan][/bold]\n")

    services = [
        ("Dashboard", state["ui_port"], f"http://127.0.0.1:{state['ui_port']}"),
        ("API Server", state["server_port"], f"http://127.0.0.1:{state['server_port']}"),
        ("Parse", state.get("parse_port", "?"), f"http://127.0.0.1:{state.get('parse_port', '?')}"),
        (
            "Extract",
            state.get("extract_port", "?"),
            f"http://127.0.0.1:{state.get('extract_port', '?')}",
        ),
        ("Ollama", state["ollama_port"], f"http://127.0.0.1:{state['ollama_port']}"),
    ]

    for name, port, url in services:
        healthy = check_health(url)
        status_icon = "[green]●[/green]" if healthy else "[red]●[/red]"
        status_text = "healthy" if healthy else "unreachable"
        console.print(f"  {status_icon} [bold]{name:<12}[/bold] :{port}  {status_text}")

    # Uptime
    if "started_at" in state:
        uptime = int(time.time() - state["started_at"])
        minutes, seconds = divmod(uptime, 60)
        hours, minutes = divmod(minutes, 60)
        console.print(f"\n  Uptime: {hours}h {minutes}m {seconds}s")

    console.print()


def check_health(base_url: str, path: str = "/health") -> bool:
    """Check if a service is healthy."""
    try:
        # For ollama, the health endpoint is just /
        if "ollama" in base_url or path == "/":
            resp = httpx.get(base_url, timeout=2)
        else:
            resp = httpx.get(f"{base_url}{path}", timeout=2)
        return resp.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def wait_for_health(base_url: str, timeout: int = 30) -> bool:
    """Wait for a service to become healthy."""
    start = time.time()
    while time.time() - start < timeout:
        if check_health(base_url):
            return True
        time.sleep(1)
    return False
