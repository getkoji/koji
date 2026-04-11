"""Koji CLI — Documents in. Structured data out."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from .cluster import (
    cluster_status,
    load_cluster_state,
    load_project_config,
    start_cluster,
    stop_cluster,
)
from .doctor import run_all_checks
from .init import run_init
from .logs import tail_logs
from .process import process_file

app = typer.Typer(
    name="koji",
    help="Documents in. Structured data out.",
    no_args_is_help=True,
)
console = Console()


@app.command()
def init(
    project_dir: str | None = typer.Argument(None, help="Directory name to create (default: current directory)"),
    minimal: bool = typer.Option(False, "--minimal", help="Only create koji.yaml, skip example schema"),
):
    """Scaffold a new Koji project."""
    run_init(project_dir, minimal, console)


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
def process(
    path: str = typer.Argument(help="Path to a document or directory of documents"),
    schema: str | None = typer.Option(None, "--schema", "-s", help="Path to extraction schema YAML"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output directory (default: ./output/)"),
):
    """Process documents through the pipeline."""
    state = load_cluster_state()
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        raise SystemExit(1)

    server_url = f"http://127.0.0.1:{state['server_port']}"
    output_dir = output or "./output"
    file_path = Path(path)
    schema_path = Path(schema) if schema else None

    if schema_path and not schema_path.exists():
        console.print(f"[red]Schema not found: {schema}[/red]")
        raise SystemExit(1)

    mode = "parse + extract" if schema_path else "parse"

    if file_path.is_dir():
        files = [f for f in file_path.iterdir() if f.is_file() and not f.name.startswith(".")]
        if not files:
            console.print(f"[yellow]No files found in {path}[/yellow]")
            raise SystemExit(1)
        console.print(f"\n[bold]Processing {len(files)} files ({mode})...[/bold]\n")
        for f in sorted(files):
            process_file(f, server_url, output_dir, console, schema_path)
    elif file_path.is_file():
        console.print(f"\n[bold]Processing {file_path.name} ({mode})...[/bold]\n")
        process_file(file_path, server_url, output_dir, console, schema_path)
    else:
        console.print(f"[red]Path not found: {path}[/red]")
        raise SystemExit(1)


@app.command()
def extract(
    path: str = typer.Argument(help="Path to a markdown file (from a previous parse)"),
    schema: str = typer.Option(..., "--schema", "-s", help="Path to extraction schema YAML"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output directory (default: ./output/)"),
    model: str | None = typer.Option(None, "--model", "-m", help="Model to use (e.g., openai/gpt-4o-mini, llama3.2)"),
    strategy: str | None = typer.Option(None, "--strategy", help="Extraction strategy: parallel (default) or agent"),
):
    """Extract structured data from an already-parsed markdown file."""
    state = load_cluster_state()
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        raise SystemExit(1)

    server_url = f"http://127.0.0.1:{state['server_port']}"
    output_dir = output or "./output"
    md_path = Path(path)
    schema_path = Path(schema)

    if not md_path.exists():
        console.print(f"[red]File not found: {path}[/red]")
        raise SystemExit(1)
    if not schema_path.exists():
        console.print(f"[red]Schema not found: {schema}[/red]")
        raise SystemExit(1)

    from .extract import extract_from_markdown

    labels = []
    if model:
        labels.append(f"model: {model}")
    if strategy:
        labels.append(f"strategy: {strategy}")
    label = f" ({', '.join(labels)})" if labels else ""
    console.print(f"\n[bold]Extracting from {md_path.name}{label}...[/bold]\n")
    extract_from_markdown(md_path, schema_path, server_url, output_dir, console, strategy, model)


@app.command()
def logs(
    service: str | None = typer.Argument(None, help="Service name: server, parse, extract, ui, ollama"),
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output"),
    tail: int = typer.Option(100, "--tail", "-t", help="Number of lines to show"),
):
    """Show logs from Koji services."""
    state = load_cluster_state()
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        raise SystemExit(1)

    tail_logs(state, service=service, follow=follow, tail=tail, console=console)


@app.command()
def doctor():
    """Check environment health and report issues."""
    console.print("\n[bold]Koji Doctor[/bold]\n")

    results = run_all_checks()

    status_icons = {
        "pass": "[green]✓[/green]",
        "warn": "[yellow]⚠[/yellow]",
        "fail": "[red]✗[/red]",
    }

    for r in results:
        icon = status_icons[r.status]
        detail = f" {r.detail}" if r.detail else ""
        console.print(f"  {icon} {r.label}{detail}")

    passed = sum(1 for r in results if r.status == "pass")
    warnings = sum(1 for r in results if r.status == "warn")
    failures = sum(1 for r in results if r.status == "fail")

    console.print(f"\n{passed} passed, {warnings} warning, {failures} failed\n")

    if failures > 0:
        raise SystemExit(1)


@app.command()
def version():
    """Show Koji version."""
    console.print("koji 0.1.0")


if __name__ == "__main__":
    app()
