"""`koji score` — score extracted values against ground truth, offline.

There is ONE scorer, and it lives in `@koji/score` (TypeScript). The API imports
it directly; this command shells out to the package's `koji-score` bin so the
CLI, CI benchmark harnesses, and external consumers all get identical semantics
instead of reimplementing comparison. Reimplementing it here in Python is
exactly the divergence this command exists to end.

Offline by design: no server, no credentials. That is what lets a benchmark or
paper script score a run in CI.

Requires `node` on PATH, and the scorer built (`pnpm --filter @koji/score build`)
or reachable via `npx`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import typer

from .remote import emit_json

# Where to look for the built bin, in order. An explicit env override wins so a
# harness can point at a specific build; then the workspace build output; then
# the workspace's node_modules bin shim.
_BIN_ENV = "KOJI_SCORE_BIN"
_BIN_CANDIDATES = (
    Path("packages/score/dist/bin.js"),
    Path("node_modules/.bin/koji-score"),
)


def _repo_root(start: Path | None = None) -> Path | None:
    """Walk up looking for the koji repo root (the pnpm workspace marker)."""
    here = (start or Path.cwd()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "pnpm-workspace.yaml").is_file():
            return candidate
    return None


def resolve_scorer() -> list[str]:
    """Build the argv that runs the scorer, or raise with a fixable message."""
    override = os.environ.get(_BIN_ENV)
    if override:
        path = Path(override)
        if not path.is_file():
            raise FileNotFoundError(f"{_BIN_ENV} points at {override}, which does not exist")
        return _with_node(path)

    root = _repo_root()
    if root is not None:
        for rel in _BIN_CANDIDATES:
            path = root / rel
            if path.is_file():
                return _with_node(path)

    # Last resort: let npx fetch/resolve the published package. Works outside a
    # checkout, at the cost of a network hit on first use.
    if shutil.which("npx"):
        return ["npx", "--yes", "@koji/score"]

    raise FileNotFoundError(
        "cannot find the scorer. Build it with "
        "`pnpm --filter @koji/score build`, or set "
        f"{_BIN_ENV}=/path/to/bin.js, or install node so `npx` can fetch it"
    )


def _with_node(path: Path) -> list[str]:
    """Run a .js entrypoint under node; run an executable shim directly."""
    if path.suffix == ".js":
        node = shutil.which("node")
        if not node:
            raise FileNotFoundError("`node` is not on PATH — the scorer needs it to run")
        return [node, str(path)]
    return [str(path)]


def run_scorer(payload: dict[str, Any]) -> dict[str, Any]:
    """Send one scoring payload through the bin and return its parsed result."""
    argv = resolve_scorer()
    proc = subprocess.run(
        argv,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"scorer exited {proc.returncode}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"scorer emitted non-JSON output: {exc}") from exc


def _load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise typer.BadParameter(f"{label} file not found: {path}") from None
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"{label} file is not valid JSON: {exc}") from None


def _field_specs(schema_path: Path | None) -> dict[str, Any]:
    """Pull per-field specs out of a schema so arrays score with element_key.

    Without them an array still scores by greedy best-overlap; with them it
    matches elements by the schema's declared key and skips sub-fields marked
    informational.
    """
    if schema_path is None:
        return {}
    import yaml  # local import: only needed when a schema is passed

    try:
        schema = yaml.safe_load(schema_path.read_text()) or {}
    except FileNotFoundError:
        raise typer.BadParameter(f"schema file not found: {schema_path}") from None
    except yaml.YAMLError as exc:
        raise typer.BadParameter(f"schema is not valid YAML: {exc}") from None
    fields = schema.get("fields")
    return fields if isinstance(fields, dict) else {}


def score(
    expected: Path = typer.Option(..., "--expected", help="JSON file of ground-truth values"),
    actual: Path = typer.Option(..., "--actual", help="JSON file of extracted values"),
    schema: Path | None = typer.Option(
        None, "--schema", help="Schema YAML, for element_key matching and informational fields"
    ),
    json_out: bool = typer.Option(False, "--json", help="Emit the full JSON result"),
) -> None:
    """Score extracted values against ground truth.

    Compares every key present in either file and reports per-field match plus
    an overall score, using the same scorer the server uses.
    """
    expected_values = _load_json(expected, "expected")
    actual_values = _load_json(actual, "actual")
    for label, value in (("expected", expected_values), ("actual", actual_values)):
        if not isinstance(value, dict):
            raise typer.BadParameter(f"{label} file must contain a JSON object of field values")

    specs = _field_specs(schema)
    names = sorted({*expected_values, *actual_values})
    payload = {
        "fields": {name: {"expected": expected_values.get(name), "got": actual_values.get(name)} for name in names},
        "specs": {name: specs[name] for name in names if name in specs},
    }

    try:
        result = run_scorer(payload)
    except (FileNotFoundError, RuntimeError) as exc:
        typer.secho(f"score failed: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1) from None

    if json_out:
        emit_json(result)
        return

    fields = result.get("fields", {})
    for name in names:
        field = fields.get(name, {})
        ok = field.get("match")
        mark = "✓" if ok else "✗"
        color = typer.colors.GREEN if ok else typer.colors.RED
        detail = "" if ok else f"  expected={expected_values.get(name)!r} got={actual_values.get(name)!r}"
        typer.secho(f"{mark} {name}{detail}", fg=color)

    total = result.get("total", 0)
    matched = result.get("matched", 0)
    pct = (matched / total * 100) if total else 100.0
    typer.echo(f"\n{matched}/{total} fields matched ({pct:.1f}%)")
    typer.echo(f"scorer {result.get('scorer')} {result.get('scorer_version')}")
    if matched != total:
        raise typer.Exit(1)
