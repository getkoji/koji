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
from .init import run_init, run_list_templates
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
):
    """Start the Koji cluster."""
    config = load_project_config()
    start_cluster(config, dev=dev)


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
):
    """Benchmark extraction accuracy against a validation corpus.

    Runs extraction against every document in the corpus and compares the
    output against expected ground truth. Reports per-category, per-document,
    and aggregate accuracy.

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

    state = load_cluster_state()
    if state is None:
        console.print("[red]No cluster running. Run [bold]koji start[/bold] first.[/red]")
        console.print("[dim]koji bench needs a running cluster to call the extract API.[/dim]")
        raise SystemExit(1)

    server_url = f"http://127.0.0.1:{state['server_port']}"

    # Verify connectivity
    try:
        httpx.get(f"{server_url}/health", timeout=5)
    except (httpx.ConnectError, httpx.ReadTimeout):
        console.print("[red]Cluster not reachable. Run [bold]koji start[/bold] and wait for services.[/red]")
        raise SystemExit(1)

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
        env=env, capture_output=True,
    )

    console.print(f"  Creating [bold]{dbname}[/bold]...")
    result = sp.run(
        [*psql, "-d", "postgres", "-c", f'CREATE DATABASE "{dbname}";'],
        env=env, capture_output=True, text=True,
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
            cwd=str(db_pkg), env=env, capture_output=True, text=True,
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
        help="Server URL (e.g. https://koji.acme.internal or http://localhost:9401)",
    ),
    api_key: str | None = typer.Option(
        None, "--api-key", "-k", help="API key for headless/CI auth (skip browser flow)",
    ),
    profile: str | None = typer.Option(
        None, "--profile", "-p", help="Profile name (default: derived from server URL)",
    ),
    project: str | None = typer.Option(
        None, "--project", help="Default project slug for this profile",
    ),
):
    """Authenticate the CLI with a Koji server.

    Opens your browser to approve API key creation. For CI/headless
    environments, pass --api-key directly.
    """
    from .credentials import Profile, load_credentials

    if api_key:
        # Direct key — headless mode
        url = server_url or "http://localhost:9401"
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
    if not server_url:
        console.print("[red]Server URL is required. Usage: koji login https://koji.example.com[/red]")
        raise SystemExit(1)

    url = server_url.rstrip("/")
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
    from .credentials import load_credentials

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


@app.command()
def version():
    """Show Koji version."""
    console.print("koji 0.1.0")


if __name__ == "__main__":
    app()
