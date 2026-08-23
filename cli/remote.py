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
from rich.markup import escape
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn
from rich.table import Table

from .credentials import get_active_profile, load_credentials

console = Console()
# Progress / status goes to stderr so stdout stays pure (important for --json,
# which an agent pipes and parses).
err_console = Console(stderr=True)


def emit_json(data: Any) -> None:
    """Print machine-readable JSON straight to stdout, bypassing rich.

    rich's print_json injects ANSI style codes whenever stdout looks like a
    terminal (agent harnesses run commands under a pty), and NO_COLOR only
    strips colors, not bold — either way json.loads breaks downstream.
    """
    print(json_mod.dumps(data, indent=2))


# ── Auth / connection ─────────────────────────────────────────────────


#: Response header carrying the project the SERVER resolved a request to. The
#: client can name a project, but the server decides — from the header, the API
#: key's own binding, or a default pick — and only it knows which.
RESOLVED_PROJECT_HEADER = "x-koji-project-resolved"

#: Print the local scope line at most once per process, however many API calls
#: a command makes.
_scope_announced = False


def _announce_scope(source: str, project: str | None) -> None:
    """Say which project this command is asking for, and where that came from.

    Every project-scoped read and write went out with no indication of its
    target. When the scope was wrong — a profile without a project, an
    unexpected `KOJI_PROJECT`, an API key bound somewhere else — nothing said
    so: `koji pull` wrote a different project's schemas over yours, and
    `koji push` reported "created" for something that already existed in the
    project you meant (oss-491).
    """
    global _scope_announced
    if _scope_announced:
        return
    _scope_announced = True
    if project:
        err_console.print(f"[dim]project: {project} (from {source})[/dim]")
    else:
        err_console.print(f"[dim]project: unset in {source} — the API key's own project decides[/dim]")


def note_resolved_project(resp: httpx.Response) -> None:
    """Report the project the server actually used, when it can surprise you.

    Silent when the server confirms the project we asked for; loud when we
    asked for nothing and the server picked, because that is the case where a
    command writes somewhere the operator was not looking.
    """
    resolved = resp.headers.get(RESOLVED_PROJECT_HEADER)
    if not resolved:
        return
    asked = resp.request.headers.get("x-koji-project")
    if asked == resolved:
        return
    if asked:
        err_console.print(
            f"[yellow]server resolved project '{resolved}', not the '{asked}' this command asked for.[/yellow]"
        )
    else:
        err_console.print(f"[dim]server resolved project: {resolved}[/dim]")


def resolve_api(profile_name: str | None = None) -> tuple[str, dict[str, str]]:
    """Resolve (base_url, auth_headers) from env vars or a CLI profile.

    KOJI_API_URL + KOJI_API_KEY override everything (CI / local clusters);
    KOJI_PROJECT optionally scopes those to a project. Otherwise the named
    profile, else the active profile, is used. A profile's `project` (set via
    `koji login --project`) is sent as the `x-koji-project` header — without
    it the server scopes requests to the API key's own project.

    Announces the resolved scope on stderr, once per process. Which project a
    command targets is not something the operator should have to reconstruct
    afterwards from what changed.
    """
    env_url = os.environ.get("KOJI_API_URL")
    env_key = os.environ.get("KOJI_API_KEY")
    env_project = os.environ.get("KOJI_PROJECT")
    if env_url and env_key:
        headers = {"Authorization": f"Bearer {env_key}"}
        if env_project:
            headers["x-koji-project"] = env_project
        _announce_scope("KOJI_PROJECT", env_project)
        return env_url.rstrip("/"), headers

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
    headers = {"Authorization": f"Bearer {profile.api_key}"}
    if profile.project:
        headers["x-koji-project"] = profile.project
    label = f"profile '{profile.name}'" if profile.name else "the active profile"
    _announce_scope(label, profile.project)
    return profile.url.rstrip("/"), headers


def _auth_error(resp: httpx.Response, base_url: str) -> bool:
    """If the response is a 401/403, print a helpful auth error and return True."""
    if resp.status_code not in (401, 403):
        return False
    console.print(
        f"\n[red bold]Authentication failed[/red bold] (HTTP {resp.status_code}) "
        f"against [cyan]{base_url}[/cyan]. Re-run [bold]koji login[/bold].\n"
    )
    return True


def _format_details(details: object) -> list[str]:
    """Render a server `details` payload into readable one-per-line messages.

    Schema-compile failures (422) return `details` as a list of
    `{field?, message, line?}` objects — the real cause (e.g. "Map keys must be
    unique at line 391"). Older/other endpoints may send a plain string. Flatten
    either shape into printable lines; drop nothing on the floor.
    """
    lines: list[str] = []
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                msg = item.get("message") or json_mod.dumps(item)
                field = item.get("field")
                line_no = item.get("line")
                prefix = f"{field}: " if field else ""
                suffix = f" (line {line_no})" if line_no and "line" not in str(msg).lower() else ""
                lines.append(f"{prefix}{msg}{suffix}")
            else:
                lines.append(str(item))
    elif isinstance(details, str):
        lines.append(details)
    elif details is not None:
        lines.append(json_mod.dumps(details))
    return lines


def _api_error(resp: httpx.Response, context: str) -> None:
    """Print an API error and exit. Call when a response is not a success."""
    detail = None
    detail_lines: list[str] = []
    try:
        body = resp.json()
        detail_lines = _format_details(body.get("details"))
        # Prefer the top-level `error`; fall back to the first compile detail,
        # then the raw body. Never collapse a details[] array into "HTTP 422:
        # Schema validation failed" and hide the real cause (oss-397).
        msg = body.get("error") or (detail_lines[0] if detail_lines else None) or json_mod.dumps(body)
        # The server attaches `detail` with the underlying cause (e.g. the raw
        # upstream parse error). Surface it — dropping it is what made the
        # bare-MIME Doc AI failure invisible from the CLI.
        detail = body.get("detail")
    except Exception:
        msg = resp.text[:300]
    console.print(f"[red]✗[/red] {context} — HTTP {resp.status_code}: {msg}")
    # Only enumerate the compile details when they add detail beyond `msg`
    # itself (i.e. there's a real `error` header, or more than one message).
    if detail_lines and (detail_lines[0] != msg or len(detail_lines) > 1):
        for line in detail_lines:
            console.print(f"  [red]•[/red] {line}")
    if detail:
        console.print(f"  [dim]detail:[/dim] {detail}")
    # Every request is project-scoped since 0.48: a stored profile project (or
    # KOJI_PROJECT) that doesn't match a server project slug 404s everything.
    # Say so — the bare "Project not found" gives no hint the fix is local.
    if resp.status_code == 404 and isinstance(msg, str) and "Project not found" in msg:
        sent = resp.request.headers.get("x-koji-project") if resp.request else None
        if sent:
            console.print(
                f"  [yellow]Your credentials are pinned to project [bold]{sent}[/bold], "
                f"which doesn't exist on the server.[/yellow]\n"
                f"  Fix: re-run [bold]koji login[/bold] (optionally with --project <slug>), "
                f"or unset KOJI_PROJECT."
            )
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


def _render_validate(slug: str, r: dict, explain: bool = False, candidate: bool = True) -> None:
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
    # Say what was scored. A --no-push run scores the RELEASED version, and
    # labelling that "candidate · not live" — as this did for every run — told
    # the operator the opposite of what happened.
    if not candidate:
        dedup_disp = "  [dim](released · live)[/dim]"
    elif r.get("deduped"):
        dedup_disp = "  [dim](reused)[/dim]"
    else:
        dedup_disp = "  [dim](candidate · not live)[/dim]"
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
        # Precision / recall — populated for array fields (F1 scoring); blank for
        # scalars. Lets you read a low array score as "missed elements" (recall)
        # vs "spurious/wrong elements" (precision).
        table.add_column("P/R", justify="right")
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
                # Ground truth has this field; the schema being validated doesn't
                # declare it. Nothing was extracted for it, so its 0% says
                # nothing about extraction quality.
                "not_in_schema": "[dim]not in schema[/dim]",
            }.get(st, st)
            acc_disp = "—" if acc is None else f"{acc:.0f}%"
            prec = f.get("precision")
            rec = f.get("recall")
            pr_disp = "" if (prec is None or rec is None) else f"[dim]{prec:.0f}/{rec:.0f}[/dim]"
            table.add_row(
                f.get("name", ""),
                acc_disp,
                pr_disp,
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

    if explain:
        _render_routing_diagnostics(r)
        _render_array_element_diffs(r)
    console.print()


def _elem_labels(elements: list[dict], side: str, limit: int = 6) -> str:
    """Compact labels for a list of element diffs: the element_key value when
    the schema declares one, else the formatted element itself."""
    labels = [e.get("key") or _fmt_value(e.get(side, ""), 24) for e in elements]
    shown = ", ".join(labels[:limit])
    return shown + (f" …+{len(labels) - limit}" if len(labels) > limit else "")


def _render_array_element_diffs(r: dict) -> None:
    """Per-element diagnosis for failing array fields: which extracted elements
    were spurious (FP — they hurt precision) and which expected elements were
    missed (FN — they hurt recall), keyed by element_key when declared."""
    rows: list[tuple[str, str, list[dict], list[dict], int]] = []
    for f in r.get("fields", []):
        for d in f.get("failingDocs", []) or []:
            diff = d.get("diff") or {}
            if diff.get("kind") != "array":
                continue
            elements = diff.get("elements") or []
            fp = [e for e in elements if e.get("status") == "extra"]
            fn = [e for e in elements if e.get("status") == "missing"]
            changed = sum(1 for e in elements if e.get("status") == "changed")
            if not fp and not fn and not changed:
                continue
            rows.append((f.get("name", ""), d.get("filename", ""), fp, fn, changed))

    if not rows:
        return

    console.print("\n[bold]array element diagnostics[/bold] [dim](per-element FP / FN)[/dim]")
    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Doc")
    table.add_column("FP (spurious)")
    table.add_column("FN (missed)")
    table.add_column("~", justify="right")
    for field_name, filename, fp, fn, changed in rows[:50]:
        table.add_row(
            field_name,
            _fmt_value(filename, 28),
            f"[red]{_elem_labels(fp, 'got')}[/red]" if fp else "[dim]—[/dim]",
            f"[yellow]{_elem_labels(fn, 'expected')}[/yellow]" if fn else "[dim]—[/dim]",
            f"[dim]{changed}[/dim]" if changed else "[dim]—[/dim]",
        )
    console.print(table)
    console.print(
        "\n[dim]FP → spurious elements the extraction invented or over-enumerated; "
        "tighten `section_anchor` / `skip_row_when`. "
        "FN → expected elements the extraction missed; check `per_section` / "
        "`enumerate_rows` routing. ~ → matched by key but a sub-field differs.[/dim]"
    )


def _render_routing_diagnostics(r: dict) -> None:
    """Explain each failing (field, doc) pair: routing source + whether the
    expected answer was even in the chunks the model saw. A routing MISS means
    the fix is in the schema `hints`, not a bigger model."""
    rows: list[tuple[str, str, dict]] = []
    for f in r.get("fields", []):
        for d in f.get("failingDocs", []) or []:
            diag = d.get("routingDiagnosis")
            if diag:
                rows.append((f.get("name", ""), d.get("filename", ""), diag))

    if not rows:
        console.print(
            "\n[dim]routing diagnostics: none available "
            "(no routing data on this run — re-run with --no-push to re-extract).[/dim]"
        )
        return

    console.print("\n[bold]routing diagnostics[/bold] [dim](why each failing field failed)[/dim]")
    table = Table(show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Doc")
    table.add_column("Answer in chunks?")
    table.add_column("Route")
    table.add_column("Chunks seen")
    for field_name, filename, diag in rows[:50]:
        ans = diag.get("answerInRoutedChunks")
        if ans is False:
            ans_disp = "[red]NO — routing miss[/red]"
        elif ans is True:
            ans_disp = "[yellow]yes — model misread[/yellow]"
        else:
            ans_disp = "[dim]?[/dim]"
        src = diag.get("source") or "?"
        src_color = "red" if src in ("fallback", "broadened") else "cyan"
        chunks = diag.get("chunks") or []
        chunk_disp = ", ".join(str(c.get("index")) for c in chunks) or "[dim]none[/dim]"
        table.add_row(
            field_name,
            _fmt_value(filename, 28),
            ans_disp,
            f"[{src_color}]{src}[/{src_color}]",
            chunk_disp,
        )
    console.print(table)
    console.print(
        "\n[dim]NO → the answer never reached the model; fix the schema `hints` "
        "(look_in / prefer_contains / patterns / prefer_position / max_chunks). "
        "yes → the model saw it and misread; tighten the field description first. "
        "A bigger model is a last resort.[/dim]"
    )


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


def _poll_validate_run(
    client: httpx.Client,
    base_url: str,
    headers: dict,
    slug: str,
    queued: dict,
    resource: str = "schemas",
) -> dict:
    """Poll an async validate run until it finishes; return the result payload.

    The POST returned 202 with {runId, docsTotal}. Each corpus doc runs as its
    own background job server-side (oss-348) — this just watches progress.
    Exits non-zero if the run fails or hasn't finished after 30 minutes.
    `resource` selects the surface ("schemas" or "classifiers") so schema
    validate and classifier validate share one poller.
    """
    run_id = queued.get("runId")
    docs_total = int(queued.get("docsTotal") or 0)
    url = f"{base_url}/api/{resource}/{slug}/validate/runs/{run_id}"
    deadline = time.monotonic() + 1800  # 30 min hard cap

    # Progress renders to stderr: it's human feedback, and stdout must stay
    # pure for --json consumers (oss-349 — ANSI on stdout breaks json.loads).
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} docs"),
        console=err_console,
        transient=True,
    ) as progress:
        task = progress.add_task(f"validating {slug}", total=docs_total or None)
        while True:
            if time.monotonic() > deadline:
                progress.stop()
                console.print(
                    "[red]✗[/red] validate run still not finished after 30 minutes — "
                    "check the server's worker logs, then re-run."
                )
                raise typer.Exit(1)
            resp = client.get(url, headers=headers)
            if resp.status_code != 200:
                _api_error(resp, f"validate {slug} (run {run_id})")
            data = resp.json()
            total = int(data.get("docsTotal") or docs_total)
            progress.update(task, completed=int(data.get("docsProcessed") or 0), total=total or None)
            status = data.get("status")
            if status == "completed":
                result = data.get("result")
                if not isinstance(result, dict):
                    progress.stop()
                    console.print("[red]✗[/red] validate run completed but returned no result payload.")
                    raise typer.Exit(1)
                return result
            if status == "failed":
                progress.stop()
                console.print(f"[red]✗[/red] validate {slug} failed — {data.get('error') or 'unknown error'}")
                for pf in data.get("parseFailures") or []:
                    console.print(f"  [red]✗[/red] {pf.get('filename')}: {pf.get('error')}")
                raise typer.Exit(1)
            time.sleep(2)


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
    explain: bool = typer.Option(
        False,
        "--explain",
        help="For each failing field, show WHY it failed: which chunks the model saw, "
        "how they were routed, and whether the expected answer was even present in them.",
    ),
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

    The two modes are not interchangeable for before/after comparison: they can
    score schemas that declare different fields, and a field ground truth has
    but the scored schema doesn't is reported `not in schema`, not as a failure.
    """
    if bump and bump not in ("major", "minor", "patch"):
        console.print("[red]--bump must be major, minor, or patch.[/red]")
        raise typer.Exit(1)
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, local_path = _load_schema_arg(schema)

    def run_once() -> int:
        # 300s covers the sync fallback against an older server (the async
        # path returns in milliseconds and each poll is a fast read).
        with httpx.Client(timeout=300) as client:
            body: dict = {"async": True}
            if model:
                body["model"] = model
            if bump:
                body["bump"] = bump
            scored_stored_version = bool(no_push or local_yaml is None)
            if scored_stored_version:
                if local_yaml is None and not no_push:
                    err_console.print(
                        f"[yellow]No local file for '{slug}' — validating the live server version. "
                        f"(Pass a path to backtest local edits.)[/yellow]"
                    )
                # No yaml in body → the server scores the RELEASED version.
            else:
                body["yaml"] = local_yaml
                if message:
                    body["commitMessage"] = message
            resp = client.post(f"{base_url}/api/schemas/{slug}/validate", json=body, headers=headers)
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            if resp.status_code == 202:
                # Async run: the server fans each corpus doc out as its own job
                # (no request ever races a timeout — oss-348). Poll for progress
                # and the final result, then merge the candidate metadata from
                # the 202 (version/bump/deduped) into it for rendering.
                queued = resp.json()
                result = _poll_validate_run(client, base_url, headers, slug, queued)
                for key in ("version", "bump", "deduped"):
                    result.setdefault(key, queued.get(key))
            elif resp.status_code == 200:
                # Older server without async validate — full result in one response.
                result = resp.json()
            else:
                _api_error(resp, f"validate {slug}")
                return 1  # unreachable — _api_error raises

        if as_json:
            emit_json(result)
        else:
            _render_validate(slug, result, explain=explain, candidate=not scored_stored_version)
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
    no_cache: bool = typer.Option(
        False, "--no-cache", help="Force a fresh parse, bypassing (and refreshing) the parse cache."
    ),
    provenance: bool = typer.Option(False, "--provenance", help="Show the source snippet each value came from."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Run one corpus document through a schema and show the extraction.

    Uses the LOCAL schema YAML if a file is found (so you can iterate without
    pushing); otherwise the server's latest version. Mirrors the Build tab's Run.
    Pass --no-cache to re-parse from scratch (e.g. after switching parse providers).
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
        if no_cache:
            body["skip_cache"] = True
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
        emit_json(result)
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
        emit_json(entries)
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
        emit_json({"entry": matched.get("filename"), "id": eid, "fields": rows})
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


@corpus_app.command("rm")
def corpus_rm(
    schema: str = typer.Argument(..., help="Schema slug."),
    entry: str = typer.Argument(..., help="Corpus entry id or filename."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Remove a document from a schema's corpus.

    Soft-delete: the entry drops out of every read path (lists, validate,
    performance, dedup) but the row and its file are retained for recovery. Use
    it to drop a document that isn't really this schema's type so it stops
    skewing validation. Re-add it later with `koji corpus add`.
    """
    base_url, headers = resolve_api(profile_name)
    slug, _, _ = _load_schema_arg(schema)
    with httpx.Client(timeout=60) as client:
        entries = _fetch_corpus(client, base_url, headers, slug)
        matched = _resolve_entry(entries, entry)
        filename = matched.get("filename") or matched["id"]
        if not yes and not typer.confirm(f"Remove '{filename}' from the {slug} corpus?"):
            console.print("[dim]aborted[/dim]")
            raise typer.Exit(0)
        resp = client.delete(f"{base_url}/api/schemas/{slug}/corpus/{matched['id']}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 204):
            _api_error(resp, f"remove {filename}")
    console.print(f"[green]✓[/green] removed {filename} from the {slug} corpus")


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
        emit_json(payload)
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
    # __queue/ids returns every id for a status (no fetch limit). Matching
    # against a limited /api/review page loses any item past the limit, so
    # prefixes for deep-queue items resolved to "not found".
    for status in ("pending", "completed"):
        resp = client.get(f"{base_url}/api/review/__queue/ids", params={"status": status}, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 200:
            ids.extend(i for i in resp.json().get("data", []) if i)
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
        emit_json(rows)
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
    if len(rows) >= limit:
        console.print(
            f"\n[dim]showing first {len(rows)} — the queue may be larger; "
            f"run [bold]koji review stats[/bold] for true counts[/dim]"
        )
    else:
        console.print(f"\n[dim]{len(rows)} item(s)[/dim]")


@review_app.command("stats")
def review_stats(
    urgent_below: float = typer.Option(0.7, "--urgent-below", help="Confidence threshold for the urgent count (0-1)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Queue-level counts, computed server-side with count(*).

    Use this for queue size — `review ls` returns at most `--limit` rows
    (default 100), so counting its output caps every number at the fetch
    limit and a burn-down loop watching that count never sees it move.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.get(
            f"{base_url}/api/review/__queue/stats",
            params={"urgent_below": urgent_below},
            headers=headers,
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "fetch review queue stats")
        stats = resp.json()

    if as_json:
        emit_json(stats)
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("Metric")
    table.add_column("Count", justify="right")
    table.add_row("pending", f"{stats.get('pending', 0):,}")
    table.add_row(f"urgent (conf < {urgent_below})", f"{stats.get('urgent', 0):,}")
    table.add_row("completed", f"{stats.get('completed', 0):,}")
    table.add_row("reviewed in last 24h", f"{stats.get('reviewedToday', 0):,}")
    console.print(table)


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
        emit_json(row)
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
        emit_json(result)
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
        emit_json(versions)
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
        emit_json(result)
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
        emit_json(result)
        return
    console.print(f"[green]✓[/green] released [cyan]{result.get('released')}[/cyan] — now live")


# ── Pipelines: list / deploy (pin or auto a schema version) ───────────


def _fetch_pipeline(client: httpx.Client, base_url: str, headers: dict, slug: str) -> dict:
    resp = client.get(f"{base_url}/api/pipelines/{slug}", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 404:
        console.print(f"[red]Pipeline '{slug}' not found.[/red]")
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"get pipeline {slug}")
    return resp.json()


pipeline_app = typer.Typer(
    help="Manage pipelines — list, run/test docs through them, and pin/unpin the schema version they run.",
    no_args_is_help=True,
)


@pipeline_app.command("ls")
def pipeline_ls(
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List pipelines with their schema and status."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.get(f"{base_url}/api/pipelines", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "list pipelines")
        rows = resp.json().get("data", [])

    if as_json:
        emit_json(rows)
        return
    if not rows:
        console.print("[yellow]No pipelines.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("Pipeline")
    table.add_column("Schema")
    table.add_column("Status")
    for p in rows:
        table.add_row(p.get("slug", ""), p.get("schemaSlug") or "[dim]—[/dim]", p.get("status", ""))
    console.print(table)
    console.print(f"\n[dim]{len(rows)} pipeline(s)[/dim]")


@pipeline_app.command("deploy")
def pipeline_deploy(
    pipeline: str = typer.Argument(..., help="Pipeline slug."),
    version: str = typer.Option(None, "--version", help="Pin the pipeline to this schema version (e.g. v0.0.4)."),
    auto: bool = typer.Option(False, "--auto", help="Unpin: follow the schema's live release automatically."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Pin a pipeline to a specific schema version, or set it back to auto.

    A pinned pipeline keeps running its version through schema promotions (staged
    rollout); an auto pipeline always runs the schema's current live release.
    Gated by the schema:deploy permission.
    """
    if auto == bool(version):
        console.print("[red]Pass either --version <v> or --auto (not both).[/red]")
        raise typer.Exit(1)

    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        if auto:
            body: dict = {"mode": "auto"}
        else:
            detail = _fetch_pipeline(client, base_url, headers, pipeline)
            schema_slug = detail.get("schemaSlug")
            if not schema_slug:
                console.print(f"[red]Pipeline '{pipeline}' has no schema to pin a version for.[/red]")
                raise typer.Exit(1)
            versions = _fetch_versions(client, base_url, headers, schema_slug)
            match = [v for v in versions if v.get("version") == version or (v.get("id") or "").startswith(version)]
            if len(match) != 1:
                console.print(
                    f"[red]'{version}' didn't match exactly one version of {schema_slug}. "
                    f"Try [bold]koji schema versions {schema_slug}[/bold].[/red]"
                )
                raise typer.Exit(1)
            body = {"schema_version_id": match[0]["id"]}

        resp = client.post(f"{base_url}/api/pipelines/{pipeline}/deploy", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"deploy {pipeline}")
        result = resp.json()

    if as_json:
        emit_json(result)
        return
    mode = result.get("versionMode", "auto" if auto else "pinned")
    if mode == "pinned":
        console.print(f"[green]✓[/green] {pipeline} pinned to [cyan]{version}[/cyan]")
    else:
        console.print(f"[green]✓[/green] {pipeline} set to [cyan]auto[/cyan] — follows the live release")


# ── Pipelines: run docs through a pipeline (the dashboard's manual-run path) ──
#
# `koji pipeline run` submits each document to POST /api/pipelines/<slug>/run —
# the same endpoint the dashboard's manual run uses. That endpoint parses,
# extracts, and routes the doc exactly as production ingestion does (it just
# creates a real job and enqueues the ingestion worker). We submit ONE doc per
# /run call (its own job) rather than batching via /jobs/:id/docs, because the
# batch endpoint always enqueues the simple-ingestion worker and would misroute
# a DAG pipeline; a per-doc /run always hits the correct per-type handler.

# Document states the server treats as terminal — where a manual run stops. The
# ingestion pipeline leaves a finished document in one of:
#   delivered — extracted and emitted (the success terminal; see outcome.ts)
#   review    — extracted, but a low-confidence field was routed to a human
#               (the extraction payload is still present)
#   failed    — processing failed
# ("completed" is a *job* status, not a document status; it's kept here only as a
# defensive extra so a future/edge document status never hangs the poll.)
_TERMINAL_DOC_STATES = {"delivered", "review", "failed", "completed"}


def _expand_input_paths(paths: list[str]) -> list[Path]:
    """Expand CLI path args into a flat, sorted list of files (dirs → their files)."""
    files: list[Path] = []
    for p in paths:
        path = Path(p)
        if path.is_dir():
            files.extend(sorted(f for f in path.iterdir() if f.is_file() and not f.name.startswith(".")))
        elif path.is_file():
            files.append(path)
        else:
            console.print(f"[red]Path not found: {p}[/red]")
            raise typer.Exit(1)
    if not files:
        console.print("[yellow]No documents to run.[/yellow]")
        raise typer.Exit(1)
    return files


def _submit_pipeline_doc(
    client: httpx.Client, base_url: str, headers: dict, pipeline: str, path: Path, group: str | None
) -> dict:
    """POST one document to the pipeline's manual-run endpoint. Returns the 202 body."""
    mime, _ = mimetypes.guess_type(path.name)
    data = {"group": group} if group else None
    with path.open("rb") as fh:
        files = {"file": (path.name, fh, mime or "application/octet-stream")}
        resp = client.post(f"{base_url}/api/pipelines/{pipeline}/run", files=files, data=data, headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 404:
        console.print(f"[red]Pipeline '{pipeline}' not found.[/red]")
        raise typer.Exit(1)
    if resp.status_code not in (200, 202):
        _api_error(resp, f"run {path.name}")
    return resp.json()


def _fetch_job_docs(client: httpx.Client, base_url: str, headers: dict, job_slug: str) -> list[dict]:
    """GET the top-level documents for a job (the dashboard's job view data)."""
    resp = client.get(f"{base_url}/api/jobs/{job_slug}/documents", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 404:
        console.print(f"[red]Job '{job_slug}' not found.[/red]")
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"fetch job {job_slug}")
    return [{**d, "jobSlug": job_slug} for d in resp.json().get("data", [])]


def _poll_pipeline_jobs(
    client: httpx.Client, base_url: str, headers: dict, submitted: list[dict], timeout_s: int
) -> list[dict]:
    """Poll each submitted job until its document reaches a terminal state.

    `submitted` is a list of {filename, jobSlug, jobId, documentId}. Returns the
    document rows in submission order, each tagged with its jobSlug. On timeout the
    still-running docs come back with status "timeout" so the caller can report them.
    """
    deadline = time.monotonic() + max(1, timeout_s)
    results: dict[str, dict] = {}
    pending = {s["jobSlug"]: s for s in submitted if s.get("jobSlug")}
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} docs"),
        console=err_console,
        transient=True,
    ) as progress:
        task = progress.add_task("running pipeline", total=len(submitted))
        while pending:
            if time.monotonic() > deadline:
                progress.stop()
                console.print(
                    f"[red]✗[/red] timed out after {timeout_s}s waiting on {len(pending)} doc(s). "
                    f"Fetch them later with [bold]koji pipeline result <jobSlug>[/bold]."
                )
                for s in pending.values():
                    results[s["documentId"]] = {**s, "status": "timeout"}
                break
            for slug, s in list(pending.items()):
                rows = _fetch_job_docs(client, base_url, headers, slug)
                doc = next((d for d in rows if d.get("id") == s.get("documentId")), rows[0] if rows else None)
                if doc and doc.get("status") in _TERMINAL_DOC_STATES:
                    results[s["documentId"]] = doc
                    del pending[slug]
            progress.update(task, completed=len(submitted) - len(pending))
            if pending:
                time.sleep(2)
    return [results[s["documentId"]] for s in submitted if s.get("documentId") in results]


def _render_pipeline_docs(docs: list[dict], show_prov: bool) -> None:
    """Render each document's status + extraction (mirrors the Build tab's Run output)."""
    for d in docs:
        status = d.get("status", "?")
        status_color = {
            "delivered": "green",
            "completed": "green",
            "review": "yellow",
            "failed": "red",
            "timeout": "red",
        }.get(status, "dim")
        conf = d.get("confidence")
        conf_disp = "" if conf is None else f"conf {float(conf) * 100:.0f}%"
        dur = d.get("durationMs")
        dur_disp = f"{dur / 1000:.1f}s" if dur else ""
        pages = d.get("pageCount")
        meta = "  ".join(
            part
            for part in [
                f"job {d.get('jobSlug', '')}" if d.get("jobSlug") else "",
                f"{pages}p" if pages else "",
                dur_disp,
                conf_disp,
            ]
            if part
        )
        console.print(
            f"\n[bold]{d.get('filename', '?')}[/bold]  "
            f"[{status_color}]{status}[/{status_color}]"
            f"{f'  [dim]{meta}[/dim]' if meta else ''}"
        )
        if status in ("failed", "timeout"):
            hint = "processing failed" if status == "failed" else "still running at timeout"
            console.print(f"  [red]{hint}[/red] — see the trace for detail.")
            continue
        extracted = d.get("extractionJson") or {}
        if not extracted:
            console.print("  [dim]no extraction output[/dim]")
            continue
        scores = d.get("confidenceScoresJson") or {}
        prov = d.get("provenanceJson") or {}
        table = Table(show_header=True, header_style="bold")
        table.add_column("Field")
        table.add_column("Value")
        table.add_column("Conf", justify="right")
        if show_prov:
            table.add_column("Source")
        for k in extracted:
            fc = scores.get(k)
            fc_disp = "" if fc is None else f"{float(fc) * 100:.0f}%"
            fc_color = "green" if (fc or 0) >= 0.8 else ("yellow" if (fc or 0) >= 0.5 else "red")
            row = [k, _fmt_value(extracted[k]), f"[{fc_color}]{fc_disp}[/{fc_color}]" if fc_disp else ""]
            if show_prov:
                p = prov.get(k) or {}
                snippet = (p.get("chunk") or "") if isinstance(p, dict) else ""
                row.append(_fmt_value(snippet, 40))
            table.add_row(*row)
        console.print(table)
    console.print()


@pipeline_app.command("run")
def pipeline_run(
    pipeline: str = typer.Argument(..., help="Pipeline slug."),
    paths: list[str] = typer.Argument(..., help="Document file(s) or a directory to run through the pipeline."),
    group: str = typer.Option(None, "--group", "-g", help="Tag all submitted docs with this grouping key."),
    no_wait: bool = typer.Option(
        False, "--no-wait", help="Submit and print job slugs immediately; don't wait for extraction."
    ),
    provenance: bool = typer.Option(
        False, "--provenance", help="Show the source snippet each extracted value came from."
    ),
    timeout_s: int = typer.Option(600, "--timeout", help="Max seconds to wait for docs to finish (sync mode)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Run one or more documents through a pipeline — the dashboard's manual-run path.

    Each document is submitted to POST /api/pipelines/<slug>/run, which parses,
    extracts, and routes it exactly as production ingestion does, creating a real
    job per document. By default the command waits for every document to reach a
    terminal state (completed / failed / review) and prints the extraction. Pass
    --no-wait to submit and return the job slugs so you (or an agent) can fetch the
    results later with `koji pipeline result <jobSlug>`.

    Works against a local cluster (KOJI_API_URL + KOJI_API_KEY) or the hosted
    platform (--profile / koji login), like the sibling pipeline commands.
    """
    files = _expand_input_paths(paths)
    base_url, headers = resolve_api(profile_name)
    submitted: list[dict] = []
    with httpx.Client(timeout=120) as client:
        for path in files:
            res = _submit_pipeline_doc(client, base_url, headers, pipeline, path, group)
            entry = {
                "filename": path.name,
                "jobSlug": res.get("jobSlug"),
                "jobId": res.get("jobId"),
                "documentId": res.get("documentId"),
            }
            if res.get("warnings"):
                entry["warnings"] = res["warnings"]
            submitted.append(entry)
            err_console.print(f"[green]✓[/green] submitted [cyan]{path.name}[/cyan] → job {res.get('jobSlug')}")
            for w in res.get("warnings") or []:
                err_console.print(f"  [yellow]![/yellow] {w}")

        if no_wait:
            if as_json:
                emit_json(submitted)
            else:
                console.print(
                    f"\n[dim]{len(submitted)} doc(s) submitted. Fetch results with "
                    f"[bold]koji pipeline result <jobSlug>[/bold].[/dim]"
                )
            return

        docs = _poll_pipeline_jobs(client, base_url, headers, submitted, timeout_s)

    if as_json:
        emit_json(docs)
    else:
        _render_pipeline_docs(docs, provenance)
    if any(d.get("status") in ("failed", "timeout") for d in docs):
        raise typer.Exit(1)


@pipeline_app.command("result")
def pipeline_result(
    job: str = typer.Argument(..., help="Job slug returned by `koji pipeline run --no-wait`."),
    wait: bool = typer.Option(False, "--wait", help="Block until every document in the job reaches a terminal state."),
    provenance: bool = typer.Option(
        False, "--provenance", help="Show the source snippet each extracted value came from."
    ),
    timeout_s: int = typer.Option(600, "--timeout", help="Max seconds to wait when --wait is set."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Fetch the documents + extraction for a submitted pipeline job.

    Reads GET /api/jobs/<slug>/documents — the same data the dashboard's job view
    shows. Pair with `koji pipeline run --no-wait`: submit now, fetch later. Pass
    --wait to block until processing finishes.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=120) as client:
        if wait:
            deadline = time.monotonic() + max(1, timeout_s)
            while True:
                docs = _fetch_job_docs(client, base_url, headers, job)
                if docs and all(d.get("status") in _TERMINAL_DOC_STATES for d in docs):
                    break
                if time.monotonic() > deadline:
                    console.print(f"[yellow]timed out after {timeout_s}s — returning current state.[/yellow]")
                    break
                time.sleep(2)
        else:
            docs = _fetch_job_docs(client, base_url, headers, job)

    if as_json:
        emit_json(docs)
    else:
        _render_pipeline_docs(docs, provenance)


# ── pipeline test: dry-run a doc and show the routing decision ────────
#
# Wraps POST /api/pipelines/<slug>/test — the same dry-run the dashboard's Test
# button uses. Unlike `pipeline run` (which creates a real job), test persists
# nothing: it parses via the tenant's provider, walks the DAG, and returns each
# step's output + which route matched at each branch. This is the tool for
# validating a router — you see the classify labels that fired, which branch was
# taken, which schema ran, and the extraction, without touching the job history.


def _render_pipeline_test(pipeline: str, filename: str, result: dict) -> None:
    """Render a /test dry-run: the path taken, each step's decision, extraction."""
    steps = result.get("steps") or []
    path = result.get("path") or []

    console.print(f"\n[bold]{pipeline}[/bold] [dim]test[/dim]  {filename}")
    if path:
        console.print(f"[dim]path:[/dim] {' → '.join(path)}")
    meta_bits = []
    if result.get("totalDurationMs") is not None:
        meta_bits.append(f"{result['totalDurationMs'] / 1000:.1f}s")
    if result.get("totalCostUsd") is not None:
        meta_bits.append(f"${result['totalCostUsd']:.4f}")
    if meta_bits:
        console.print(f"[dim]{'  '.join(meta_bits)}[/dim]")

    final_extract: dict | None = None
    for s in steps:
        stype = s.get("stepType")
        ok = s.get("status") == "completed"
        mark = "[green]▸[/green]" if ok else "[red]✗[/red]"
        dur = s.get("durationMs")
        dur_disp = f"  [dim]{dur}ms[/dim]" if dur else ""
        out = s.get("output") or {}
        console.print(f"\n{mark} [bold]{s.get('stepId')}[/bold] [dim]({stype})[/dim]{dur_disp}")
        if s.get("error"):
            console.print(f"    [red]{escape(str(s['error']))}[/red]")

        if stype == "classify":
            conf = out.get("confidence")
            conf_disp = f"  conf {float(conf) * 100:.0f}%" if conf is not None else ""
            console.print(
                f"    label: [cyan]{escape(str(out.get('label', '?')))}[/cyan]{conf_disp}  "
                f"[dim]method: {escape(str(out.get('method', '')))}[/dim]"
            )
            if out.get("reasoning"):
                console.print(f"    [dim]{escape(_fmt_value(out['reasoning'], 90))}[/dim]")
        elif stype == "extract":
            if out.get("note"):
                console.print(f"    [yellow]{escape(str(out['note']))}[/yellow]")
            elif out.get("fields") is not None:
                conf = out.get("confidence")
                conf_disp = f"  conf {float(conf) * 100:.0f}%" if conf else ""
                console.print(
                    f"    schema: [cyan]{escape(str(out.get('schema', '?')))}[/cyan]  "
                    f"{out.get('fieldCount', 0)}/{out.get('totalFields', 0)} fields{conf_disp}"
                )
                final_extract = out

        # Which route matched at this branch (the router decision).
        for e in s.get("edgeEvaluations") or []:
            cond = escape(str(e.get("condition") or "→"))
            to = escape(str(e.get("to")))
            if e.get("matched"):
                console.print(f"    [green]✓[/green] {cond} → [cyan]{to}[/cyan]")
            else:
                console.print(f"    [dim]✗ {cond} → {to}[/dim]")

    if result.get("skippedSteps"):
        console.print(f"\n[dim]skipped: {', '.join(result['skippedSteps'])}[/dim]")

    if final_extract and final_extract.get("fields"):
        scores = final_extract.get("confidenceScores") or {}
        console.print("\n[bold]Extraction[/bold]")
        table = Table(show_header=True, header_style="bold")
        table.add_column("Field")
        table.add_column("Value")
        table.add_column("Conf", justify="right")
        for k, v in final_extract["fields"].items():
            fc = scores.get(k)
            fc_disp = "" if fc is None else f"{float(fc) * 100:.0f}%"
            fc_color = "green" if (fc or 0) >= 0.8 else ("yellow" if (fc or 0) >= 0.5 else "red")
            table.add_row(k, _fmt_value(v), f"[{fc_color}]{fc_disp}[/{fc_color}]" if fc_disp else "")
        console.print(table)
    console.print()


@pipeline_app.command("test")
def pipeline_test(
    pipeline: str = typer.Argument(..., help="Pipeline slug."),
    path: str = typer.Argument(..., help="Document file to dry-run through the pipeline."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Dry-run a document through a pipeline and show the routing decision.

    Submits the doc to POST /api/pipelines/<slug>/test — the same dry-run the
    dashboard's Test button uses. It parses (via the tenant's parse provider) and
    walks the DAG, showing each classify step's label / confidence / method, which
    route matched at every branch, the path taken, and the final extraction.
    Nothing is persisted — no job is created. Use this to validate a router (which
    classifier fired, which schema ran) before sending real documents through it
    with `koji pipeline run`.

    Gated by the pipeline:write permission. Resolves against a local cluster or
    the hosted platform, like the sibling pipeline commands.
    """
    file_path = Path(path)
    if not file_path.is_file():
        console.print(f"[red]File not found: {path}[/red]")
        raise typer.Exit(1)

    base_url, headers = resolve_api(profile_name)
    mime, _ = mimetypes.guess_type(file_path.name)
    with httpx.Client(timeout=300) as client:
        with file_path.open("rb") as fh:
            files = {"file": (file_path.name, fh, mime or "application/octet-stream")}
            resp = client.post(f"{base_url}/api/pipelines/{pipeline}/test", files=files, headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 404:
        console.print(f"[red]Pipeline '{pipeline}' not found.[/red]")
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"test {pipeline}")
    result = resp.json()

    if as_json:
        emit_json(result)
        return
    _render_pipeline_test(pipeline, file_path.name, result)


@pipeline_app.command("bench")
def pipeline_bench(
    pipeline: str = typer.Argument(..., help="Pipeline slug to run each corpus document through."),
    corpus: str = typer.Option(..., "--corpus", help="Path to the corpus repo root."),
    category: str = typer.Option(None, "--category", "-c", help="Only run this corpus category."),
    limit: int = typer.Option(None, "--limit", "-n", help="Max documents per category (fast runs)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Run a labeled corpus against a pipeline (DAG) and score routing + extraction.

    Each corpus document is sent through POST /api/pipelines/<slug>/test — the same
    dry-run the dashboard Test button uses, which parses, classifies, routes, and
    extracts exactly as production but persists nothing. Two things are scored:

    \b
      • Routing    — did the doc reach the schema its manifest names?
      • Extraction — do the fields at that terminal schema match .expected.json?

    Extraction is scored only for correctly-routed docs (a mis-route makes field
    scores meaningless), and is broken out per terminal schema since outputs vary
    by the path a doc takes through the DAG. Point this at a *mixed* corpus whose
    documents route to different schemas to exercise routing.

    Nothing is persisted — no jobs are created. Requires the pipeline:write
    permission (same as `koji pipeline test`).
    """
    from .pipeline_bench import format_report, run_pipeline_bench

    corpus_root = Path(corpus)
    if not corpus_root.is_dir():
        console.print(f"[red]Corpus path not found: {corpus}[/red]")
        raise typer.Exit(1)

    base_url, headers = resolve_api(profile_name)

    # Progress renders to stderr so stdout stays pure for --json.
    with httpx.Client() as client:
        if as_json:
            result = run_pipeline_bench(
                pipeline=pipeline,
                corpus_root=corpus_root,
                base_url=base_url,
                headers=headers,
                http_client=client,
                category_filter=category,
                document_limit=limit,
            )
        else:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TextColumn("{task.completed}/{task.total}"),
                console=Console(stderr=True),
                transient=True,
            ) as progress:
                task_id = progress.add_task(f"bench {pipeline}", total=None)

                def _cb(cat: str, i: int, total: int, name: str) -> None:
                    progress.update(task_id, total=total, completed=i, description=f"[{cat}] {name}")

                result = run_pipeline_bench(
                    pipeline=pipeline,
                    corpus_root=corpus_root,
                    base_url=base_url,
                    headers=headers,
                    http_client=client,
                    category_filter=category,
                    document_limit=limit,
                    progress_callback=_cb,
                )

    if as_json:
        emit_json(result.to_dict())
        return

    if result.total_documents == 0:
        console.print(f"[yellow]No benchmarkable documents found in {corpus}[/yellow]")
        raise typer.Exit(1)
    console.print(format_report(result))


# ── Classifiers: run / versions / promote / release ───────────────────
#
# Mirrors the schema group (versions / promote / release) plus a `run` verb
# that drives the standalone POST /api/classify primitive. A classifier gets
# the same lifecycle CLI as a schema: iterate, snapshot candidates, promote a
# candidate to a live release, or release directly.


def _find_local_classifier(slug: str) -> Path | None:
    """Look for a local classifier config file matching a slug (cwd or classifiers/)."""
    for cand in (
        Path(f"{slug}.yaml"),
        Path(f"{slug}.yml"),
        Path("classifiers") / f"{slug}.yaml",
        Path("classifiers") / f"{slug}.yml",
    ):
        if cand.is_file():
            return cand
    return None


def _load_classifier_arg(classifier: str) -> tuple[str, str | None, Path | None]:
    """Resolve the `classifier` argument to (slug, local_yaml_or_None, local_path_or_None).

    Accepts either a path to a YAML file or a bare slug. For a bare slug we try to
    locate a matching local file so the loop can edit a file and push it; if none
    is found, the slug is used to fetch the server-side config.
    """
    if _looks_like_path(classifier):
        path = Path(classifier)
        if not path.is_file():
            console.print(f"[red]Classifier file not found: {classifier}[/red]")
            raise typer.Exit(1)
        text = path.read_text()
        try:
            doc = yaml_mod.safe_load(text) or {}
        except yaml_mod.YAMLError as e:
            console.print(f"[red]Invalid YAML in {classifier}: {e}[/red]")
            raise typer.Exit(1) from e
        slug = doc.get("name") or doc.get("slug") or path.stem
        return slug, text, path

    local = _find_local_classifier(classifier)
    if local is not None:
        return classifier, local.read_text(), local
    return classifier, None, None


def _fetch_classifier(client: httpx.Client, base_url: str, headers: dict, slug: str) -> dict:
    """Fetch a classifier's record (draft + released version)."""
    resp = client.get(f"{base_url}/api/classifiers/{slug}", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code == 404:
        console.print(f"[red]Classifier '{slug}' not found.[/red]")
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"fetch classifier {slug}")
    return resp.json()


def _fetch_classifier_versions(client: httpx.Client, base_url: str, headers: dict, slug: str) -> list[dict]:
    resp = client.get(f"{base_url}/api/classifiers/{slug}/versions", headers=headers)
    if _auth_error(resp, base_url):
        raise typer.Exit(1)
    if resp.status_code != 200:
        _api_error(resp, f"list versions for {slug}")
    body = resp.json()
    return body.get("versions") or body.get("data") or []


def _resolve_classifier_config(
    client: httpx.Client,
    base_url: str,
    headers: dict,
    slug: str,
    prefer_draft: bool = False,
) -> tuple[str, str]:
    """Return ``(config_yaml, source_label)`` for a classifier slug.

    By default resolves the **released** version — the one the ingestion pipeline
    runs (its ``currentVersionId``) — so a standalone ``classify run`` routes a
    document exactly as the pipeline will. This is the whole point of the
    primitive: it must be a faithful proxy for production routing.

    The previous implementation returned ``latestVersion`` (the highest version
    NUMBER), which silently diverged whenever an unreleased candidate existed —
    ``classify run`` ran the draft while the pipeline ran the release, and the
    two disagreed with no indication why.

    ``prefer_draft=True`` runs the latest unreleased draft/candidate instead, for
    iterating before release. With no released version, falls back to the draft
    regardless.
    """
    record = _fetch_classifier(client, base_url, headers, slug)
    latest = record.get("latestVersion") or {}
    draft = record.get("draftYaml")

    if prefer_draft:
        if draft:
            return draft, "draft"
        if latest.get("yamlSource"):
            return latest["yamlSource"], f"latest {latest.get('version', '?')} (no separate draft)"
        console.print(f"[red]Classifier '{slug}' has no draft to run.[/red]")
        raise typer.Exit(1)

    # Released version = the one the pipeline uses (active == currentVersionId).
    versions = _fetch_classifier_versions(client, base_url, headers, slug)
    active = next((v for v in versions if v.get("active")), None)
    if active is not None:
        num = active.get("versionNumber")
        label = active.get("version", "?")
        # The released version is often also the latest — reuse its inlined yaml.
        if latest.get("versionNumber") == num and latest.get("yamlSource"):
            return latest["yamlSource"], f"released {label}"
        resp = client.get(f"{base_url}/api/classifiers/{slug}/versions/{num}", headers=headers)
        if resp.status_code == 200 and resp.json().get("yamlSource"):
            return resp.json()["yamlSource"], f"released {label}"

    # No released version yet — fall back to the draft so a fresh classifier is
    # still runnable, but say so.
    if draft:
        return draft, "draft (no released version)"
    console.print(f"[red]Classifier '{slug}' has no released version or draft to run.[/red]")
    raise typer.Exit(1)


def _render_classify(filename: str, r: dict) -> None:
    """Pretty-print a classify outcome."""
    label = r.get("label", "?")
    conf = r.get("confidence")
    conf_disp = f"{float(conf) * 100:.1f}%" if conf is not None else "[dim]—[/dim]"
    tier = r.get("tier_used")
    tier_disp = str(tier) if tier is not None else "[dim]—[/dim]"
    page = r.get("evidence_page")
    page_disp = f"page {page}" if page is not None else "[dim]—[/dim]"

    table = Table(show_header=False, box=None, pad_edge=False)
    table.add_column(style="dim")
    table.add_column()
    table.add_row("Document", filename)
    table.add_row("Label", f"[cyan]{label}[/cyan]")
    table.add_row("Confidence", conf_disp)
    table.add_row("Method", str(r.get("method") or "[dim]—[/dim]"))
    table.add_row("Tier", tier_disp)
    table.add_row("Evidence", page_disp)
    console.print(table)


def _render_classifier_validate(slug: str, r: dict) -> None:
    """Pretty-print a classifier backtest result (oss-453 scoring shape)."""
    acc = r.get("accuracy")
    acc_disp = f"{acc:.1f}%" if isinstance(acc, (int, float)) else "?"
    total = r.get("docsTotal") or 0
    correct = r.get("docsCorrect") or 0
    failed = r.get("docsFailed") or 0
    esc = r.get("escalationRate")
    esc_disp = f"{esc * 100:.0f}%" if isinstance(esc, (int, float)) else "—"
    version = r.get("version") or "?"
    failed_disp = f"  [red]{failed} failed[/red]" if failed else ""
    console.print(
        f"\n[bold]{slug}[/bold]  "
        f"accuracy [bold]{acc_disp}[/bold]   "
        f"docs {correct}/{total}{failed_disp}   "
        f"escalation {esc_disp}   "
        f"[cyan]{version}[/cyan]\n"
    )

    # Per-class precision / recall / F1.
    by_class = r.get("byClass") or []
    if by_class:
        table = Table(show_header=True, header_style="bold", title="per class")
        table.add_column("Class")
        table.add_column("Support", justify="right")
        table.add_column("Pred", justify="right")
        table.add_column("P", justify="right")
        table.add_column("R", justify="right")
        table.add_column("F1", justify="right")

        def pct(v: object) -> str:
            return f"{v * 100:.0f}" if isinstance(v, (int, float)) else "[dim]—[/dim]"

        for cl in by_class:
            table.add_row(
                cl.get("label", ""),
                str(cl.get("support", 0)),
                str(cl.get("predicted", 0)),
                pct(cl.get("precision")),
                pct(cl.get("recall")),
                pct(cl.get("f1")),
            )
        console.print(table)

    # Confusion matrix (expected rows × predicted columns). The off-diagonal
    # cells are the actionable signal — *which* class a doc was mistaken for.
    confusion = r.get("confusion") or []
    if confusion:
        labels: list[str] = [cl.get("label", "") for cl in by_class]
        for cell in confusion:
            for key in ("expected", "predicted"):
                lab = cell.get(key)
                if lab and lab not in labels:
                    labels.append(lab)
        counts: dict[tuple[str, str], int] = {
            (c.get("expected"), c.get("predicted")): c.get("count", 0) for c in confusion
        }
        matrix = Table(show_header=True, header_style="bold", title="confusion (expected → predicted)")
        matrix.add_column("exp ╲ pred", style="dim")
        for lab in labels:
            matrix.add_column(lab, justify="right")
        for exp in labels:
            row = [exp]
            for pred in labels:
                n = counts.get((exp, pred), 0)
                if n == 0:
                    row.append("[dim]·[/dim]")
                elif exp == pred:
                    row.append(f"[green]{n}[/green]")
                else:
                    row.append(f"[red]{n}[/red]")
            matrix.add_row(*row)
        console.print(matrix)

    # Tier histogram — where the cost went (tiers 0-2 are free, 3-4 paid).
    hist = r.get("tierHistogram") or {}
    if hist:
        tiers = ", ".join(f"t{k}={hist[k]}" for k in sorted(hist))
        console.print(f"\n[dim]tiers:[/dim] {tiers}")

    # Flips vs the previous run.
    flips = r.get("flips") or {}
    fixed, regressed, churned = flips.get("fixed", 0), flips.get("regressed", 0), flips.get("churned", 0)
    if fixed or regressed or churned:
        console.print(
            f"[dim]vs prev:[/dim] [green]+{fixed} fixed[/green]  "
            f"[red]-{regressed} regressed[/red]  [yellow]{churned} churned[/yellow]"
        )
    console.print()


classify_app = typer.Typer(
    help="Run and manage classifiers — classify a document, list versions, promote a candidate, or release.",
    no_args_is_help=True,
)


def _classifier_window(config_yaml: str) -> tuple[int, str]:
    """Return ``(effective_window, scan)`` for a classifier config.

    Mirrors the engine's `effectiveWindow`: the deepest window any class asks
    for, since the cascade reads one window for all of them. `scan` decides
    WHICH pages that window selects — `head` takes the first N, `head_and_tail`
    splits the budget across both ends, so a head-only truncation would drop
    half of what the server reads.
    """
    import yaml as yaml_mod

    try:
        parsed = yaml_mod.safe_load(config_yaml) or {}
    except Exception:
        return 1, "head"
    classify_block = parsed.get("classify") or {}
    window = classify_block.get("window")
    window = window if isinstance(window, int) and window > 0 else 1
    scan = classify_block.get("scan") or "head"
    classes = parsed.get("classes") or {}
    if isinstance(classes, dict):
        for cls in classes.values():
            if not isinstance(cls, dict):
                continue
            w = cls.get("window")
            if isinstance(w, int) and w > window:
                window = w
    return window, str(scan)


# The API rejects a request body over ~4.5 MB. Slice below that, with headroom
# for the multipart envelope and the config field.
_UPLOAD_SLICE_THRESHOLD = 4_000_000


def _slice_for_upload(data: bytes, max_pages: int, window: int, scan: str) -> bytes:
    """Return the bytes to upload for `classify run`, slicing only if needed.

    `max_pages > 0` is an explicit instruction: slice to the first N pages and
    warn if that is fewer than the classifier's window, because the pages
    carrying its signals may not be in the upload. `max_pages < 0` is the
    default: send the document whole unless it is too big, and if it is, keep
    the pages the window actually reads rather than an arbitrary prefix.
    """
    if max_pages > 0:
        capped = _cap_pdf_pages(data, max_pages)
        if capped is None:
            return data
        sliced, kept, total = capped
        note = f"[dim]uploading the first {kept} of {total} pages (--max-pages {max_pages})[/dim]"
        if kept < window:
            note = (
                f"[yellow]uploading the first {kept} of {total} pages, but this classifier reads a "
                f"window of {window} — pages {kept + 1}-{window} are missing from the upload, so a "
                f"keyword on them cannot match. Raise --max-pages or pass 0 to send everything.[/yellow]"
            )
        err_console.print(note)
        return sliced

    if len(data) <= _UPLOAD_SLICE_THRESHOLD:
        return data

    # Too large to upload whole. Keep exactly what the server would read.
    capped = _cap_pdf_pages(data, window) if scan != "head_and_tail" else None
    if capped is None:
        # head_and_tail reads from both ends, so a head slice would drop half of
        # it. Send the document as-is and let the API answer — a 413 the user
        # can see beats a silently truncated classification.
        err_console.print(
            f"[yellow]{len(data) // 1_000_000} MB document may exceed the upload limit; sending it whole "
            f"because a {scan} window can't be sliced from the front without dropping pages the "
            f"classifier reads.[/yellow]"
        )
        return data
    sliced, kept, total = capped
    err_console.print(
        f"[yellow]{len(data) // 1_000_000} MB document sliced to the first {kept} of {total} pages — the "
        f"window this classifier reads. Scores can differ from the whole document.[/yellow]"
    )
    return sliced


def _cap_pdf_pages(data: bytes, max_pages: int) -> tuple[bytes, int, int] | None:
    """If `data` is a PDF with more than `max_pages` pages, return (first-N-pages
    bytes, kept, total). Returns None when no capping is needed or possible
    (not a readable PDF, already short enough) — the caller then sends it as-is.
    """
    import io

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return None
    try:
        reader = PdfReader(io.BytesIO(data))
        total = len(reader.pages)
        if total <= max_pages:
            return None
        writer = PdfWriter()
        for page in reader.pages[:max_pages]:
            writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        return buf.getvalue(), max_pages, total
    except Exception:
        # Malformed/encrypted PDF — let the server deal with the original bytes.
        return None


@classify_app.command("run")
def classify_run(
    classifier: str = typer.Argument(..., help="Classifier slug, or path to a local classifier YAML."),
    document: Path = typer.Argument(..., exists=True, dir_okay=False, help="Document to classify."),
    max_pages: int = typer.Option(
        -1,
        "--max-pages",
        help="For multi-page PDFs, upload only the first N pages (0 = send all). "
        "The default (-1) sends the whole document unless it is too large for the "
        "API's upload limit, in which case it slices to the pages the classifier's "
        "`window` actually reads.",
    ),
    draft: bool = typer.Option(
        False,
        "--draft",
        help="Run the latest unreleased draft/candidate instead of the released version. "
        "Use while iterating before release; the default matches what the pipeline runs.",
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Classify one document and show the label, confidence, method, and tier.

    Uses the LOCAL classifier YAML if a file is found (so you can iterate without
    pushing); otherwise the server's RELEASED version — the same version the
    ingestion pipeline runs. Pass --draft to run the latest unreleased candidate
    instead. Drives the standalone POST /api/classify primitive — nothing is
    persisted.

    Two caveats before you treat the result as what the pipeline will do. A
    pipeline classifies the document its parse step produced, which for a
    scanned PDF may differ from the bytes on disk. And if this command has to
    slice a large PDF to fit the upload limit, it says so — a sliced document
    can score differently from the whole one.

    The whole document is uploaded by default. Only when it exceeds the API's
    request-body limit is it sliced, and then to the pages the classifier's
    `window`/`scan` actually read, never fewer. `--max-pages N` forces a slice
    to the first N pages; `--max-pages 0` always sends everything.
    """
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, local_path = _load_classifier_arg(classifier)
    if local_yaml is not None and draft:
        err_console.print("[yellow]--draft ignored: running the local file instead.[/yellow]")
    content_type = mimetypes.guess_type(document.name)[0] or "application/octet-stream"
    upload_bytes = document.read_bytes()
    with httpx.Client(timeout=300) as client:
        if local_yaml is not None:
            config, source = local_yaml, f"local file {local_path}"
        else:
            config, source = _resolve_classifier_config(client, base_url, headers, slug, prefer_draft=draft)
        # Always say which config ran — silent source selection is exactly what
        # made `classify run` disagree with the pipeline without explanation.
        err_console.print(f"[dim]config: {source}[/dim]")

        # Slicing the PDF client-side is purely an upload-size measure: the
        # server reads only the pages `window`/`scan` select no matter how long
        # the document is. A fixed 3-page default therefore bought nothing on a
        # small file and silently defeated any classifier whose window reached
        # past page 3 — the keyword tier never saw the pages carrying its
        # signals, and the command reported `unknown` while the pipeline (which
        # gets the whole document) labelled it correctly.
        if content_type == "application/pdf" and max_pages != 0:
            window, scan = _classifier_window(config)
            upload_bytes = _slice_for_upload(upload_bytes, max_pages, window, scan)

        resp = client.post(
            f"{base_url}/api/classify",
            files={"file": (document.name, upload_bytes, content_type)},
            data={"config": config},
            headers={**headers, "Accept": "application/json"},
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 422):
            _api_error(resp, f"classify {document.name}")
        result = resp.json()

    if as_json:
        emit_json(result)
        return
    _render_classify(document.name, result)
    if result.get("label") == "unknown":
        console.print("[yellow]No class matched (unknown).[/yellow]")


@classify_app.command("versions")
def classify_versions(
    slug: str = typer.Argument(..., help="Classifier slug."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List a classifier's versions — released lineage + candidates."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        versions = _fetch_classifier_versions(client, base_url, headers, slug)

    if as_json:
        emit_json(versions)
        return
    if not versions:
        console.print(f"[yellow]No versions for {slug} yet.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("Version")
    table.add_column("Kind")
    table.add_column("Message")
    table.add_column("By")
    for v in versions:
        kind = "[magenta]candidate[/magenta]" if v.get("prerelease") else "[green]released[/green]"
        table.add_row(
            str(v.get("versionNumber", "")),
            kind,
            v.get("commitMessage") or "[dim]—[/dim]",
            v.get("committedByName") or "[dim]—[/dim]",
        )
    console.print(table)
    console.print(f"\n[dim]{len(versions)} version(s)[/dim]")


def _parse_class_floor(pairs: list[str], flag: str) -> dict[str, float]:
    """Parse repeated `class=value` options into {class: float}. Exits on a bad pair."""
    out: dict[str, float] = {}
    for p in pairs:
        if "=" not in p:
            console.print(f"[red]{flag} expects class=value (e.g. coi=0.9), got '{p}'.[/red]")
            raise typer.Exit(1)
        cls_name, _, raw = p.partition("=")
        try:
            out[cls_name.strip()] = float(raw)
        except ValueError:
            console.print(f"[red]{flag} value for '{cls_name}' must be a number (0..1), got '{raw}'.[/red]")
            raise typer.Exit(1) from None
    return out


@classify_app.command("promote")
def classify_promote(
    slug: str = typer.Argument(..., help="Classifier slug."),
    require_no_regressions: bool = typer.Option(
        False,
        "--require-no-regressions",
        help="Refuse if ANY class's recall or precision dropped vs. the live release.",
    ),
    must_not_regress: list[str] = typer.Option(
        None,
        "--must-not-regress",
        help="Refuse if this class regressed vs. the live release. Repeatable.",
    ),
    min_recall: list[str] = typer.Option(
        None, "--min-recall", help="Absolute recall floor for a class: class=0.9. Repeatable."
    ),
    min_precision: list[str] = typer.Option(
        None, "--min-precision", help="Absolute precision floor for a class: class=0.9. Repeatable."
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Graduate the latest candidate to a release and make it live (gated by deploy).

    Optionally gate the promotion on the candidate's latest backtest so tuning
    that lifts one class can't quietly cost another (run `koji classify validate`
    first): --require-no-regressions blocks any class dropping vs. the live
    release; --must-not-regress names specific classes; --min-recall/--min-precision
    set absolute floors (`class=0.9`). A blocked promotion lists the offending
    class and its before → after numbers. `koji classify release` bypasses the gate.
    """
    body: dict = {}
    if require_no_regressions:
        body["requireNoRegressions"] = True
    if must_not_regress:
        body["mustNotRegress"] = must_not_regress
    floors_recall = _parse_class_floor(min_recall or [], "--min-recall")
    floors_precision = _parse_class_floor(min_precision or [], "--min-precision")
    if floors_recall:
        body["minRecall"] = floors_recall
    if floors_precision:
        body["minPrecision"] = floors_precision

    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=120) as client:
        resp = client.post(f"{base_url}/api/classifiers/{slug}/promote", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        # A gate refusal (409) carries structured `blocked` details — surface the
        # offending class + its before/after numbers, not a bare error line.
        if resp.status_code == 409:
            payload = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            blocked = payload.get("blocked") if isinstance(payload, dict) else None
            if blocked:

                def _pct(v: object) -> str:
                    return f"{v * 100:.0f}%" if isinstance(v, (int, float)) else "—"

                console.print(f"[red]✗ promotion blocked[/red] — {slug} would regress:")
                for b in blocked:
                    metric = b.get("metric", "")
                    cls_name = b.get("class", "")
                    if b.get("kind") == "floor":
                        console.print(
                            f"  [red]•[/red] {cls_name} {metric} {_pct(b.get('after'))} < floor {_pct(b.get('floor'))}"
                        )
                    else:
                        console.print(
                            f"  [red]•[/red] {cls_name} {metric} {_pct(b.get('before'))} → {_pct(b.get('after'))}"
                        )
                console.print(
                    "\n[dim]Fix the regression, re-validate, and promote again — "
                    "or `koji classify release` to bypass the gate.[/dim]"
                )
                raise typer.Exit(1)
            # A 409 without block details (e.g. no backtest to gate on) — show the message.
            _api_error(resp, f"promote {slug}")
        if resp.status_code != 200:
            _api_error(resp, f"promote {slug}")
        result = resp.json()

    if as_json:
        emit_json(result)
        return
    released = result.get("released") or result.get("versionNumber")
    console.print(f"[green]✓[/green] released [cyan]{released}[/cyan] — now live")


@classify_app.command("release")
def classify_release(
    classifier: str = typer.Argument(..., help="Classifier slug, or path to a local classifier YAML to release."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Release a classifier directly to a full version, skipping the rc loop.

    Sends your local YAML if given a path; otherwise releases the server-side
    draft. Makes the new version live (gated by the deploy permission).
    """
    base_url, headers = resolve_api(profile_name)
    slug, local_yaml, _ = _load_classifier_arg(classifier)
    body: dict = {}
    if local_yaml:
        body["yaml"] = local_yaml
    with httpx.Client(timeout=120) as client:
        resp = client.post(f"{base_url}/api/classifiers/{slug}/release", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"release {slug}")
        result = resp.json()

    if as_json:
        emit_json(result)
        return
    released = result.get("released") or result.get("versionNumber")
    console.print(f"[green]✓[/green] released [cyan]{released}[/cyan] — now live")


@classify_app.command("delete")
def classify_delete(
    slug: str = typer.Argument(..., help="Classifier slug to delete."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Delete a classifier and all its versions.

    Removes the classifier from the project. Pipelines that reference it by slug
    will fail to resolve it until it's recreated. Use to clean up a test
    classifier or to recreate one from scratch.
    """
    if not yes:
        typer.confirm(f"Delete classifier '{slug}' and all its versions?", abort=True)
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.delete(f"{base_url}/api/classifiers/{slug}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 204):
            _api_error(resp, f"delete {slug}")
    console.print(f"[green]✓[/green] deleted classifier [cyan]{slug}[/cyan]")


@classify_app.command("validate")
def classify_validate(
    slug: str = typer.Argument(..., help="Classifier slug."),
    version: str = typer.Option(
        None, "--version", help="Backtest a specific version (semver label or id prefix). Default: the released one."
    ),
    check: bool = typer.Option(False, "--check", help="Exit non-zero if any class regressed vs the previous run."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON instead of a table."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Backtest a classifier against its labelled corpus.

    Classifies every labelled corpus document through the same cascade
    production uses and scores predicted vs. ground truth. By default backtests
    the **released** version; pass --version to pin a specific one (the same
    selector `koji classify run` uses, so a backtest and a live route agree).

    Prints accuracy, per-class precision/recall/F1, the confusion matrix, the
    tier histogram + escalation rate (the share of docs that needed the paid
    LLM/vision tail), and flips vs. the previous run. Mirrors `koji validate`.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=300) as client:
        body: dict = {"async": True}
        if version:
            body["version"] = version
        resp = client.post(f"{base_url}/api/classifiers/{slug}/validate", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 202:
            # Async run: each labelled doc runs as its own job server-side
            # (no request races a timeout — oss-348). Poll for the result.
            queued = resp.json()
            result = _poll_validate_run(client, base_url, headers, slug, queued, resource="classifiers")
            result.setdefault("version", queued.get("version"))
        elif resp.status_code == 200:
            # Older server without async classifier validate — full result inline.
            result = resp.json()
        else:
            _api_error(resp, f"validate {slug}")
            return  # unreachable — _api_error raises

    if as_json:
        emit_json(result)
    else:
        _render_classifier_validate(slug, result)
    regressed = (result.get("flips") or {}).get("regressed", 0)
    if check and regressed:
        raise typer.Exit(1)


# ── Commands: classifier corpus group ─────────────────────────────────
# A classifier's corpus is label-based (each entry asserts the class a document
# *should* get), so this is a distinct surface from the schema `corpus` group
# (which carries extraction ground truth, tags, and per-doc extraction diffs).
# Documents live in the shared project pool — `add` uploads + labels; a doc
# already pooled by a schema corpus can be attached by id.

classify_corpus_app = typer.Typer(
    help="Manage a classifier's backtest corpus (documents + their expected class label).",
    no_args_is_help=True,
)
classify_app.add_typer(classify_corpus_app, name="corpus")


@classify_corpus_app.command("ls")
def classify_corpus_ls(
    slug: str = typer.Argument(..., help="Classifier slug."),
    label: str = typer.Option(None, "--label", help="Only entries carrying this class label."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List a classifier's labelled corpus documents."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.get(f"{base_url}/api/classifiers/{slug}/corpus", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 404:
            console.print(f"[red]Classifier '{slug}' not found.[/red]")
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"list corpus for {slug}")
        entries = resp.json().get("data", [])

    if label:
        entries = [e for e in entries if e.get("label") == label]
    if as_json:
        emit_json(entries)
        return
    if not entries:
        console.print("[yellow]No matching corpus entries.[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("ID", style="dim")
    table.add_column("Filename")
    table.add_column("Label")
    table.add_column("Status")
    table.add_column("Source")
    for e in entries:
        # Approved label (scored) vs an agent-proposed draft (not yet scored).
        approved = e.get("label")
        proposed = e.get("proposedLabel")
        status = e.get("reviewStatus")
        if approved:
            label_disp = approved
            status_disp = "[green]approved[/green]"
        elif status == "draft" and proposed:
            agent = " [dim](agent)[/dim]" if e.get("authoredViaAgent") else ""
            label_disp = f"[yellow]{proposed}?[/yellow]"
            status_disp = f"[yellow]draft[/yellow]{agent}"
        else:
            label_disp = "[dim]—[/dim]"
            status_disp = "[dim]unlabeled[/dim]"
        table.add_row(
            (e.get("id") or "")[:8],
            e.get("filename", ""),
            label_disp,
            status_disp,
            e.get("source", ""),
        )
    console.print(table)
    console.print(f"\n[dim]{len(entries)} doc(s)[/dim]")


@classify_corpus_app.command("add")
def classify_corpus_add(
    slug: str = typer.Argument(..., help="Classifier slug."),
    label: str = typer.Argument(
        ..., help="The class label this document should get (a released class id, or 'unknown')."
    ),
    files: list[str] = typer.Argument(..., help="One or more document files to upload and label."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Upload document(s) into a classifier's corpus with their expected label.

    Each file is pooled at the project level and labelled for this classifier.
    The label must be one of the classifier's released class ids (or 'unknown',
    a legitimate ground truth: "this document should fall through").
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=120) as client:
        for fp in files:
            path = Path(fp)
            if not path.is_file():
                console.print(f"  [red]✗[/red] {fp} — not found")
                continue
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            resp = client.post(
                f"{base_url}/api/classifiers/{slug}/corpus",
                files={"file": (path.name, path.read_bytes(), content_type)},
                data={"label": label},
                headers=headers,
            )
            if _auth_error(resp, base_url):
                raise typer.Exit(1)
            if resp.status_code not in (200, 201):
                _api_error(resp, f"add {path.name}")
            dedup = "  [dim](already labelled)[/dim]" if resp.status_code == 200 else ""
            console.print(f"  [green]✓[/green] {path.name} → [cyan]{label}[/cyan]{dedup}")


@classify_corpus_app.command("rm")
def classify_corpus_rm(
    slug: str = typer.Argument(..., help="Classifier slug."),
    entry: str = typer.Argument(..., help="Corpus entry id (or filename)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Remove a labelled document from a classifier's corpus.

    Soft-delete: the label drops out of the corpus (and future backtests) but
    the pooled file is retained. Use it to drop a mislabelled or off-type doc.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.get(f"{base_url}/api/classifiers/{slug}/corpus", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"list corpus for {slug}")
        entries = resp.json().get("data", [])
        matched = _resolve_entry(entries, entry)
        filename = matched.get("filename") or matched["id"]
        if not yes and not typer.confirm(f"Remove '{filename}' from the {slug} corpus?"):
            console.print("[dim]aborted[/dim]")
            raise typer.Exit(0)
        resp = client.delete(f"{base_url}/api/classifiers/{slug}/corpus/{matched['id']}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 204):
            _api_error(resp, f"remove {filename}")
    console.print(f"[green]✓[/green] removed {filename} from the {slug} corpus")


@classify_corpus_app.command("bootstrap")
def classify_corpus_bootstrap(
    slug: str = typer.Argument(..., help="Classifier slug."),
    limit: int = typer.Option(25, "--limit", help="Max unlabeled documents to label this run (max 50)."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Propose labels for unlabeled pool documents by running the classifier hot.

    Runs the classifier at max_tier 4 (the most accurate cascade) over the
    project's unlabeled pool documents and writes each result as a DRAFT label
    for review — labeling becomes reviewing instead of filling in. Drafts are
    NOT scored by a backtest until approved (`koji classify corpus approve`), so
    the classifier is never graded against its own guesses. Only documents not
    already in this classifier's corpus are touched; run again to continue.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=600) as client:
        resp = client.post(
            f"{base_url}/api/classifiers/{slug}/corpus/bootstrap",
            json={"limit": limit},
            headers=headers,
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code == 404:
            console.print(f"[red]Classifier '{slug}' not found.[/red]")
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"bootstrap {slug}")
        result = resp.json()

    if as_json:
        emit_json(result)
        return
    proposals = result.get("proposals", [])
    if not proposals:
        console.print(f"[yellow]{result.get('message') or 'No documents labelled.'}[/yellow]")
        return
    table = Table(show_header=True, header_style="bold")
    table.add_column("ID", style="dim")
    table.add_column("Filename")
    table.add_column("Proposed")
    table.add_column("Conf", justify="right")
    table.add_column("Tier", justify="right")
    for p in proposals:
        conf = p.get("confidence")
        conf_disp = f"{conf * 100:.0f}%" if isinstance(conf, (int, float)) else "—"
        table.add_row(
            (p.get("entryId") or "")[:8],
            p.get("filename") or "",
            f"[yellow]{p.get('proposedLabel')}[/yellow]",
            conf_disp,
            str(p.get("tierUsed") if p.get("tierUsed") is not None else "—"),
        )
    console.print(table)
    msg = f"\n[green]✓[/green] proposed {result.get('proposed')} draft label(s)"
    if result.get("skipped"):
        msg += f", [dim]{result['skipped']} skipped[/dim]"
    console.print(msg)
    if result.get("remainingHint"):
        console.print(f"[dim]{result['remainingHint']}[/dim]")
    console.print("[dim]Review and approve with `koji classify corpus approve`.[/dim]")


@classify_corpus_app.command("approve")
def classify_corpus_approve(
    slug: str = typer.Argument(..., help="Classifier slug."),
    entry: str = typer.Argument(..., help="Corpus entry id (or filename) with a draft label."),
    label: str = typer.Option(
        None, "--label", help="Correct the label before approving (a released class id, or 'unknown')."
    ),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Approve a draft label so the backtest starts scoring it.

    Promotes the entry's latest draft ground truth to `approved` and writes it
    into the scored ground truth. Pass --label to correct the proposal first.
    """
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.get(f"{base_url}/api/classifiers/{slug}/corpus", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"list corpus for {slug}")
        entries = resp.json().get("data", [])
        matched = _resolve_entry(entries, entry)
        gt_id = matched.get("latestGtId")
        if not gt_id:
            console.print(f"[red]{matched.get('filename') or matched['id']} has no draft label to approve.[/red]")
            raise typer.Exit(1)

        body = {"label": label} if label else {}
        resp = client.post(
            f"{base_url}/api/classifiers/{slug}/corpus/{matched['id']}/ground-truth/{gt_id}/approve",
            json=body,
            headers=headers,
        )
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, f"approve {matched.get('filename') or matched['id']}")
        approved = resp.json()
    console.print(
        f"[green]✓[/green] approved [cyan]{approved.get('label')}[/cyan] for {matched.get('filename') or matched['id']}"
    )


# ── Projects ──────────────────────────────────────────────────────────

project_app = typer.Typer(
    help="Manage projects — the intra-tenant boundary that scopes schemas, pipelines, classifiers, sources, and jobs.",
    no_args_is_help=True,
)


def _tenant_scope(headers: dict[str, str]) -> dict[str, str]:
    """Drop x-koji-project so a request resolves to the API key's own binding.
    Used for tenant-level views (project list) and reachability checks, so they
    work even when the active profile is pinned to a project the key can't reach
    (or that no longer exists) — without that, you can't even list projects to
    recover."""
    return {k: v for k, v in headers.items() if k.lower() != "x-koji-project"}


def _project_reachable(client: Any, base_url: str, headers: dict[str, str], slug: str) -> bool:
    """Can requests scoped to `slug` actually resolve with this key? Scopes the
    probe to the TARGET (not the profile's current pin), so it answers "will this
    project work if I switch to it" — 404 means either no such project or the key
    is bound to a different one (API keys are project-scoped)."""
    resp = client.get(f"{base_url}/api/projects/{slug}", headers={**_tenant_scope(headers), "x-koji-project": slug})
    return resp.status_code == 200


def _project_slugs(client: Any, base_url: str, headers: dict[str, str]) -> list[str]:
    resp = client.get(f"{base_url}/api/projects", headers=_tenant_scope(headers))
    if resp.status_code != 200:
        return []
    return [p.get("slug") for p in resp.json().get("data", [])]


def _switch_profile_project(profile_name: str | None, slug: str) -> bool:
    """Point a profile's default project at `slug` and persist it. Returns False
    (with a message) when there's no profile to update."""
    creds = load_credentials()
    name = profile_name or creds.current
    if not name or name not in creds.profiles:
        err_console.print("[yellow]No active profile to switch — run [bold]koji login[/bold] first.[/yellow]")
        return False
    creds.profiles[name].project = slug
    creds.save()
    return True


@project_app.command("list")
def project_list(
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """List the projects in your tenant (those your key can access)."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        # Tenant-level view — never scope to the profile's project, so `list`
        # still works when the profile is pinned to an unreachable project.
        resp = client.get(f"{base_url}/api/projects", headers=_tenant_scope(headers))
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code != 200:
            _api_error(resp, "list projects")
        data = resp.json().get("data", [])

    if as_json:
        emit_json(data)
        return
    if not data:
        console.print("[dim]No projects.[/dim]")
        return
    creds = load_credentials()
    active_name = profile_name or creds.current
    active_project = creds.profiles[active_name].project if active_name in creds.profiles else None
    table = Table(show_header=True, header_style="bold")
    table.add_column("", width=1)
    table.add_column("Slug", style="cyan")
    table.add_column("Name")
    table.add_column("Description", style="dim")
    for p in data:
        marker = "[green]●[/green]" if p.get("slug") == active_project else ""
        table.add_row(marker, p.get("slug", ""), p.get("displayName", ""), p.get("description") or "")
    console.print(table)


@project_app.command("create")
def project_create(
    slug: str = typer.Argument(..., help="Project slug (lowercase letters, numbers, hyphens; 2-64 chars)."),
    name: str = typer.Option(None, "--name", "-n", help="Display name (default: the slug)."),
    description: str = typer.Option(None, "--description", "-d", help="Optional description."),
    use: bool = typer.Option(False, "--use", help="Switch the active profile to this project after creating it."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw JSON."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Create a project in your tenant (requires the tenant:admin permission)."""
    base_url, headers = resolve_api(profile_name)
    body: dict = {"slug": slug, "display_name": name or slug}
    if description:
        body["description"] = description
    reachable = False
    with httpx.Client(timeout=60) as client:
        resp = client.post(f"{base_url}/api/projects", json=body, headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 201):
            _api_error(resp, f"create project {slug}")
        result = resp.json()
        if use:
            reachable = _project_reachable(client, base_url, headers, slug)

    if as_json:
        emit_json(result)
        return
    console.print(f"[green]✓[/green] created project [cyan]{slug}[/cyan]")
    if use:
        # Only pin the profile if this key can actually operate in the new
        # project. An API key is bound to ONE project, so the key that created
        # this one usually can't scope to it — switching the profile there would
        # strand every later command on a 404. Say so instead.
        if reachable and _switch_profile_project(profile_name, slug):
            console.print(f"  active profile now scoped to [cyan]{slug}[/cyan]")
        else:
            console.print(
                f"  [yellow]![/yellow] not switching: this API key is bound to another project and "
                f"can't operate in [cyan]{slug}[/cyan]. Create a key for it in the dashboard "
                f"(Settings → API Keys within the project), then "
                f"[bold]koji login --api-key <key> --project {slug}[/bold]."
            )


@project_app.command("use")
def project_use(
    slug: str = typer.Argument(..., help="Project slug to scope this profile to."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Scope the active profile to a project (sent as x-koji-project on every request)."""
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        # Probe the TARGET's scope, not the profile's current pin — so switching
        # away from a broken/unreachable pin works instead of stranding you.
        if _project_reachable(client, base_url, headers, slug):
            if _switch_profile_project(profile_name, slug):
                console.print(f"[green]✓[/green] active profile scoped to project [cyan]{slug}[/cyan]")
            return
        # Unreachable: distinguish "no such project" from "key not bound to it".
        if slug in _project_slugs(client, base_url, headers):
            err_console.print(
                f"[red]Your API key can't scope to '{slug}'.[/red] API keys are bound to a single "
                f"project. Create a key for '{slug}' in the dashboard (Settings → API Keys within "
                f"that project), then [bold]koji login --api-key <key> --project {slug}[/bold]."
            )
        else:
            err_console.print(f"[red]Project '{slug}' not found. Run [bold]koji project list[/bold].[/red]")
    raise typer.Exit(1)


@project_app.command("delete")
def project_delete(
    slug: str = typer.Argument(..., help="Project slug to delete."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt."),
    profile_name: str = typer.Option(None, "--profile", "-p", help="CLI profile to use."),
):
    """Delete a project (requires tenant:admin). Its schemas, pipelines, and jobs
    become inaccessible; this does not delete the tenant."""
    if not yes:
        typer.confirm(f"Delete project '{slug}'?", abort=True)
    base_url, headers = resolve_api(profile_name)
    with httpx.Client(timeout=60) as client:
        resp = client.delete(f"{base_url}/api/projects/{slug}", headers=headers)
        if _auth_error(resp, base_url):
            raise typer.Exit(1)
        if resp.status_code not in (200, 204):
            _api_error(resp, f"delete project {slug}")
    console.print(f"[green]✓[/green] deleted project [cyan]{slug}[/cyan]")
