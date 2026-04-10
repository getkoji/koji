"""Koji CLI — Documents in. Structured data out."""

from __future__ import annotations

import typer
from rich.console import Console

from .cluster import cluster_status, load_project_config, start_cluster, stop_cluster

app = typer.Typer(
    name="koji",
    help="Documents in. Structured data out.",
    no_args_is_help=True,
)
console = Console()


@app.command()
def start():
    """Start the Koji cluster."""
    config = load_project_config()
    start_cluster(config)


@app.command()
def stop():
    """Stop the Koji cluster."""
    stop_cluster()


@app.command()
def status():
    """Show cluster status."""
    cluster_status()


@app.command()
def version():
    """Show Koji version."""
    console.print("koji 0.1.0")


if __name__ == "__main__":
    app()
