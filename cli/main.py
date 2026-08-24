"""Koji CLI — Documents in. Structured data out."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import typer
from rich.console import Console

from .cluster import (
    cluster_status,
    destroy_cluster,
    get_project_dir,
    load_cluster_state,
    load_project_config,
    start_cluster,
    stop_cluster,
)
from .doctor import run_all_checks
from .init import run_init, run_list_templates
from .logs import tail_logs
from .process import process_file

KOJI_VERSION = "0.110.4"


def _version_callback(value: bool) -> None:
    if value:
        print(f"koji {KOJI_VERSION}")
        raise typer.Exit()


app = typer.Typer(
    name="koji",
    help="Documents in. Structured data out.",
    no_args_is_help=True,
)
console = Console()


def _config_option() -> Any:
    return typer.Option(
        None,
        "--config",
        "-c",
        help="Path to koji.yaml (default: ./koji.yaml)",
    )


def _project_dir_from(config: str | None) -> str | None:
    return get_project_dir(Path(config)) if config else None


def _load_state_or_exit(config: str | None) -> dict:
    state = load_cluster_state(_project_dir_from(config))
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        raise SystemExit(1)
    return state


def _check_http_auth_error(resp: Any, base_url: str) -> bool:
    """If the response is a 401/403, print a helpful auth error and return True."""
    if resp.status_code not in (401, 403):
        return False
    console.print(
        f"\n[red bold]Authentication failed[/red bold] (HTTP {resp.status_code}) against [cyan]{base_url}[/cyan]\n"
    )
    console.print("  Your API key may be invalid, expired, or missing permissions.\n")
    console.print("  To fix:")
    console.print("    • Re-authenticate:  [bold]koji login[/bold]")
    console.print("    • Or set env vars:  [bold]KOJI_API_URL[/bold] + [bold]KOJI_API_KEY[/bold]")
    console.print(f"    • Server tried:     {base_url}")
    console.print()
    return True


@app.callback(invoke_without_command=True)
def main(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """Documents in. Structured data out."""


@app.command()
def init(
    project_dir: str | None = typer.Argument(None, help="Directory name to create (default: current directory)"),
    quickstart: bool = typer.Option(
        False,
        "--quickstart",
        "-q",
        help="Include example schema and sample config (alias for --template invoice)",
    ),
    template: str | None = typer.Option(
        None,
        "--template",
        "-t",
        help="Scaffold from a bundled template (e.g. invoice, insurance, receipt, contract, form)",
    ),
    list_templates: bool = typer.Option(
        False,
        "--list-templates",
        help="List available templates and exit",
    ),
):
    """Scaffold a new Koji project."""
    if list_templates:
        run_list_templates(console)
        return
    run_init(project_dir, quickstart, console, template=template)


@app.command()
def start(
    dev: bool = typer.Option(
        False,
        "--dev",
        help="Build images from local source instead of pulling from ghcr.io/getkoji. For Koji contributors.",
    ),
    clean: bool = typer.Option(
        False,
        "--clean",
        help="Destroy existing data and start fresh (equivalent to koji destroy + koji start).",
    ),
    config: str | None = _config_option(),
):
    """Start the Koji cluster."""
    config_path = Path(config) if config else None
    loaded_config = load_project_config(config_path)
    start_cluster(loaded_config, dev=dev, clean=clean, config_path=config_path)


@app.command()
def stop(
    config: str | None = _config_option(),
):
    """Stop the Koji cluster."""
    stop_cluster(Path(config) if config else None)


@app.command()
def destroy(
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompt"),
    config: str | None = _config_option(),
):
    """Destroy the Koji cluster and delete all data.

    Stops all containers, removes volumes (database, uploads, cache),
    and cleans up the generated compose file. This is irreversible.
    """
    if not force:
        confirm = typer.confirm("This will permanently delete all data. Continue?")
        if not confirm:
            raise SystemExit(0)
    destroy_cluster(Path(config) if config else None)


@app.command()
def status(
    config: str | None = _config_option(),
):
    """Show cluster status."""
    cluster_status(Path(config) if config else None)


@app.command()
def process(
    path: str = typer.Argument(help="Path to a document or directory of documents"),
    schema: str | None = typer.Option(None, "--schema", "-s", help="Path to extraction schema YAML"),
    output: str | None = typer.Option(None, "--output", "-o", help="Output directory (default: ./output/)"),
    config: str | None = _config_option(),
):
    """Process documents through the pipeline."""
    state = _load_state_or_exit(config)

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
    config: str | None = _config_option(),
):
    """Extract structured data from an already-parsed markdown file."""
    state = _load_state_or_exit(config)

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
    service: str | None = typer.Argument(None, help="Service name: server, parse, extract, dashboard, ollama"),
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output"),
    tail: int = typer.Option(100, "--tail", "-t", help="Number of lines to show"),
    config: str | None = _config_option(),
):
    """Show logs from Koji services."""
    state = _load_state_or_exit(config)
    tail_logs(
        state,
        service=service,
        follow=follow,
        tail=tail,
        console=console,
        project_dir=_project_dir_from(config),
    )


@app.command()
def doctor(
    config: str | None = _config_option(),
):
    """Check environment health and report issues."""
    console.print("\n[bold]Koji Doctor[/bold]\n")

    results = run_all_checks(Path(config) if config else None)

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
        httpx.get(f"{server_url}/health", timeout=5)
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
def bench(
    corpus: str = typer.Option(..., "--corpus", "-c", help="Path to corpus repository root"),
    model: str | None = typer.Option(None, "--model", "-m", help="Model to use for extraction"),
    category: str | None = typer.Option(None, "--category", help="Only benchmark one category"),
    limit: int | None = typer.Option(None, "--limit", help="Max documents per category"),
    json_output: bool = typer.Option(False, "--json", help="Output machine-readable JSON"),
    output: str | None = typer.Option(None, "--output", "-o", help="Write JSON results to file"),
    emit_latest: bool = typer.Option(False, "--emit-latest", help="Write results to {corpus}/.benchmarks/latest.json"),
    config: str | None = typer.Option(None, "--config", help="Path to koji.yaml (default: ./koji.yaml)"),
):
    """Benchmark extraction accuracy against a validation corpus.

    Runs extraction against every document in the corpus and compares the
    output against expected ground truth. Reports per-category, per-document,
    and aggregate accuracy.

    Without --model, uses the extract step's model from koji.yaml (the same
    model the cluster runs), falling back to the server default.

    Requires a running Koji cluster (use `koji start` first). Use this to
    measure extraction accuracy before shipping schema changes, to compare
    models, or to produce numbers for the accuracy dashboard.
    """
    import json as json_mod

    import httpx

    from .bench import format_report, run_bench

    corpus_path = Path(corpus).resolve()
    if not corpus_path.is_dir():
        console.print(f"[red]Corpus path not found: {corpus}[/red]")
        raise SystemExit(1)

    # Bench calls the API server (extraction runs in the TS API now).
    # Locally it runs on the server port; prod uses the CLI profile URL.
    from .credentials import get_active_profile

    state = load_cluster_state(_project_dir_from(config))
    if state is not None:
        server_url = f"http://127.0.0.1:{state.get('server_port', 9501)}"
    else:
        profile = get_active_profile()
        if profile:
            server_url = profile.url
        else:
            console.print("[red]No local cluster running and no CLI profile.[/red]")
            console.print("[dim]Run [bold]koji start[/bold] or [bold]koji login[/bold] first.[/dim]")
            raise SystemExit(1)

    # Verify connectivity
    try:
        httpx.get(f"{server_url}/health", timeout=5)
    except (httpx.ConnectError, httpx.ReadTimeout):
        console.print(f"[red]Extract service not reachable at {server_url}[/red]")
        raise SystemExit(1)

    # Without --model, bench runs whatever model the cluster's koji.yaml
    # configures for the extract step, so bench numbers match live behavior.
    if model is None:
        from .bench import model_from_config

        model = model_from_config(Path(config) if config else None)

    if not json_output:
        label_parts = [f"corpus: {corpus_path.name}"]
        if category:
            label_parts.append(f"category: {category}")
        if model:
            label_parts.append(f"model: {model}")
        if limit:
            label_parts.append(f"limit: {limit}/category")
        console.print(f"\n[bold]koji bench[/bold] — {', '.join(label_parts)}\n")

    def progress(cat: str, i: int, total: int, doc: str) -> None:
        if not json_output:
            console.print(f"  [dim]({cat} {i}/{total}) {doc}[/dim]")

    with httpx.Client() as client:
        result = run_bench(
            corpus_root=corpus_path,
            server_url=server_url,
            model=model,
            http_client=client,
            category_filter=category,
            document_limit=limit,
            progress_callback=progress if not json_output else None,
        )

    # Emit the report
    if json_output:
        console.print(json_mod.dumps(result.to_dict(), indent=2))
    else:
        console.print(format_report(result))

    # Optional file output (always JSON, for CI consumption)
    if output:
        Path(output).write_text(json_mod.dumps(result.to_dict(), indent=2) + "\n")
        if not json_output:
            console.print(f"[dim]Results written to {output}[/dim]")

    # Emit latest: write results to {corpus}/.benchmarks/latest.json
    if emit_latest:
        benchmarks_dir = corpus_path / ".benchmarks"
        benchmarks_dir.mkdir(exist_ok=True)
        latest_path = benchmarks_dir / "latest.json"
        latest_path.write_text(json_mod.dumps(result.to_dict(), indent=2) + "\n")
        if not json_output:
            console.print(f"[dim]Latest results written to {latest_path}[/dim]")

    # Exit code reflects pass/fail
    if not result.all_passed:
        raise SystemExit(1)


@app.command(name="db:reset")
def db_reset(
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompt"),
):
    """Drop and recreate the database, then re-apply the schema."""
    import subprocess as sp

    if not force:
        confirm = typer.confirm("This will destroy all data. Continue?")
        if not confirm:
            raise SystemExit(0)

    db_url = _get_db_url()
    if not db_url:
        console.print("[red]DATABASE_URL not set. Export it or add it to .env.[/red]")
        raise SystemExit(1)

    # Parse connection info from DATABASE_URL
    # Format: postgres://user:pass@host:port/dbname
    import re

    m = re.match(r"postgres(?:ql)?://([^:]+):([^@]+)@([^:]+):(\d+)/(.+)", db_url)
    if not m:
        console.print(f"[red]Could not parse DATABASE_URL: {db_url}[/red]")
        raise SystemExit(1)

    user, password, host, port, dbname = m.groups()
    env = {**__import__("os").environ, "PGPASSWORD": password}
    psql = ["psql", "-h", host, "-p", port, "-U", user]

    console.print(f"  Dropping [bold]{dbname}[/bold]...")
    sp.run(
        [*psql, "-d", "postgres", "-c", f'DROP DATABASE IF EXISTS "{dbname}";'],
        env=env,
        capture_output=True,
    )

    console.print(f"  Creating [bold]{dbname}[/bold]...")
    result = sp.run(
        [*psql, "-d", "postgres", "-c", f'CREATE DATABASE "{dbname}";'],
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        console.print(f"[red]Failed to create database: {result.stderr.strip()}[/red]")
        raise SystemExit(1)

    console.print("  Pushing schema...")
    # Find the db package relative to the CLI
    db_pkg = Path(__file__).resolve().parent.parent / "packages" / "db"
    if not db_pkg.exists():
        console.print("[yellow]Could not find packages/db — skipping schema push.[/yellow]")
        console.print("[dim]Run drizzle-kit push manually.[/dim]")
    else:
        result = sp.run(
            ["npx", "drizzle-kit", "push", "--force"],
            cwd=str(db_pkg),
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            console.print(f"[red]Schema push failed: {result.stderr.strip()}[/red]")
            raise SystemExit(1)

    console.print("\n[green]✓[/green] Database reset. Visit /setup to create a new account.\n")


def _get_db_url() -> str | None:
    """Read DATABASE_URL from environment or .env file."""
    import os

    url = os.environ.get("DATABASE_URL")
    if url:
        return url

    # Try loading from .env at repo root
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


@app.command()
def login(
    server_url: str = typer.Argument(
        None,
        help="Server URL (default: https://console.getkoji.dev)",
    ),
    api_key: str | None = typer.Option(
        None,
        "--api-key",
        "-k",
        help="API key for headless/CI auth (skip browser flow)",
    ),
    profile: str | None = typer.Option(
        None,
        "--profile",
        "-p",
        help="Profile name (default: derived from server URL)",
    ),
    project: str | None = typer.Option(
        None,
        "--project",
        help="Default project slug for this profile",
    ),
):
    """Authenticate the CLI with a Koji server.

    Opens your browser to approve API key creation. For CI/headless
    environments, pass --api-key directly.
    """
    from .credentials import Profile, load_credentials

    DEFAULT_SERVER = "https://console.getkoji.dev"

    if api_key:
        # Direct key — headless mode
        url = server_url or DEFAULT_SERVER
        name = profile or _derive_profile_name(url)

        creds = load_credentials()
        creds.profiles[name] = Profile(url=url, api_key=api_key, project=project)
        creds.current = name
        creds.save()

        console.print(f"\n[green]✓[/green] Authenticated as profile [bold]{name}[/bold]")
        console.print(f"  Server: {url}")
        if project:
            console.print(f"  Project: {project}")
        console.print()
        return

    # Browser flow
    url = (server_url or DEFAULT_SERVER).rstrip("/")
    name = profile or _derive_profile_name(url)

    import http.server
    import secrets
    import socket
    import threading
    import webbrowser

    # Find a free port for the callback
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        callback_port = s.getsockname()[1]

    state = secrets.token_urlsafe(32)
    received_key: list[str] = []
    server_done = threading.Event()

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            from urllib.parse import parse_qs, urlparse

            qs = parse_qs(urlparse(self.path).query)

            if qs.get("state", [None])[0] != state:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Invalid state parameter")
                return

            key = qs.get("key", [None])[0]
            if not key:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"No API key received")
                return

            received_key.append(key)

            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"""
                <html><body style="font-family:system-ui;text-align:center;padding:60px;">
                <h2>Authenticated!</h2>
                <p>You can close this window and return to the terminal.</p>
                </body></html>
            """)
            server_done.set()

        def log_message(self, format: str, *args: object) -> None:
            pass  # suppress noisy logs

    callback_url = f"http://127.0.0.1:{callback_port}/callback"
    authorize_url = f"{url}/cli/authorize?callback={callback_url}&state={state}"

    console.print("\n  Opening browser to authorize CLI...\n")
    console.print(f"  [dim]{authorize_url}[/dim]\n")
    webbrowser.open(authorize_url)

    httpd = http.server.HTTPServer(("127.0.0.1", callback_port), CallbackHandler)
    httpd.timeout = 120

    # Wait for callback
    thread = threading.Thread(target=lambda: httpd.handle_request(), daemon=True)
    thread.start()

    with console.status("Waiting for browser authorization...", spinner="dots"):
        server_done.wait(timeout=120)

    if not received_key:
        console.print("[red]Timed out waiting for authorization.[/red]")
        raise SystemExit(1)

    creds = load_credentials()
    creds.profiles[name] = Profile(url=url, api_key=received_key[0], project=project)
    creds.current = name
    creds.save()

    console.print(f"[green]✓[/green] Authenticated as profile [bold]{name}[/bold]")
    console.print(f"  Server: {url}")
    console.print(f"  Key: {received_key[0][:12]}...{received_key[0][-4:]}")
    console.print()


@app.command()
def use(
    profile_name: str = typer.Argument(help="Profile name to switch to"),
):
    """Switch the active CLI profile."""
    from .credentials import load_credentials

    creds = load_credentials()
    if profile_name not in creds.profiles:
        console.print(f"[red]Profile '{profile_name}' not found.[/red]")
        names = ", ".join(creds.profiles.keys()) or "(none)"
        console.print(f"  Available: {names}")
        raise SystemExit(1)

    creds.current = profile_name
    creds.save()

    p = creds.profiles[profile_name]
    console.print(f"\n[green]✓[/green] Switched to profile [bold]{profile_name}[/bold]")
    console.print(f"  Server: {p.url}")
    if p.project:
        console.print(f"  Project: {p.project}")
    console.print()


@app.command()
def whoami():
    """Show the current CLI profile and server."""
    from .credentials import load_credentials, verify_profile_connectivity

    creds = load_credentials()
    p = creds.active_profile()

    if not p:
        console.print("[yellow]Not logged in. Run [bold]koji login <url>[/bold] first.[/yellow]")
        raise SystemExit(1)

    console.print(f"\n  Profile: [bold]{creds.current}[/bold]")
    console.print(f"  Server:  {p.url}")
    console.print(f"  Key:     {p.api_key[:12]}...{p.api_key[-4:]}")
    if p.project:
        console.print(f"  Project: {p.project}")

    ok, msg = verify_profile_connectivity(p)
    if ok:
        console.print(f"  Status:  [green]✓ {msg}[/green]")
    else:
        console.print(f"  Status:  [red]✗ {msg}[/red]")

    console.print()


@app.command()
def profiles():
    """List all saved CLI profiles."""
    from .credentials import load_credentials

    creds = load_credentials()
    if not creds.profiles:
        console.print("[yellow]No profiles saved. Run [bold]koji login <url>[/bold] first.[/yellow]")
        return

    console.print()
    for name, p in creds.profiles.items():
        marker = "[green]●[/green]" if name == creds.current else " "
        console.print(f"  {marker} [bold]{name}[/bold]  {p.url}  {p.api_key[:12]}...")
    console.print()


def _derive_profile_name(url: str) -> str:
    """Derive a profile name from a server URL."""
    from urllib.parse import urlparse

    host = urlparse(url).hostname or "default"
    # localhost → "local", koji.acme.internal → "acme"
    if host in ("localhost", "127.0.0.1"):
        return "local"
    parts = host.split(".")
    if len(parts) >= 2:
        return parts[-2] if parts[-1] in ("com", "dev", "io", "internal", "local") else parts[0]
    return parts[0]


def push_version_line(kind: str, slug: str, payload: dict, *, released: bool) -> str:
    """One result line for a pushed version.

    `koji push` used to print "updated to v?" for every outcome: it read a
    `versionNumber` key neither endpoint returns, and "updated" covered a real
    new version, a no-op, and a live-pointer move alike. This reports what the
    API actually said — `action` (see the release-actions table in the API
    reference) plus the semver label the endpoint returned.
    """
    label = payload.get("version") or payload.get("released") or "?"
    if not isinstance(label, str):  # `released: true` on the release path
        label = payload.get("version") or "?"
    action = payload.get("action")

    if action == "unchanged":
        return f"  [dim]—[/dim] \\[{kind}] {slug} — unchanged ({label} already live)"
    if action == "reactivated":
        prev = (payload.get("displaced") or {}).get("label", "?")
        return f"  [yellow]![/yellow] \\[{kind}] {slug} — live release moved {prev} → {label}"
    if not released:
        deduped = " (existing)" if payload.get("deduped") else ""
        return (
            f"  [green]✓[/green] \\[{kind}] {slug} — candidate {label}{deduped} "
            f"[dim](not live — koji {kind} promote {slug})[/dim]"
        )
    if action == "created":
        return f"  [green]✓[/green] \\[{kind}] {slug} — released {label} (live)"
    return f"  [green]✓[/green] \\[{kind}] {slug} — {label} (live)"


def push_error_line(kind: str, slug: str, status: int, payload: dict, text: str) -> str:
    """One result line for a failed push, including the rollback refusal."""
    if payload.get("reason") == "requires_reactivate":
        matched = payload.get("matched_version", "?")
        current = payload.get("current_version", "?")
        direction = payload.get("direction", "")
        arrow = "would ROLL BACK" if direction == "backward" else "would move"
        return (
            f"  [red]✗[/red] \\[{kind}] {slug} — this content is already {matched}; "
            f"publishing it {arrow} the live release {current} → {matched}. "
            f"[dim]Promote {matched} deliberately, or commit a change on top of {current}.[/dim]"
        )
    error = payload.get("error") or payload.get("details") or text[:200] or f"HTTP {status}"
    return f"  [red]✗[/red] \\[{kind}] {slug} — {error}"


def _report_push_version(console_, kind: str, slug: str, payload: dict, *, released: bool) -> None:
    console_.print(push_version_line(kind, slug, payload, released=released))


def _report_push_error(console_, kind: str, slug: str, resp) -> None:
    try:
        payload = resp.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    console_.print(push_error_line(kind, slug, resp.status_code, payload, getattr(resp, "text", "") or ""))


def _push_kind(parsed: dict, path: Path, root: Path) -> str | None:
    """Which artifact kind a push file is.

    An explicit `kind:` always wins. Otherwise the **subdirectory** decides —
    `push` already searches `schemas/`, `pipelines/`, and `classifiers/`, so a
    classifier sitting in `classifiers/` without a `kind:` field used to be
    created as a *schema*, silently making the wrong artifact. Files at the
    root with no `kind:` stay schemas (backward compat).

    Returns None for an unrecognized explicit kind, which the caller skips.
    """
    kind = parsed.get("kind")
    if kind is not None:
        return str(kind) if kind in ("schema", "pipeline", "classifier") else None

    try:
        parent = path.parent.resolve().name if path.parent.resolve() != root.resolve() else ""
    except OSError:  # pragma: no cover - resolve() on an odd path
        parent = path.parent.name
    if parent == "classifiers":
        return "classifier"
    if parent == "pipelines":
        return "pipeline"
    return "schema"


def _push_slug(kind: str, parsed: dict, path: Path) -> str:
    """The slug a push file targets — how `--only` matches, and what's shown."""
    if kind == "schema":
        return str(parsed.get("name") or path.stem)
    if kind == "classifier":
        return str(parsed.get("slug") or parsed.get("name") or path.stem)
    return str(parsed.get("slug") or path.stem)


def _push_selected(kind: str, slug: str, kind_filter: str | None, only: list[str] | None) -> bool:
    """Does this file pass the --kind / --only scope filters?"""
    if kind_filter and kind != kind_filter:
        return False
    if only and slug not in only:
        return False
    return True


def _pipeline_yaml_body(parsed: dict, raw: str) -> str | None:
    """Build the YAML body `koji push` sends for a `kind: pipeline` file.

    Only DAG definitions (files with a `steps:` list) carry YAML — the simple
    shorthand (`schema: <name>` with no steps) stays a schema-linked simple
    pipeline. The raw file text is sent verbatim (never re-serialized: PyYAML
    is YAML 1.1 and corrupts bare keys like `on:` into booleans on round-trip;
    the server compiles YAML 1.2 where they're plain strings). The compiler
    requires a top-level `pipeline:` name and ignores the push-file envelope
    keys (`kind`, `slug`, `name`), so the name is prepended when missing.
    """
    import json as json_mod

    if not isinstance(parsed.get("steps"), list):
        return None
    if "pipeline" in parsed:
        return raw
    name = str(parsed.get("name") or parsed.get("slug") or "pipeline")
    return f"pipeline: {json_mod.dumps(name)}\n{raw}"


@app.command()
def push(
    directory: str = typer.Option(".", "--dir", "-d", help="Directory containing YAML files (schemas/, pipelines/)"),
    message: str = typer.Option(None, "--message", "-m", help="Commit message for schema versions"),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use"),
    only: list[str] = typer.Option(
        None, "--only", help="Push only these slugs (repeatable). Default: every file found."
    ),
    kind_filter: str = typer.Option(None, "--kind", help="Push only this kind: schema | pipeline | classifier."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show what would change; write nothing."),
    release: bool = typer.Option(
        False,
        "--release",
        help="Release updates to EXISTING artifacts live. Without it, updates are staged as candidates.",
    ),
):
    """Push local YAML files to the Koji platform.

    Reads .yaml files from the directory and pushes them based on their `kind`
    field: schemas go to /api/schemas, pipelines go to /api/pipelines,
    classifiers go to /api/classifiers. Searches the directory root and the
    schemas/, pipelines/, and classifiers/ subdirectories.

    Files without a `kind` field are assumed to be schemas (backward compat),
    EXCEPT under classifiers/ or pipelines/, where the subdirectory decides.
    Files with an unrecognized `kind` are skipped with a warning.

    Scope a push with --only <slug> (repeatable) and/or --kind, and preview it
    with --dry-run.

    Updating an artifact that already exists stages a CANDIDATE; it does not go
    live until you promote it (or pass --release). Creating a brand-new artifact
    still releases v0.0.1, since there is no live version to displace.
    """
    import httpx
    import yaml as yaml_mod

    from .remote import note_resolved_project, resolve_api

    # One resolver for every remote command. Push and pull each grew their own
    # copy of this, and they drifted: pull's never sent `x-koji-project` at all
    # (oss-491). Scope is the thing you least want two implementations of.
    base_url, headers = resolve_api(profile_name)

    # Collect YAML files from the directory and common subdirectories
    root = Path(directory)
    if not root.is_dir():
        console.print(f"[red]Directory not found: {directory}[/red]")
        raise SystemExit(1)

    yaml_files: list[Path] = []
    for search_dir in [root, root / "schemas", root / "pipelines", root / "classifiers"]:
        if search_dir.is_dir():
            yaml_files.extend(sorted(search_dir.glob("*.yaml")))
            yaml_files.extend(sorted(search_dir.glob("*.yml")))
    # Deduplicate (in case root == schemas/)
    yaml_files = list(dict.fromkeys(yaml_files))

    if not yaml_files:
        console.print(f"[yellow]No .yaml files found in {directory}[/yellow]")
        raise SystemExit(0)

    # Parse all files and group by kind
    schemas: list[tuple[Path, dict, str]] = []  # (path, parsed, raw_yaml)
    pipelines: list[tuple[Path, dict, str]] = []
    classifiers: list[tuple[Path, dict, str]] = []
    skipped: list[tuple[Path, str]] = []  # (path, unrecognized kind)

    if kind_filter and kind_filter not in ("schema", "pipeline", "classifier"):
        console.print(f"[red]Unknown --kind '{kind_filter}' — use schema, pipeline, or classifier.[/red]")
        raise SystemExit(1)

    only_list = list(only) if only else []
    deselected = 0

    for yaml_path in yaml_files:
        raw = yaml_path.read_text()
        try:
            parsed = yaml_mod.safe_load(raw) or {}
        except Exception:
            console.print(f"  [red]✗[/red] {yaml_path.name} — invalid YAML")
            continue

        kind = _push_kind(parsed, yaml_path, root)
        if kind is None:
            skipped.append((yaml_path, str(parsed.get("kind"))))
            continue

        slug = _push_slug(kind, parsed, yaml_path)
        if not _push_selected(kind, slug, kind_filter, only_list):
            deselected += 1
            continue

        if kind == "pipeline":
            pipelines.append((yaml_path, parsed, raw))
        elif kind == "classifier":
            classifiers.append((yaml_path, parsed, raw))
        else:
            schemas.append((yaml_path, parsed, raw))

    scope_bits = []
    if kind_filter:
        scope_bits.append(f"--kind {kind_filter}")
    if only_list:
        scope_bits.append("--only " + ",".join(only_list))
    scope = f" [{' '.join(scope_bits)}]" if scope_bits else ""
    mode = " [yellow](dry run — nothing will be written)[/yellow]" if dry_run else ""

    console.print(
        f"\n[bold]koji push[/bold]{scope} — {len(schemas)} schema(s), {len(pipelines)} pipeline(s), "
        f"{len(classifiers)} classifier(s) → {base_url}{mode}\n"
    )
    if deselected:
        console.print(f"  [dim]{deselected} file(s) not selected by the scope filters[/dim]\n")

    if only_list:
        found = {
            _push_slug(k, pr, pa)
            for k, group in (("schema", schemas), ("pipeline", pipelines), ("classifier", classifiers))
            for pa, pr, _ in group
        }
        for wanted in only_list:
            if wanted not in found:
                console.print(f"  [yellow]![/yellow] --only {wanted} — no matching file found")

    if dry_run:
        for label, group in (("schema", schemas), ("classifier", classifiers), ("pipeline", pipelines)):
            for yaml_path, parsed, _raw in group:
                slug = _push_slug(label, parsed, yaml_path)
                console.print(f"  [cyan]would push[/cyan] \\[{label}] {slug} [dim]({yaml_path.name})[/dim]")
        if not (schemas or classifiers or pipelines):
            console.print("  [dim]nothing selected[/dim]")
        verb = "released live" if release else "staged as candidates"
        console.print(f"\n[dim]Updates to existing artifacts would be {verb}.[/dim]")
        for yaml_path, kind_str in skipped:
            console.print(f"  [yellow]skipped[/yellow] {yaml_path.name} — unrecognized kind: {kind_str}")
        raise SystemExit(0)

    with httpx.Client(timeout=30) as client:
        # ── Push schemas ──
        for yaml_path, parsed, yaml_content in schemas:
            slug = parsed.get("name", yaml_path.stem)
            display_name = parsed.get("name", slug)

            resp = client.get(f"{base_url}/api/schemas/{slug}", headers=headers)
            note_resolved_project(resp)

            if _check_http_auth_error(resp, base_url):
                raise SystemExit(1)

            if resp.status_code == 200:
                existing = resp.json()
                existing_yaml = existing.get("latestVersion", {}).get("yamlSource", "")

                if existing_yaml.strip() == yaml_content.strip():
                    console.print(
                        f"  [dim]—[/dim] \\[schema] {slug} — unchanged (v{existing.get('latestVersion', {}).get('versionNumber', '?')})"
                    )
                    continue

                resp = client.post(
                    f"{base_url}/api/schemas/{slug}/versions",
                    json={
                        "yaml": yaml_content,
                        "commit_message": message or f"koji push from {yaml_path.name}",
                        # Updating something already live stages a candidate unless
                        # the user explicitly asked to release.
                        "candidate": not release,
                    },
                    headers=headers,
                )
                if resp.status_code == 201:
                    _report_push_version(console, "schema", slug, resp.json(), released=release)
                else:
                    _report_push_error(console, "schema", slug, resp)
            elif resp.status_code == 404:
                resp = client.post(
                    f"{base_url}/api/schemas",
                    json={"slug": slug, "display_name": display_name, "initial_yaml": yaml_content},
                    headers=headers,
                )
                if resp.status_code == 201:
                    console.print(f"  [green]✓[/green] \\[schema] {slug} — created (v0.0.1, live)")
                else:
                    error = resp.json().get("error", resp.text[:200])
                    console.print(f"  [red]✗[/red] \\[schema] {slug} — {error}")
            else:
                console.print(f"  [red]✗[/red] \\[schema] {slug} — HTTP {resp.status_code}")

        # ── Push classifiers ──
        # Before pipelines: a pipeline's `classifier: <slug>` step reference
        # resolves at run time, but pushing classifiers first means a fresh
        # `koji push` of a whole project leaves the referenced classifier in
        # place the first time the pipeline runs.
        for yaml_path, parsed, yaml_content in classifiers:
            slug = parsed.get("slug", parsed.get("name", yaml_path.stem))
            display_name = parsed.get("display_name", parsed.get("name", slug))
            description = parsed.get("description")

            resp = client.get(f"{base_url}/api/classifiers/{slug}", headers=headers)
            note_resolved_project(resp)

            if resp.status_code == 200:
                existing_yaml = resp.json().get("latestVersion", {}).get("yamlSource", "") or ""
                if existing_yaml.strip() == yaml_content.strip():
                    ver = resp.json().get("latestVersion", {}).get("version", "?")
                    console.print(f"  [dim]—[/dim] \\[classifier] {slug} — unchanged ({ver})")
                    continue
                resp = client.post(
                    f"{base_url}/api/classifiers/{slug}/versions",
                    json={
                        "yaml": yaml_content,
                        "commit_message": message or f"koji push from {yaml_path.name}",
                        "candidate": not release,
                    },
                    headers={**headers, "Content-Type": "application/json"},
                )
                if resp.status_code in (200, 201):
                    _report_push_version(console, "classifier", slug, resp.json(), released=release)
                else:
                    _report_push_error(console, "classifier", slug, resp)
            elif resp.status_code == 404:
                create_body: dict = {"slug": slug, "display_name": display_name, "initial_yaml": yaml_content}
                if description:
                    create_body["description"] = description
                resp = client.post(
                    f"{base_url}/api/classifiers",
                    json=create_body,
                    headers={**headers, "Content-Type": "application/json"},
                )
                if resp.status_code in (200, 201):
                    console.print(f"  [green]✓[/green] \\[classifier] {slug} — created")
                else:
                    error = resp.json().get("error", resp.json().get("details", resp.text[:200]))
                    console.print(f"  [red]✗[/red] \\[classifier] {slug} — {error}")
            else:
                console.print(f"  [red]✗[/red] \\[classifier] {slug} — HTTP {resp.status_code}")

        # ── Resolve schema name → ID lookup (needed for pipeline.schema) ──
        schema_id_map: dict[str, str] = {}
        if pipelines:
            resp = client.get(f"{base_url}/api/schemas", headers=headers)
            if resp.status_code == 200:
                for s in resp.json().get("data", []):
                    schema_id_map[s["slug"]] = s["id"]

            # Also resolve model provider (use first active)
            model_provider_id = None
            resp = client.get(f"{base_url}/api/model-providers", headers=headers)
            if resp.status_code == 200:
                providers = resp.json().get("data", [])
                if providers:
                    model_provider_id = providers[0]["id"]

        # ── Push pipelines ──
        for yaml_path, parsed, yaml_content in pipelines:
            slug = parsed.get("slug", yaml_path.stem)
            display_name = parsed.get("name", slug)
            schema_ref = parsed.get("schema")  # schema name/slug reference
            schema_id = schema_id_map.get(schema_ref) if schema_ref else None
            pipeline_yaml = _pipeline_yaml_body(parsed, yaml_content)

            resp = client.get(f"{base_url}/api/pipelines/{slug}", headers=headers)

            if resp.status_code == 200:
                # Pipeline exists — update it
                patch_body: dict = {"name": display_name}
                if schema_id:
                    patch_body["schema_id"] = schema_id
                if model_provider_id:
                    patch_body["model_provider_id"] = model_provider_id
                if pipeline_yaml is not None:
                    patch_body["yaml"] = pipeline_yaml

                resp = client.patch(
                    f"{base_url}/api/pipelines/{slug}",
                    json=patch_body,
                    headers={**headers, "Content-Type": "application/json"},
                )
                if resp.status_code == 200:
                    console.print(f"  [green]✓[/green] \\[pipeline] {slug} — updated")
                else:
                    error = resp.json().get("error", resp.text[:200])
                    console.print(f"  [red]✗[/red] \\[pipeline] {slug} — {error}")
            elif resp.status_code == 404:
                # Create pipeline
                create_body: dict = {"name": display_name, "slug": slug}
                if schema_id:
                    create_body["schema_id"] = schema_id
                if model_provider_id:
                    create_body["model_provider_id"] = model_provider_id
                if pipeline_yaml is not None:
                    create_body["yaml"] = pipeline_yaml

                resp = client.post(
                    f"{base_url}/api/pipelines",
                    json=create_body,
                    headers={**headers, "Content-Type": "application/json"},
                )
                if resp.status_code == 201:
                    schema_note = f" → {schema_ref}" if schema_ref else ""
                    console.print(f"  [green]✓[/green] \\[pipeline] {slug} — created{schema_note}")
                else:
                    error = resp.json().get("error", resp.text[:200])
                    console.print(f"  [red]✗[/red] \\[pipeline] {slug} — {error}")
            else:
                console.print(f"  [red]✗[/red] \\[pipeline] {slug} — HTTP {resp.status_code}")

    # Surface files that were seen but skipped for an unrecognized `kind` — a
    # silent "0 pushed" otherwise reads as "nothing to do" when the real cause
    # is a typo'd or unsupported kind.
    if skipped:
        console.print()
        kinds = sorted({k for _, k in skipped})
        console.print(f"[yellow]Skipped {len(skipped)} file(s) with unhandled kind: {', '.join(kinds)}[/yellow]")
        for path, kind in skipped:
            console.print(f"  [dim]—[/dim] {path.name} (kind: {kind})")

    console.print()


@app.command()
def pull(
    output_dir: str = typer.Option("./schemas", "--output", "-o", help="Directory to write schema YAML files"),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use"),
):
    """Pull schemas from the Koji platform to local YAML files.

    Downloads the latest version of every schema and writes them to the
    output directory. Existing files are overwritten.

    Pulls from the project the profile (or KOJI_PROJECT) names, and says which
    project answered.
    """
    import httpx

    from .remote import note_resolved_project, resolve_api

    # Shared with every other remote command, which is the point: pull built its
    # own headers and never sent `x-koji-project`, so it silently read the API
    # key's own project no matter which project the profile selected. Against a
    # key bound elsewhere it wrote a different project's schemas into your
    # working directory and reported success (oss-491).
    base_url, headers = resolve_api(profile_name)

    # Get all schemas
    resp = httpx.get(f"{base_url}/api/schemas", headers=headers, timeout=30)
    note_resolved_project(resp)
    if _check_http_auth_error(resp, base_url):
        raise SystemExit(1)
    if resp.status_code != 200:
        console.print(f"[red]Failed to list schemas: HTTP {resp.status_code}[/red]")
        raise SystemExit(1)

    schemas = resp.json().get("data", [])
    if not schemas:
        console.print("[yellow]No schemas found on the server.[/yellow]")
        raise SystemExit(0)

    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    console.print(f"\n[bold]koji pull[/bold] — {len(schemas)} schema(s) → {output_dir}/\n")

    with httpx.Client(timeout=30) as client:
        for s in schemas:
            slug = s["slug"]
            resp = client.get(f"{base_url}/api/schemas/{slug}", headers=headers)
            if resp.status_code != 200:
                console.print(f"  [red]✗[/red] {slug} — HTTP {resp.status_code}")
                continue

            detail = resp.json()
            yaml_source = detail.get("latestVersion", {}).get("yamlSource")
            if not yaml_source:
                console.print(f"  [yellow]—[/yellow] {slug} — no published version")
                continue

            file_path = out_path / f"{slug}.yaml"
            file_path.write_text(yaml_source)
            ver = detail.get("latestVersion", {}).get("versionNumber", "?")
            console.print(f"  [green]✓[/green] {slug}.yaml (v{ver})")

    console.print()


@app.command()
def version():
    """Show Koji version."""
    console.print(f"koji {KOJI_VERSION}")


# ── Remote platform loop: validate / run / corpus / review / schema ───
# These talk to a running Koji platform (the same API the dashboard's Build,
# Validate, Corpus, and Review tabs use). Implementations live in cli/remote.py.
from .remote import (  # noqa: E402
    classify_app,
    corpus_app,
    pipeline_app,
    project_app,
    review_app,
    run_doc,
    schema_app,
    validate,
)

app.command(name="validate")(validate)
app.command(name="run")(run_doc)
app.add_typer(corpus_app, name="corpus")
app.add_typer(review_app, name="review")
app.add_typer(schema_app, name="schema")
app.add_typer(pipeline_app, name="pipeline")
app.add_typer(classify_app, name="classify")
app.add_typer(project_app, name="project")


if __name__ == "__main__":
    app()
