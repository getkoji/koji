"""Remote platform commands — drive the build / validate / corpus loop from the terminal.

These commands talk to a running Koji platform: the same API the dashboard's
**Build**, **Validate**, and **Corpus** tabs use. They let you iterate on a schema
entirely from the keyboard (and from Claude Code):

    koji validate <schema>          # push local schema + backtest against ground truth
    koji run <schema> <doc>         # extract one doc (the Build tab's Run button)
    koji corpus ls <schema>         # list corpus docs
    koji corpus diff <schema> <doc> # extracted vs ground truth, field by field
    koji corpus gt accept …         # promote an extraction to ground truth
    koji corpus add <schema> <file> # upload a doc into the corpus

Auth resolves from the active `koji login` profile, the `--profile` flag, or the
KOJI_API_URL / KOJI_API_KEY environment variables.

Every command takes `--json` to emit raw machine-readable output instead of a
table, so an agent can read a result and decide the next step.
"""

from __future__ import annotations

import json as json_mod
import mimetypes
import os
import time
from pathlib import Path
from typing import Any

import httpx
import typer
import yaml as yaml_mod
from rich.console import Console
from rich.table import Table

from .credentials import get_active_profile, load_credentials

console = Console()
# Progress / status goes to stderr so stdout stays pure (important for --json,
# which an agent pipes and parses).
err_console = Console(stderr=True)


# ── Auth / connection ─────────────────────────────────────────────────


def resolve_api(profile_name: str | None = None) -> tuple[str, dict[str, str]]:
    """Resolve (base_url, auth_headers) from env vars or a CLI profile.

    KOJI_API_URL + KOJI_API_KEY override everything (CI / local clusters).
    Otherwise the named profile, else the active profile, is used. Exits with a
    helpful message if no credentials are available.
    """
    env_url = os.environ.get("KOJI_API_URL")
    env_key = os.environ.get("KOJI_API_KEY")
    if env_url and env_key:
        return env_url.rstrip("/"), {"Authorization": f"Bearer {env_key}"}

    if profile_name:
        creds = load_credentials()
        profile = creds.profiles.get(profile_name)
        if not profile:
            console.print(f"[red]Profile '{profile_name}' not found.[/red]")
            raise typer.Exit(1)
    else:
        profile = get_active_profile()

    if not profile:
        console.print(
            "[red]Not authenticated. Run [bold]koji login[/bold] first, or set KOJI_API_URL + KOJI_API_KEY.[/red]"
        )
        raise typer.Exit(1)
    return profile.url.rstrip("/"), {"Authorization": f"Bearer {profile.api_key}"}


def _auth_error(resp: httpx.Response, base_url: str) -> bool:
    """If the response is a 401/403, print a helpful auth error and return True."""
    if resp.status_code not in (401, 403):
        return False
    console.print(
        f"\n[red bold]Authentication failed[/red bold] (HTTP {resp.status_code}) "
        f"against [cyan]{base_url}[/cyan]. Re-run [bold]koji login[/bold].\n"
    )
    return True


def _api_error(resp: httpx.Response, context: str) -> None:
    """Print an API error and exit. Call when a response is not a success."""
    try:
        body = resp.json()
        msg = body.get("error") or body.get("details") or json_mod.dumps(body)
    except Exception:
        msg = resp.text[:300]
    console.print(f"[red]✗[/red] {context} — HTTP {resp.status_code}: {msg}")
    raise typer.Exit(1)


# ── Schema + entry resolution ─────────────────────────────────────────


def _looks_like_path(s: str) -> bool:
    return s.endswith((".yaml", ".yml")) or os.sep in s or Path(s).exists()


def _find_local_schema(slug: str) -> Path | None:
    """Look for a local schema file matching a slug (cwd or schemas/)."""
    for cand in (
        Path(f"{slug}.yaml"),
        Path(f"{slug}.yml"),
        Path("schemas") / f"{slug}.yaml",
        Path("schemas") / f"{slug}.yml",
    ):
        if cand.is_file():
            return cand
    return None


def _load_schema_arg(schema: str) -> tuple[str, str | None, Path | None]:
    """Resolve the `schema` argument to (slug, local_yaml_or_None, local_path_or_None).

    Accepts either a path to a YAML file or a bare slug. For a bare slug we try to
    locate a matching local file so the loop can edit a file and push it; if none
    is found, callers fall back to the server's version.
    """
    if _looks_like_path(schema):
        path = Path(schema)
        if not path.is_file():
            console.print(f"[red]Schema file not found: {schema}[/red]")
            raise typer.Exit(1)
        raw = path.read_text()
        try:
            parsed = yaml_mod.safe_load(raw) or {}
        except Exception as e:
            console.print(f"[red]Invalid YAML in {schema}: {e}[/red]")
            raise typer.Exit(1)
        slug = parsed.get("name", path.stem)
        return slug, raw, path

    local = _find_local_schema(schema)
    if local:
        return schema, local.read_text(), local
    return schema, None, None


def _fetch_corpus(client: httpx.Client, base_url: str, headers: dict, slug: str) -> list[dict]:
    resp = client.get(f"{base_url}/api/schemas/{slug}/corpus", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"list corpus for {slug}")
    return resp.json().get("data", [])


def _resolve_entry(entries: list[dict], entry: str) -> dict:
    """Match a corpus entry by exact id, id prefix, exact filename, then unique substring.

    IDs are displayed truncated (first 8 chars) in `corpus ls`, so a unique id
    prefix resolves too — copy the shown id and it just works.
    """
    for e in entries:
        if e.get("id") == entry:
            return e
    id_prefix = [e for e in entries if (e.get("id") or "").startswith(entry)]
    if len(id_prefix) == 1:
        return id_prefix[0]
    if len(id_prefix) > 1:
        console.print(f"[red]'{entry}' matches multiple entry ids. Use a longer id.[/red]")
        raise typer.Exit(1)
    exact = [e for e in entries if e.get("filename") == entry]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        console.print(f"[red]Multiple entries named '{entry}'. Use the entry id.[/red]")
        raise typer.Exit(1)
    sub = [e for e in entries if entry.lower() in (e.get("filename", "") or "").lower()]
    if len(sub) == 1:
        return sub[0]
    if len(sub) > 1:
        names = ", ".join(e.get("filename", "?") for e in sub[:6])
        console.print(f"[red]'{entry}' matches multiple docs: {names}. Be more specific or use the id.[/red]")
        raise typer.Exit(1)
    console.print(f"[red]No corpus entry matching '{entry}'. Try [bold]koji corpus ls[/bold].[/red]")
    raise typer.Exit(1)


def _push_schema(
    client: httpx.Client, base_url: str, headers: dict, slug: str, yaml_content: str, message: str | None
) -> str:
    """Create or update a schema from local YAML. Returns a short status string."""
    resp = client.get(f"{base_url}/api/schemas/{slug}", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 200:
        existing = resp.json()
        existing_yaml = existing.get("latestVersion", {}).get("yamlSource", "") or ""
        if existing_yaml.strip() == yaml_content.strip():
            ver = existing.get("latestVersion", {}).get("versionNumber", "?")
            return f"unchanged (v{ver})"
        resp = client.post(
            f"{base_url}/api/schemas/{slug}/versions",
            json={"yaml": yaml_content, "commit_message": message or "koji validate"},
            headers=headers,
        )
        if resp.status_code != 201:
            _api_error(resp, f"push {slug}")
        return f"updated to v{resp.json().get('versionNumber', '?')}"
    if resp.status_code == 404:
        resp = client.post(
            f"{base_url}/api/schemas",
            json={"slug": slug, "display_name": slug, "initial_yaml": yaml_content},
            headers=headers,
        )
        if resp.status_code != 201:
            _api_error(resp, f"create {slug}")
        return "created (v1)"
    _api_error(resp, f"push {slug}")
    return ""  # unreachable


# ── Value formatting + comparison ─────────────────────────────────────


def _fmt_value(v: Any, width: int = 48) -> str:
    """Render a value for a table cell, truncating long text."""
    if v is None:
        return "—"
    if isinstance(v, (dict, list)):
        s = json_mod.dumps(v, ensure_ascii=False)
    else:
        s = str(v)
    s = s.replace("\n", " ")
    return s if len(s) <= width else s[: width - 1] + "…"


def _norm(v: Any) -> str:
    """Loose normalization mirroring the platform's case/space-insensitive compare."""
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json_mod.dumps(v, sort_keys=True, ensure_ascii=False)
    return str(v).strip().lower()


def _diff_fields(ground_truth: dict, extracted: dict) -> list[dict]:
    """Return per-field [{field, expected, got, match}] over the union of keys."""
    rows = []
    for f in sorted(set(ground_truth) | set(extracted)):
        exp = ground_truth.get(f)
        got = extracted.get(f)
        rows.append({"field": f, "expected": exp, "got": got, "match": _norm(exp) == _norm(got)})
    return rows


# ── Renderers ─────────────────────────────────────────────────────────


def _render_validate(slug: str, r: dict) -> None:
    overall = r.get("overallAccuracy")
    prev = r.get("prevAccuracy")
    delta = ""
    if prev is not None and overall is not None:
        d = overall - prev
        arrow = "▲" if d > 0 else ("▼" if d < 0 else "=")
        color = "green" if d > 0 else ("red" if d < 0 else "dim")
        delta = f"  [{color}]{arrow}{abs(d):.1f} vs prev[/{color}]"

    passed = r.get("passed")
    head_color = "green" if passed else "yellow"
    overall_disp = f"{overall:.1f}%" if overall is not None else "?"
    # Semver candidate label + the auto-derived bump. The candidate is NOT live —
    # promote it with `koji schema promote` once it performs well.
    version = r.get("version") or f"v{r.get('schemaVersion', '?')}"
    bump = r.get("bump")
    bump_disp = f"  [magenta]{bump}[/magenta]" if bump else ""
    dedup_disp = "  [dim](reused)[/dim]" if r.get("deduped") else "  [dim](candidate · not live)[/dim]"
    console.print(
        f"\n[bold {head_color}]{slug}[/bold {head_color}]  "
        f"overall [bold]{overall_disp}[/bold]{delta}   "
        f"docs {r.get('docsPassed')}/{r.get('docsTotal')}   "
        f"fields {r.get('fieldCount')}   "
        f"${r.get('costUsd', 0):.4f}   {r.get('durationMs', 0) / 1000:.1f}s   "
        f"[cyan]{version}[/cyan]{bump_disp}{dedup_disp}\n"
    )

    fields = r.get("fields", [])
    if fields:
        table = Table(show_header=True, header_style="bold")
        table.add_column("Field")
        table.add_column("Acc", justify="right")
        table.add_column("Δ", justify="right")
        table.add_column("Status")
        for f in fields:
            acc = f.get("accuracy")
            pv = f.get("prevAccuracy")
            d = "" if (pv is None or acc is None) else f"{acc - pv:+.0f}"
            d_color = "red" if d.startswith("-") else ("green" if (d and d != "+0") else "dim")
            st = f.get("status", "")
            st_disp = {
                "pass": "[green]pass[/green]",
                "regressed": "[red]regressed[/red]",
                "failing": "[yellow]failing[/yellow]",
            }.get(st, st)
            acc_disp = "—" if acc is None else f"{acc:.0f}%"
            table.add_row(
                f.get("name", ""),
                acc_disp,
                f"[{d_color}]{d}[/{d_color}]" if d else "",
                st_disp,
            )
        console.print(table)

    failing = r.get("failingDocs", [])
    if failing:
        console.print(f"\n[bold]failing docs ({len(failing)}):[/bold]")
        for d in failing[:25]:
            ff = ", ".join(d.get("failedFields", []))
            console.print(f"  [red]✗[/red] {d.get('filename')}  [dim]{(d.get('id') or '')[:8]}[/dim]  → {ff}")
        if len(failing) > 25:
            console.print(f"  [dim]… and {len(failing) - 25} more[/dim]")
    else:
        console.print("\n[green]✓ all docs passing[/green]")
    console.print()


def _render_extract(entry: dict, r: dict, show_prov: bool) -> None:
    console.print(
        f"\n[bold]{r.get('filename', entry.get('filename'))}[/bold]  "
        f"[dim]{r.get('model', '')}  {r.get('pages', '?')}p  "
        f"{r.get('elapsed_ms', 0) / 1000:.1f}s"
        f"{'  cached' if r.get('cached') else ''}[/dim]\n"
    )
    extracted = r.get("extracted", {}) or {}
    scores = r.get("confidence_scores", {}) or {}
    prov = r.get("provenance", {}) or {}

    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Value")
    table.add_column("Conf", justify="right")
    if show_prov:
        table.add_column("Source")
    for k in extracted:
        conf = scores.get(k)
        conf_disp = "" if conf is None else f"{conf * 100:.0f}%"
        conf_color = "green" if (conf or 0) >= 0.8 else ("yellow" if (conf or 0) >= 0.5 else "red")
        row = [k, _fmt_value(extracted[k]), f"[{conf_color}]{conf_disp}[/{conf_color}]" if conf_disp else ""]
        if show_prov:
            p = prov.get(k) or {}
            snippet = p.get("chunk") or "" if isinstance(p, dict) else ""
            row.append(_fmt_value(snippet, 40))
        table.add_row(*row)
    console.print(table)
    console.print()


def _render_diff(entry: dict, rows: list[dict]) -> None:
    n_match = sum(1 for r in rows if r["match"])
    console.print(f"\n[bold]{entry.get('filename')}[/bold]  [dim]{n_match}/{len(rows)} fields match[/dim]\n")
    table = Table(show_header=True, header_style="bold")
    table.add_column("")
    table.add_column("Field")
    table.add_column("Expected (GT)")
    table.add_column("Got (extracted)")
    for r in rows:
        mark = "[green]✓[/green]" if r["match"] else "[red]✗[/red]"
        got = _fmt_value(r["got"])
        got_disp = got if r["match"] else f"[red]{got}[/red]"
        table.add_row(mark, r["field"], _fmt_value(r["expected"]), got_disp)
    console.print(table)
    console.print()


# ── Commands: validate / run ──────────────────────────────────────────


def validate(
    schema: str = typer.Argument(..., help="Schema slug, or path to a local schema YAML to backtest."),
    model: str = typer.Option(None, "--model", help="Override the extraction model (e.g. openai/gpt-4o-mini)."),
    no_push: bool = typer.Option(
        False, "--no-push", help="Validate the version already live on the server; don't snapshot local edits."
    ),
    bump: str = typer.Option(None, "--bump", help="Override the auto-derived semver bump: major | minor | patch."),
    message: str = typer.Option(None, "--message", "-m", help="Commit message for the candidate snapshot."),
    watch: bool = typer.Option(False, "--watch", "-w", help="Re-run whenever the local schema file changes."),
    check: bool = typer.Option(False, "--check", help="Exit non-zero if any field regressed (for CI / loops)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Backtest a schema against its corpus ground truth — safely.

    Snapshots your local YAML as a release **candidate** (`v0.0.4-rc.N`) and
    backtests it — re-extracting every corpus doc that has ground truth and
    scoring it. The candidate is persisted (it shows in the Validate history)
    but is **NOT** made live: iterating never touches the schema production
    pipelines run. Promote a candidate with `koji schema promote` once it
    performs well. With --no-push (or a bare slug with no local file), validates
    the version already live on the server instead.
    """
    if bump and bump not in ("major", "minor", "patch"):
        console.print("[red]--bump must be major, minor, or patch.[/red]")
        raise typer.Exit(1)
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, local_path = _load_schema_arg(schema)

    def run_once() -> int:
        with httpx.Client(timeout=300) as client:
            body: dict = {}
            if model:
                body["model"] = model
            if bump:
                body["bump"] = bump
            if no_push or local_yaml is None:
                if local_yaml is None and not no_push:
                    err_console.print(
                        f"[yellow]No local file for '{slug}' — validating the live server version. "
                        f"(Pass a path to backtest local edits.)[/yellow]"
                    )
                # No yaml in body → server scores the latest stored version.
            else:
                body["yaml"] = local_yaml
                if message:
                    body["commitMessage"] = message
            resp = client.post(f"{base_url}/api/schemas/{slug}/validate", json=body, headers=headers)
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            if resp.status_code != 200:
                _api_error(resp, f"validate {slug}")
            result = resp.json()

        if as_json:
            console.print_json(json_mod.dumps(result))
        else:
            _render_validate(slug, result)
        regressed = [f for f in result.get("fields", []) if f.get("status") == "regressed"]
        return 1 if (check and regressed) else 0

    if not watch:
        raise typer.Exit(run_once())

    if local_path is None:
        console.print("[red]--watch needs a local schema file path.[/red]")
        raise typer.Exit(1)
    console.print(f"[bold]watching[/bold] {local_path} — Ctrl-C to stop\n")
    last: float | None = None
    try:
        while True:
            mtime = local_path.stat().st_mtime
            if mtime != last:
                last = mtime
                local_yaml = local_path.read_text()  # noqa: F841 — read by run_once closure
                run_once()
                console.print("\n[dim]— waiting for changes —[/dim]")
            time.sleep(1)
    except KeyboardInterrupt:
        console.print("\n[dim]stopped[/dim]")
        raise typer.Exit(0)


def run_doc(
    schema: str = typer.Argument(..., help="Schema slug or path to a local schema YAML."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename to extract."),
    model: str = typer.Option(None, "--model", help="Override the extraction model."),
    provenance: bool = typer.Option(False, "--provenance", help="Show the source snippet each value came from."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Run one corpus document through a schema and show the extraction.

    Uses the LOCAL schema YAML if a file is found (so you can iterate without
    pushing); otherwise the server's latest version. Mirrors the Build tab's Run.
    """
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=300) as client:
        if local_yaml is None:
            resp = client.get(f"{base_url}/api/schemas/{slug}", headers=headers)
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            if resp.status_code != 200:
                _api_error(resp, f"fetch schema {slug}")
            local_yaml = resp.json().get("latestVersion", {}).get("yamlSource")
            if not local_yaml:
                console.print(f"[red]No local file and no published version for '{slug}'.[/red]")
                raise typer.Exit(1)

        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        body: dict = {"corpus_entry_id": matched["id"], "schema_yaml": local_yaml}
        if model:
            body["model"] = model
        resp = client.post(
            f"{base_url}/api/extract/run",
            json=body,
            headers={**headers, "Accept": "application/json"},
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"extract {matched.get('filename')}")
        result = resp.json()

    if result.get("error"):
        console.print(f"[red]extraction failed:[/red] {result['error']}")
        raise typer.Exit(1)
    if as_json:
        console.print_json(json_mod.dumps(result))
    else:
        _render_extract(matched, result, provenance)


# ── Commands: corpus group ────────────────────────────────────────────

corpus_app = typer.Typer(help="Manage a schema's validation corpus (docs + ground truth).", no_args_is_help=True)
gt_app = typer.Typer(help="Inspect or set ground truth for a corpus document.", no_args_is_help=True)
corpus_app.add_typer(gt_app, name="gt")


@corpus_app.command("ls")
def corpus_ls(
    schema: str = typer.Argument(..., help="Schema slug."),
    gt: bool = typer.Option(False, "--gt", help="Only docs that have ground truth."),
    no_gt: bool = typer.Option(False, "--no-gt", help="Only docs missing ground truth."),
    tag: str = typer.Option(None, "--tag", help="Only docs carrying this tag."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List corpus documents for a schema."""
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
    if gt:
        entries = [e for e in entries if e.get("hasGroundTruth")]
    if no_gt:
        entries = [e for e in entries if not e.get("hasGroundTruth")]
    if tag:
        entries = [e for e in entries if tag in (e.get("tags") or [])]

    if as_json:
        console.print_json(json_mod.dumps(entries))
        return
    if not entries:
        console.print("[yellow]No matching corpus entries.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("ID", style="dim")
    table.add_column("Filename")
    table.add_column("GT", justify="center")
    table.add_column("Source")
    table.add_column("Tags")
    for e in entries:
        gt_mark = "[green]✓[/green]" if e.get("hasGroundTruth") else "[dim]—[/dim]"
        table.add_row(
            (e.get("id") or "")[:8],
            e.get("filename", ""),
            gt_mark,
            e.get("source", ""),
            ", ".join(e.get("tags") or []),
        )
    console.print(table)
    console.print(f"\n[dim]{len(entries)} doc(s)[/dim]")


@corpus_app.command("diff")
def corpus_diff(
    schema: str = typer.Argument(..., help="Schema slug or path to a local schema YAML."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    run: bool = typer.Option(False, "--run", help="Extract fresh before diffing (uses local schema YAML if present)."),
    model: str = typer.Option(None, "--model", help="Override the extraction model (with --run)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Diff a document's extraction against its ground truth, field by field.

    By default compares the latest stored extraction; pass --run to extract fresh
    with the local schema first.
    """
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=300) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        eid = matched["id"]

        resp = client.get(f"{base_url}/api/schemas/{slug}/corpus/{eid}/ground-truth", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        gt_list = resp.json().get("data", []) if resp.status_code == 200 else []
        ground_truth = gt_list[0].get("payloadJson", {}) if gt_list else {}

        if run:
            yaml_for_run = local_yaml
            if yaml_for_run is None:
                rs = client.get(f"{base_url}/api/schemas/{slug}", headers=headers)
                yaml_for_run = rs.json().get("latestVersion", {}).get("yamlSource") if rs.status_code == 200 else None
            rbody: dict = {"corpus_entry_id": eid, "schema_yaml": yaml_for_run}
            if model:
                rbody["model"] = model
            resp = client.post(
                f"{base_url}/api/extract/run",
                json=rbody,
                headers={**headers, "Accept": "application/json"},
            )
            if resp.status_code != 200:
                _api_error(resp, f"extract {matched.get('filename')}")
            extracted = resp.json().get("extracted", {}) or {}
        else:
            resp = client.get(f"{base_url}/api/extract/runs/{eid}", headers=headers)
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            data = resp.json().get("data") if resp.status_code == 200 else None
            if not data:
                console.print(
                    f"[yellow]No extraction run for {matched.get('filename')}. "
                    f"Use --run to extract now, or `koji run {slug} {entry}`.[/yellow]"
                )
                raise typer.Exit(1)
            extracted = data.get("extracted", {}) or {}

    rows = _diff_fields(ground_truth, extracted)
    if as_json:
        console.print_json(json_mod.dumps({"entry": matched.get("filename"), "id": eid, "fields": rows}))
        return
    if not ground_truth:
        console.print(
            f"[yellow]{matched.get('filename')} has no ground truth yet. "
            f"Set it with `koji corpus gt accept {slug} {entry}`.[/yellow]"
        )
    _render_diff(matched, rows)


@corpus_app.command("get")
def corpus_get(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    output: str = typer.Option(
        None, "--output", "-o", help="Where to write it (default: the doc's filename in the current dir)."
    ),
    markdown: bool = typer.Option(
        False, "--markdown", help="Write the parsed markdown from the latest extraction run instead of the source file."
    ),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Download a corpus document's source file (or its parsed markdown).

    Use this to read what a document actually says — e.g. to adjudicate a
    mismatch between an extraction and ground truth — then correct ground truth
    with `koji corpus gt set`. Prints the path written.
    """
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=120) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        eid = matched["id"]
        filename = matched.get("filename") or eid

        if markdown:
            resp = client.get(f"{base_url}/api/extract/runs/{eid}", headers=headers)
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            data = resp.json().get("data") if resp.status_code == 200 else None
            md = (data or {}).get("markdown")
            if not md:
                console.print(f"[red]No parsed markdown for {filename}. Run `koji run {slug} {entry}` first.[/red]")
                raise typer.Exit(1)
            out = Path(output) if output else Path(f"{Path(filename).stem}.md")
            out.write_text(md)
            console.print(f"[green]✓[/green] wrote {out} ({len(md)} chars of parsed markdown)")
            return

        resp = client.get(f"{base_url}/api/schemas/{slug}/corpus/{eid}/url", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"get url for {filename}")
        url = resp.json().get("url")
        if not url:
            console.print(f"[red]No download URL returned for {filename}.[/red]")
            raise typer.Exit(1)

        # Presigned URL — fetch without auth headers.
        dl = httpx.get(url, timeout=120, follow_redirects=True)
        if dl.status_code != 200:
            console.print(f"[red]Download failed for {filename} (HTTP {dl.status_code}).[/red]")
            raise typer.Exit(1)
        out = Path(output) if output else Path(filename)
        out.write_bytes(dl.content)
        console.print(f"[green]✓[/green] wrote {out} ({len(dl.content)} bytes)")


@corpus_app.command("add")
def corpus_add(
    schema: str = typer.Argument(..., help="Schema slug."),
    files: list[str] = typer.Argument(..., help="One or more document files to upload."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Upload document(s) into a schema's corpus."""
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=120) as client:
        for fp in files:
            path = Path(fp)
            if not path.is_file():
                console.print(f"  [red]✗[/red] {fp} — not found")
                continue
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

            resp = client.post(
                f"{base_url}/api/upload/presign",
                json={"filename": path.name, "contentType": content_type, "context": "corpus", "schemaSlug": slug},
                headers=headers,
            )
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            if resp.status_code not in (200, 201):
                _api_error(resp, f"presign {path.name}")
            pres = resp.json()

            put = client.put(pres["uploadUrl"], content=path.read_bytes(), headers={"Content-Type": content_type})
            if put.status_code not in (200, 201, 204):
                console.print(f"  [red]✗[/red] {path.name} — upload failed (HTTP {put.status_code})")
                continue

            resp = client.post(
                f"{base_url}/api/upload/complete",
                json={"storageKey": pres["storageKey"], "filename": path.name, "context": "corpus", "schemaSlug": slug},
                headers=headers,
            )
            if resp.status_code not in (200, 201):
                _api_error(resp, f"complete {path.name}")
            console.print(f"  [green]✓[/green] {path.name} → {(resp.json().get('id') or '')[:8]}")


@corpus_app.command("tag")
def corpus_tag(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    add: list[str] = typer.Option(None, "--add", help="Tag(s) to add (repeatable)."),
    remove: list[str] = typer.Option(None, "--remove", help="Tag(s) to remove (repeatable)."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Add or remove tags on a corpus document."""
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        tags = set(matched.get("tags") or [])
        tags.update(add or [])
        tags.difference_update(remove or [])
        new_tags = sorted(tags)
        resp = client.patch(
            f"{base_url}/api/schemas/{slug}/corpus/{matched['id']}",
            json={"tags": new_tags},
            headers=headers,
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "update tags")
    console.print(f"[green]✓[/green] {matched.get('filename')} tags: {', '.join(new_tags) or '(none)'}")


@gt_app.command("show")
def gt_show(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Show the current ground truth for a corpus document."""
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        resp = client.get(f"{base_url}/api/schemas/{slug}/corpus/{matched['id']}/ground-truth", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "get ground truth")
        data = resp.json().get("data", [])

    if not data:
        console.print(f"[yellow]No ground truth set for {matched.get('filename')}.[/yellow]")
        raise typer.Exit(0)
    latest = data[0]
    payload = latest.get("payloadJson", {}) or {}
    if as_json:
        console.print_json(json_mod.dumps(payload))
        return
    console.print(
        f"\n[bold]{matched.get('filename')}[/bold] ground truth "
        f"[dim](by {latest.get('authoredByName', '?')}, {latest.get('reviewStatus', '')})[/dim]\n"
    )
    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Value")
    for k, v in payload.items():
        table.add_row(k, _fmt_value(v))
    console.print(table)
    console.print()


@gt_app.command("accept")
def gt_accept(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Promote a document's latest extraction to ground truth.

    Run `koji run <schema> <doc>` first; this saves that extraction's values as
    the ground truth for the doc.
    """
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        eid = matched["id"]
        resp = client.get(f"{base_url}/api/extract/runs/{eid}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        data = resp.json().get("data") if resp.status_code == 200 else None
        if not data or not data.get("extracted"):
            console.print(
                f"[red]No extraction to accept for {matched.get('filename')}. "
                f"Run `koji run {slug} {entry}` first.[/red]"
            )
            raise typer.Exit(1)
        values = data["extracted"]
        resp = client.post(
            f"{base_url}/api/schemas/{slug}/corpus/{eid}/ground-truth",
            json={"values": values},
            headers=headers,
        )
        if resp.status_code not in (200, 201):
            _api_error(resp, "save ground truth")
    console.print(
        f"[green]✓[/green] ground truth set for {matched.get('filename')} "
        f"({len(values)} field(s)) from latest extraction."
    )


@gt_app.command("set")
def gt_set(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    from_file: str = typer.Option(..., "--from", help="JSON file of {field: value} to set as ground truth."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Set ground truth for a document from a JSON file."""
    path = Path(from_file)
    if not path.is_file():
        console.print(f"[red]File not found: {from_file}[/red]")
        raise typer.Exit(1)
    try:
        values = json_mod.loads(path.read_text())
    except Exception as e:
        console.print(f"[red]Invalid JSON in {from_file}: {e}[/red]")
        raise typer.Exit(1)
    if not isinstance(values, dict):
        console.print("[red]Ground truth JSON must be an object of field: value.[/red]")
        raise typer.Exit(1)

    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        resp = client.post(
            f"{base_url}/api/schemas/{slug}/corpus/{matched['id']}/ground-truth",
            json={"values": values},
            headers=headers,
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 201):
            _api_error(resp, "save ground truth")
    console.print(f"[green]✓[/green] ground truth set for {matched.get('filename')} ({len(values)} field(s)).")


# ── Review queue: list / show / promote ───────────────────────────────


def _fmt_conf(v: Any) -> str:
    """Render a 0–1 confidence decimal as a percentage, dim if missing."""
    if v is None or v == "":
        return "[dim]—[/dim]"
    try:
        pct = float(v) * 100
    except (TypeError, ValueError):
        return str(v)
    color = "red" if pct < 70 else ("yellow" if pct < 85 else "green")
    return f"[{color}]{pct:.0f}%[/{color}]"


def _resolve_review_id(client: httpx.Client, base_url: str, headers: dict, raw: str) -> str:
    """Resolve a review-item id or unique id-prefix to a full id.

    `koji review ls` prints truncated (8-char) ids for readability; accept those
    by matching a unique prefix across pending + completed items. A full id
    (36 chars) passes straight through without a lookup.
    """
    if len(raw) == 36 and raw.count("-") == 4:
        return raw
    ids: list[str] = []
    for status in ("pending", "completed"):
        resp = client.get(f"{base_url}/api/review", params={"status": status, "limit": 1000}, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 200:
            ids.extend(r["id"] for r in resp.json().get("data", []) if r.get("id"))
    matches = [i for i in ids if i.startswith(raw)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        console.print(f"[red]'{raw}' matches multiple review items. Use a longer id.[/red]")
        raise typer.Exit(1)
    console.print(f"[red]No review item matching '{raw}'. Try [bold]koji review ls[/bold].[/red]")
    raise typer.Exit(1)


review_app = typer.Typer(
    help="Inspect the review queue and promote reviewed docs into the corpus.",
    no_args_is_help=True,
)


@review_app.command("ls")
def review_ls(
    status: str = typer.Option("pending", "--status", help="pending | completed."),
    reason: str = typer.Option(
        None, "--reason", help="Filter by routing reason (e.g. low_confidence, validation_failed)."
    ),
    limit: int = typer.Option(100, "--limit", help="Max items to return."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List review-queue items.

    These are documents the pipeline routed to human review (a field's confidence
    fell below the pipeline's reviewThreshold, a validation rule failed, etc.).
    Pending items are ordered worst-confidence first. Use `--status completed` to
    find resolved items ready to promote into the corpus.
    """
    base_url, headers = resolve_api(profile_name)
    params: dict[str, Any] = {"status": status, "limit": limit}
    if reason:
        params["reason"] = reason
    with httpx.Client(timeout=60) as client:
        resp = client.get(f"{base_url}/api/review", params=params, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "list review items")
        rows = resp.json().get("data", [])

    if as_json:
        console.print_json(json_mod.dumps(rows))
        return
    if not rows:
        console.print(f"[yellow]No {status} review items.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("ID", style="dim")
    table.add_column("Document")
    table.add_column("Field")
    table.add_column("Reason")
    table.add_column("Conf", justify="right")
    if status == "completed":
        table.add_column("Resolution")
    for r in rows:
        cells = [
            (r.get("id") or "")[:8],
            _fmt_value(r.get("documentFilename") or "", width=32),
            r.get("fieldName", ""),
            r.get("reason", ""),
            _fmt_conf(r.get("confidence")),
        ]
        if status == "completed":
            res = r.get("resolution") or ""
            color = "green" if res == "approved" else ("red" if res == "rejected" else "dim")
            cells.append(f"[{color}]{res or '—'}[/{color}]")
        table.add_row(*cells)
    console.print(table)
    console.print(f"\n[dim]{len(rows)} item(s)[/dim]")


@review_app.command("show")
def review_show(
    review_id: str = typer.Argument(..., help="Review item id, or a unique id prefix from `review ls`."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Show one review item with its full document context.

    Includes the flagged field + why it routed, the document's complete extracted
    record, and the schema/pipeline it ran under — enough for a human or an agent
    to decide the correct value and which schema knob to turn.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        review_id = _resolve_review_id(client, base_url, headers, review_id)
        resp = client.get(f"{base_url}/api/review/{review_id}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 404:
            console.print("[red]Review item not found.[/red]")
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "get review item")
        row = resp.json()

    if as_json:
        console.print_json(json_mod.dumps(row))
        return

    console.print(
        f"\n[bold]{row.get('documentFilename') or row.get('documentId')}[/bold] "
        f"[dim]({row.get('schemaName')} · {row.get('pipelineName') or 'no pipeline'})[/dim]\n"
    )
    meta = Table(show_header=False, box=None)
    meta.add_column("k", style="dim")
    meta.add_column("v")
    meta.add_row("flagged field", str(row.get("fieldName")))
    meta.add_row("reason", str(row.get("reason")))
    meta.add_row("confidence", _fmt_conf(row.get("confidence")))
    meta.add_row("proposed value", _fmt_value(row.get("proposedValue")))
    meta.add_row("status", str(row.get("status")))
    if row.get("resolution"):
        meta.add_row("resolution", str(row.get("resolution")))
        meta.add_row("final value", _fmt_value(row.get("finalValue")))
    console.print(meta)

    extraction = row.get("documentExtractionJson") or {}
    if extraction:
        console.print("\n[bold]Extracted record[/bold]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Field")
        table.add_column("Value")
        for k, v in extraction.items():
            table.add_row(k, _fmt_value(v))
        console.print(table)
    console.print()


@review_app.command("promote")
def review_promote(
    review_id: str = typer.Argument(..., help="Review item id, or a unique id prefix from `review ls`."),
    provisional: bool = typer.Option(
        False,
        "--provisional",
        help="Write an UNAPPROVED draft label (agent-authored). Excluded from validate "
        "until a human approves it. Without this flag the item must be resolved+approved.",
    ),
    to: str = typer.Option(None, "--to", help="Tag the new corpus entry with this category."),
    gt_from: str = typer.Option(
        None, "--gt-from", help="JSON file of {field: value} to use as the label (provisional only)."
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Promote a reviewed document into the corpus as ground truth.

    Default (human-gated): the review item must be resolved and approved; its
    corrected record becomes APPROVED ground truth that `koji validate` scores
    immediately. With --provisional, an agent-supplied label is written as a
    draft that stays out of validate until a human approves it in the dashboard.
    """
    payload: dict[str, Any] = {"provisional": provisional}
    if to:
        payload["to"] = to
    if gt_from:
        if not provisional:
            console.print("[red]--gt-from only applies with --provisional.[/red]")
            raise typer.Exit(1)
        path = Path(gt_from)
        if not path.is_file():
            console.print(f"[red]File not found: {gt_from}[/red]")
            raise typer.Exit(1)
        try:
            values = json_mod.loads(path.read_text())
        except Exception as e:
            console.print(f"[red]Invalid JSON in {gt_from}: {e}[/red]")
            raise typer.Exit(1)
        if not isinstance(values, dict):
            console.print("[red]Ground truth JSON must be an object of field: value.[/red]")
            raise typer.Exit(1)
        payload["groundTruth"] = values

    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=120) as client:
        review_id = _resolve_review_id(client, base_url, headers, review_id)
        resp = client.post(f"{base_url}/api/review/{review_id}/promote", json=payload, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 409:
            console.print(
                "[red]Review item is not resolved+approved.[/red] Resolve it in the dashboard "
                "first, or pass [bold]--provisional[/bold] to write an unapproved draft label."
            )
            raise typer.Exit(1)
        if resp.status_code not in (200, 201):
            _api_error(resp, "promote review item")
        result = resp.json()

    if as_json:
        console.print_json(json_mod.dumps(result))
        return
    status_label = "[yellow]draft (needs approval)[/yellow]" if result.get("provisional") else "[green]approved[/green]"
    dedup_note = " [dim](appended to existing corpus entry)[/dim]" if result.get("deduped") else ""
    console.print(
        f"[green]✓[/green] promoted {result.get('filename')} → corpus "
        f"{(result.get('corpusEntryId') or '')[:8]} as {status_label} "
        f"({result.get('fieldCount')} field(s)){dedup_note}"
    )


# ── Schema versions: list / promote / release ─────────────────────────


def _fetch_versions(client: httpx.Client, base_url: str, headers: dict, slug: str) -> list[dict]:
    resp = client.get(f"{base_url}/api/schemas/{slug}/versions", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"list versions for {slug}")
    return resp.json().get("data", [])


schema_app = typer.Typer(
    help="Manage schema versions — list, promote a candidate to a release, or release directly.",
    no_args_is_help=True,
)


@schema_app.command("versions")
def schema_versions(
    slug: str = typer.Argument(..., help="Schema slug."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List a schema's versions — released lineage + candidates, scores, and which is live."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        versions = _fetch_versions(client, base_url, headers, slug)

    if as_json:
        console.print_json(json_mod.dumps(versions))
        return
    if not versions:
        console.print(f"[yellow]No versions for {slug} yet.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("Version")
    table.add_column("Acc", justify="right")
    table.add_column("Kind")
    table.add_column("Live", justify="center")
    for v in versions:
        acc = v.get("accuracy")
        acc_disp = f"{float(acc) * 100:.1f}%" if acc is not None else "[dim]—[/dim]"
        kind = "[green]released[/green]" if v.get("released") else "[magenta]candidate[/magenta]"
        live = "[green]●[/green]" if v.get("active") else ""
        table.add_row(v.get("version", ""), acc_disp, kind, live)
    console.print(table)
    console.print(f"\n[dim]{len(versions)} version(s)[/dim]")


@schema_app.command("promote")
def schema_promote(
    slug: str = typer.Argument(..., help="Schema slug."),
    version: str = typer.Option(
        None, "--version", help="Candidate to promote (e.g. v0.0.4-rc.7). Default: the latest candidate."
    ),
    require_no_regressions: bool = typer.Option(
        False, "--require-no-regressions", help="Refuse to promote if the candidate's latest run regressed."
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Graduate a release candidate to a release and make it live (gated by schema:deploy)."""
    base_url, headers = resolve_api(profile_name)
    body: dict = {}
    with httpx.Client(timeout=120) as client:
        if version:
            versions = _fetch_versions(client, base_url, headers, slug)
            match = [v for v in versions if v.get("version") == version or (v.get("id") or "").startswith(version)]
            if len(match) != 1:
                console.print(
                    f"[red]'{version}' didn't match exactly one version. Try [bold]koji schema versions {slug}[/bold].[/red]"
                )
                raise typer.Exit(1)
            body["versionId"] = match[0]["id"]
        if require_no_regressions:
            body["requireNoRegressions"] = True
        resp = client.post(f"{base_url}/api/schemas/{slug}/promote", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"promote {slug}")
        result = resp.json()

    if as_json:
        console.print_json(json_mod.dumps(result))
        return
    console.print(f"[green]✓[/green] released [cyan]{result.get('released')}[/cyan] — now live")


@schema_app.command("release")
def schema_release(
    schema: str = typer.Argument(..., help="Schema slug, or path to a local schema YAML to release directly."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Release a schema directly to a full version, skipping the rc loop.

    For early-stage building when there's nothing in the corpus to backtest yet.
    Sends your local YAML if given a path; otherwise releases the server-side
    draft. Makes the new version live (gated by schema:deploy).
    """
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, _ = _load_schema_arg(schema)
    body: dict = {}
    if local_yaml:
        body["yaml"] = local_yaml
    with httpx.Client(timeout=120) as client:
        resp = client.post(f"{base_url}/api/schemas/{slug}/release", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"release {slug}")
        result = resp.json()

    if as_json:
        console.print_json(json_mod.dumps(result))
        return
    console.print(f"[green]✓[/green] released [cyan]{result.get('released')}[/cyan] — now live")
