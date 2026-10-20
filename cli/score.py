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

# Where to look for the scorer, in order. An explicit env override wins so a
# harness can pin a build; then the workspace build output; then the workspace's
# node_modules bin shim.
_BIN_ENV = "KOJI_SCORE_BIN"
_BIN_CANDIDATES = (
    Path("packages/score/dist/bin.js"),
    Path("node_modules/.bin/koji-score"),
)
# In a checkout with nothing built, run the TypeScript source directly. Without
# this the command would fall through to `npx` and try to fetch a package that
# may not be published yet, so a fresh clone could not score anything until
# someone thought to run a build.
_SOURCE_ENTRY = Path("packages/score/src/bin.ts")


def _repo_root(start: Path | None = None) -> Path | None:
    """Walk up looking for the koji repo root (the pnpm workspace marker)."""
    here = (start or Path.cwd()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "pnpm-workspace.yaml").is_file():
            return candidate
    return None


def _candidate_roots() -> list[Path]:
    """Checkouts to look for a built scorer in, nearest-intent first.

    The working directory wins, so a harness run inside a checkout scores with
    that checkout's scorer. Failing that, the tree this module itself lives in:
    `koji bench --corpus ~/corpus` is normally run from the corpus directory,
    and falling through to `npx` there would try to fetch a package that is not
    published yet. Returns [] for an installed wheel, which has no checkout.
    """
    roots: list[Path] = []
    for start in (None, Path(__file__).resolve().parent):
        root = _repo_root(start)
        if root is not None and root not in roots:
            roots.append(root)
    return roots


def resolve_scorer() -> list[str]:
    """Build the argv that runs the scorer, or raise with a fixable message."""
    override = os.environ.get(_BIN_ENV)
    if override:
        path = Path(override)
        if not path.is_file():
            raise FileNotFoundError(f"{_BIN_ENV} points at {override}, which does not exist")
        return _with_node(path)

    for root in _candidate_roots():
        for rel in _BIN_CANDIDATES:
            path = root / rel
            if path.is_file():
                return _with_node(path)
        source = root / _SOURCE_ENTRY
        if source.is_file():
            tsx = _find_tsx(root)
            if tsx:
                return [str(tsx), str(source)]

    # Outside a checkout, let npx resolve the published package.
    if shutil.which("npx"):
        return ["npx", "--yes", "@koji/score"]

    raise FileNotFoundError(
        "cannot find the scorer. Build it with "
        "`pnpm --filter @koji/score build`, or set "
        f"{_BIN_ENV}=/path/to/bin.js, or install node so `npx` can fetch it"
    )


def _find_tsx(root: Path) -> Path | None:
    """Locate tsx inside the workspace.

    pnpm does not hoist binaries to the root `.bin` by default, so tsx sits in
    the `.bin` of whichever package declares it. Resolving the path directly
    beats `npx tsx`, which cannot see a non-hoisted binary and would otherwise
    reach for the network.
    """
    candidates = (
        root / "node_modules/.bin/tsx",
        root / "api/node_modules/.bin/tsx",
        root / "packages/db/node_modules/.bin/tsx",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


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
        # Say WHICH kind of wrong. "missing" is a routing/recall problem,
        # "fabricated" is a faithfulness problem, and a wrong value is a
        # prompt/model problem — three different fixes behind one ✗.
        bucket = field.get("bucket")
        label = {"missed": " [missing]", "fabricated": " [fabricated]"}.get(bucket, "")
        detail = "" if ok else f"{label}  expected={expected_values.get(name)!r} got={actual_values.get(name)!r}"
        typer.secho(f"{mark} {name}{detail}", fg=color)

    total = result.get("total", 0)
    matched = result.get("matched", 0)
    typer.echo(f"\n{matched}/{total} fields matched exactly")
    # Four metrics, never one. A single number folded "correctly absent" in,
    # which gave an extraction of nothing a non-zero floor — see cli/metrics.py.
    for line in format_metrics(result.get("metrics") or {}):
        typer.echo(line)
    typer.echo(f"scorer {result.get('scorer')} {result.get('scorer_version')}")
    if matched != total:
        raise typer.Exit(1)


def format_metrics(metrics: dict[str, Any]) -> list[str]:
    """Render the scorer's four metrics as human-readable lines.

    `None` is rendered "n/a", not 0%: it means the run had no fields in that
    population, so the metric was never measured. Printing 0% would be a claim
    the scoring did not make.
    """
    counts = metrics.get("counts") or {}
    present = counts.get("present", 0)
    found = counts.get("found", 0)
    absent = counts.get("absent", 0)
    fabricated = counts.get("fabricated", 0)
    agreed = counts.get("agreed", 0)

    def pct(key: str) -> str:
        v = metrics.get(key)
        return "  n/a" if v is None else f"{v * 100:5.1f}%"

    return [
        f"  presence recall   {pct('presence_recall')}   ({found}/{present} with a ground-truth value)",
        f"  value accuracy    {pct('value_accuracy')}   (credit over the {found} we produced)",
        f"  fabrication rate  {pct('fabrication_rate')}   ({fabricated}/{absent} ground truth leaves empty)",
        f"  null agreement    {pct('null_agreement')}   ({agreed}/{absent} correctly declined)",
    ]
