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
    quickstart: bool = typer.Option(False, "--quickstart", "-q", help="Include example schema and sample config"),
):
    """Scaffold a new Koji project."""
    run_init(project_dir, quickstart, console)


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
def test(
    schema: str = typer.Option(..., "--schema", "-s", help="Path to extraction schema YAML"),
    model: str | None = typer.Option(None, "--model", "-m", help="Model to use for extraction"),
    update: bool = typer.Option(False, "--update", help="Snapshot mode: save extraction output as new expected files"),
    json_output: bool = typer.Option(False, "--json", help="Output machine-readable JSON results"),
    strategy: str | None = typer.Option(None, "--strategy", help="Extraction strategy: parallel (default) or agent"),
):
    """Run extraction regression tests against fixture files."""
    import json as json_mod

    import httpx
    import yaml

    from .test_runner import (
        FixtureResult,
        TestSuiteResult,
        compare_results,
        discover_fixtures,
    )

    schema_path = Path(schema)
    if not schema_path.exists():
        console.print(f"[red]Schema not found: {schema}[/red]")
        raise SystemExit(1)

    fixtures = discover_fixtures(schema_path)
    if not fixtures and not update:
        fixtures_dir = schema_path.parent / (schema_path.stem + ".fixtures")
        console.print(f"[red]No fixtures found. Expected directory: {fixtures_dir}/[/red]")
        console.print("[dim]Create .md fixture files and run with --update to generate expected outputs.[/dim]")
        raise SystemExit(1)
    if not fixtures:
        fixtures_dir = schema_path.parent / (schema_path.stem + ".fixtures")
        console.print(f"[red]No .md fixture files found in {fixtures_dir}/[/red]")
        raise SystemExit(1)

    # Load schema name
    schema_def = yaml.safe_load(schema_path.read_text())
    schema_name = schema_def.get("name", schema_path.stem)

    # Check cluster is running
    state = load_cluster_state()
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        console.print("[dim]The test command needs a running cluster to call the extract API.[/dim]")
        raise SystemExit(1)

    server_url = f"http://127.0.0.1:{state['server_port']}"

    # Verify connectivity
    try:
        httpx.get(f"{server_url}/api/health", timeout=5)
    except (httpx.ConnectError, httpx.ReadTimeout):
        console.print("[red]Cluster is not reachable. Run [bold]koji start[/bold] and wait for services.[/red]")
        raise SystemExit(1)

    schema_content = schema_path.read_text()
    suite = TestSuiteResult(schema_name=schema_name)

    if not json_output:
        console.print(f"\n[bold]koji test[/bold] — {schema_name} ({len(fixtures)} fixtures)\n")

    for md_path, expected_path in fixtures:
        fixture_result = FixtureResult(fixture_name=md_path.name)

        # Run extraction
        markdown = md_path.read_text()
        payload: dict = {"markdown": markdown, "schema": schema_content}
        if model:
            payload["model"] = model
        if strategy:
            payload["strategy"] = strategy

        try:
            if not json_output:
                status_msg = f"  Extracting {md_path.name}..."
                with console.status(status_msg, spinner="dots"):
                    resp = httpx.post(f"{server_url}/api/extract", json=payload, timeout=1800)
            else:
                resp = httpx.post(f"{server_url}/api/extract", json=payload, timeout=1800)
        except httpx.ConnectError:
            fixture_result.error = "server unreachable"
            suite.fixture_results.append(fixture_result)
            if not json_output:
                console.print(f"  [red]x[/red] {md_path.name} — server unreachable")
            continue
        except httpx.ReadTimeout:
            fixture_result.error = "timeout"
            suite.fixture_results.append(fixture_result)
            if not json_output:
                console.print(f"  [red]x[/red] {md_path.name} — timeout")
            continue

        if resp.status_code != 200:
            try:
                error = resp.json().get("error", "Unknown error")
            except Exception:
                error = resp.text[:200] or f"HTTP {resp.status_code}"
            fixture_result.error = str(error)
            suite.fixture_results.append(fixture_result)
            if not json_output:
                console.print(f"  [red]x[/red] {md_path.name} — {error}")
            continue

        result = resp.json()
        actual = result.get("extracted", result)

        # --update mode: save and move on
        if update:
            save_path = md_path.parent / (md_path.stem + ".expected.json")
            save_path.write_text(json_mod.dumps(actual, indent=2) + "\n")
            if not json_output:
                console.print(f"  [green]>[/green] {md_path.name} → {save_path.name}")
            suite.fixture_results.append(fixture_result)
            continue

        # Compare mode
        if expected_path is None:
            fixture_result.error = "no .expected.json file (run with --update to create)"
            suite.fixture_results.append(fixture_result)
            if not json_output:
                console.print(f"  [yellow]?[/yellow] {md_path.name} — no .expected.json (run with --update)")
            continue

        expected = json_mod.loads(expected_path.read_text())
        field_results = compare_results(expected, actual)
        fixture_result.field_results = field_results
        suite.fixture_results.append(fixture_result)

        if not json_output:
            console.print(f"  {md_path.name}")
            for r in field_results:
                if r.passed:
                    console.print(f"    [green]✓[/green] {r.field_name}: {r.expected}")
                else:
                    console.print(f"    [red]✗[/red] {r.field_name}: {r.detail}")

    # Summary
    if update:
        if not json_output:
            console.print(f"\n{len(fixtures)} fixtures updated\n")
        else:
            console.print(json_mod.dumps({"updated": len(fixtures)}))
        return

    if json_output:
        console.print(json_mod.dumps(suite.to_dict(), indent=2))
    else:
        console.print(
            f"\n{suite.total_fixtures} fixtures, {suite.total_fields} fields checked, "
            f"{suite.total_passed} passed, {suite.total_failed} regressions\n"
        )

    if not suite.all_passed:
        raise SystemExit(1)


@app.command()
def version():
    """Show Koji version."""
    console.print("koji 0.1.0")


if __name__ == "__main__":
    app()
