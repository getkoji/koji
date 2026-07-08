"""Pipeline corpus bench — run a labeled corpus against a DAG (pipeline).

Where `koji bench` scores a corpus against a single extraction schema (it POSTs
pre-parsed markdown + one schema to /api/extract), this runs each corpus document
through a whole **pipeline/DAG** via POST /api/pipelines/<slug>/test — the same
dry-run the dashboard Test button uses, which parses, classifies, routes, and
extracts exactly as production but persists nothing.

It scores two things per document:

1. **Routing** — did the doc reach the correct terminal schema? The corpus
   already encodes the answer: each document's manifest names the `schema` it
   belongs to, so the expected route is that schema's slug and the actual route
   is the terminal extract step's `output.schema`.
2. **Extraction** — do the fields extracted at that terminal schema match the
   document's `.expected.json`? Scored with the same field comparator as
   `koji bench` (`compare_results`).

Extraction is only scored when routing passed — a mis-route makes field scores
meaningless, so a mis-routed doc counts as a routing failure and is excluded from
the extraction numbers (never silently averaged in).

The corpus layout is identical to `koji bench` (see cli/bench.py). To exercise
routing, point this at a **mixed** corpus whose documents legitimately route to
different terminal schemas.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .bench import DocumentEntry, discover_categories, discover_documents
from .test_runner import FieldResult, compare_results

# ── Data model ────────────────────────────────────────────────────────


@dataclass
class PipelineDocResult:
    """Result of running a single document through a pipeline and scoring it."""

    document_name: str
    category: str
    expected_schema: str
    routed_schema: str | None = None
    path: list[str] = field(default_factory=list)
    field_results: list[FieldResult] = field(default_factory=list)
    elapsed_ms: int = 0
    cost_usd: float = 0.0
    error: str | None = None

    @property
    def routing_ok(self) -> bool:
        """Did the doc reach the expected terminal schema?"""
        return self.error is None and self.routed_schema == self.expected_schema

    @property
    def scored(self) -> bool:
        """Was extraction scored? Only when routing passed."""
        return self.routing_ok and bool(self.field_results)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.field_results if r.passed)

    @property
    def total(self) -> int:
        return len(self.field_results)

    @property
    def accuracy(self) -> float:
        return self.passed / self.total if self.total else 0.0

    @property
    def all_passed(self) -> bool:
        return self.routing_ok and self.total > 0 and self.passed == self.total


@dataclass
class PipelineBenchResult:
    """Aggregated results for a pipeline corpus bench run."""

    pipeline: str
    corpus_path: str
    doc_results: list[PipelineDocResult] = field(default_factory=list)
    started_at: str = ""
    elapsed_ms: int = 0

    @property
    def total_documents(self) -> int:
        return len(self.doc_results)

    @property
    def error_count(self) -> int:
        return sum(1 for d in self.doc_results if d.error is not None)

    @property
    def routable_documents(self) -> int:
        """Documents that ran without an error (routing is meaningful for these)."""
        return sum(1 for d in self.doc_results if d.error is None)

    @property
    def routed_correct(self) -> int:
        return sum(1 for d in self.doc_results if d.routing_ok)

    @property
    def routing_accuracy(self) -> float:
        return self.routed_correct / self.routable_documents if self.routable_documents else 0.0

    @property
    def scored_fields(self) -> int:
        return sum(d.total for d in self.doc_results if d.routing_ok)

    @property
    def passed_fields(self) -> int:
        return sum(d.passed for d in self.doc_results if d.routing_ok)

    @property
    def extraction_accuracy(self) -> float:
        """Field accuracy over correctly-routed docs only."""
        return self.passed_fields / self.scored_fields if self.scored_fields else 0.0

    def routing_confusion(self) -> dict[str, dict[str, int]]:
        """Nested counts: expected schema -> routed schema -> count.

        A routed schema of ``"(none)"`` means no extract step ran (the doc
        dead-ended before reaching a schema).
        """
        confusion: dict[str, dict[str, int]] = {}
        for d in self.doc_results:
            if d.error is not None:
                continue
            routed = d.routed_schema or "(none)"
            confusion.setdefault(d.expected_schema, {}).setdefault(routed, 0)
            confusion[d.expected_schema][routed] += 1
        return confusion

    def extraction_by_schema(self) -> dict[str, tuple[int, int]]:
        """Per terminal schema: (passed_fields, total_fields) over correctly-routed docs."""
        by_schema: dict[str, tuple[int, int]] = {}
        for d in self.doc_results:
            if not d.routing_ok:
                continue
            passed, total = by_schema.get(d.expected_schema, (0, 0))
            by_schema[d.expected_schema] = (passed + d.passed, total + d.total)
        return by_schema

    def to_dict(self) -> dict:
        """Machine-readable JSON output for CI and dashboards."""
        return {
            "pipeline": self.pipeline,
            "corpus_path": self.corpus_path,
            "started_at": self.started_at,
            "elapsed_ms": self.elapsed_ms,
            "total_documents": self.total_documents,
            "error_count": self.error_count,
            "routing": {
                "routable_documents": self.routable_documents,
                "routed_correct": self.routed_correct,
                "accuracy": self.routing_accuracy,
                "confusion": self.routing_confusion(),
            },
            "extraction": {
                "scored_fields": self.scored_fields,
                "passed_fields": self.passed_fields,
                "accuracy": self.extraction_accuracy,
                "by_schema": {
                    slug: {"passed": p, "total": t, "accuracy": (p / t if t else 0.0)}
                    for slug, (p, t) in self.extraction_by_schema().items()
                },
            },
            "documents": [
                {
                    "document": d.document_name,
                    "category": d.category,
                    "expected_schema": d.expected_schema,
                    "routed_schema": d.routed_schema,
                    "routing_ok": d.routing_ok,
                    "path": d.path,
                    "passed": d.passed,
                    "total": d.total,
                    "accuracy": d.accuracy,
                    "elapsed_ms": d.elapsed_ms,
                    "cost_usd": d.cost_usd,
                    "error": d.error,
                    "failures": [
                        {
                            "field": r.field_name,
                            "expected": r.expected,
                            "actual": r.actual,
                            "detail": r.detail,
                        }
                        for r in d.field_results
                        if not r.passed
                    ],
                }
                for d in self.doc_results
            ],
        }


# ── Helpers ───────────────────────────────────────────────────────────


def schema_slug(schema_path: Path) -> str:
    """Return a schema's slug — its YAML ``name`` (or ``slug``), else the file stem.

    This is the routing target we compare against the pipeline's actual
    ``output.schema``. It mirrors how the CLI/server resolve a schema slug, so a
    corpus schema whose ``name`` matches the deployed schema's slug lines up.
    """
    try:
        doc = yaml.safe_load(schema_path.read_text())
        if isinstance(doc, dict):
            slug = doc.get("name") or doc.get("slug")
            if slug:
                return str(slug)
    except Exception:
        pass
    return schema_path.stem


def _terminal_extraction(steps: list[dict]) -> tuple[str | None, dict | None, dict | None]:
    """Pull the terminal extraction from a /test response's ``steps``.

    Returns ``(routed_schema, fields, extract_output)`` from the LAST extract step
    that produced fields. A split fan-out can yield several extract steps; v1
    scores the last one (multi-child scoring is out of scope — see the design
    doc). Returns ``(None, None, None)`` when no extract step produced fields.
    """
    for step in reversed(steps):
        if step.get("stepType") != "extract":
            continue
        out = step.get("output") or {}
        if out.get("fields") is not None:
            return out.get("schema"), out.get("fields"), out
    return None, None, None


# ── Runner ────────────────────────────────────────────────────────────


def bench_document(
    entry: DocumentEntry,
    pipeline: str,
    base_url: str,
    headers: dict[str, str],
    http_client: Any,
    timeout: float = 600.0,
) -> PipelineDocResult:
    """Run one corpus document through a pipeline's /test endpoint and score it.

    ``http_client`` must be an httpx.Client (or a compatible mock) so callers can
    share a client across documents and tests can inject a stub.
    """
    result = PipelineDocResult(
        document_name=entry.document_path.name,
        category=entry.category,
        expected_schema=schema_slug(entry.schema_path),
    )

    # Load the local schema (for mappings/fuzzy config) and ground truth up front.
    try:
        schema_dict = yaml.safe_load(entry.schema_path.read_text())
        if not isinstance(schema_dict, dict):
            schema_dict = {}
        expected = _load_json(entry.expected_path)
    except Exception as e:
        result.error = f"setup: {e}"
        return result

    compare_config = schema_dict.get("compare") or {}
    fuzzy_threshold = float(compare_config.get("fuzzy_threshold", 0.0))

    mime = _guess_mime(entry.document_path)
    started = time.time()
    try:
        with entry.document_path.open("rb") as fh:
            files = {"file": (entry.document_path.name, fh, mime)}
            response = http_client.post(
                f"{base_url}/api/pipelines/{pipeline}/test",
                files=files,
                headers=headers,
                timeout=timeout,
            )
    except Exception as e:
        result.error = f"test: {e}"
        return result

    result.elapsed_ms = int((time.time() - started) * 1000)

    if response.status_code != 200:
        try:
            body = response.json()
            result.error = body.get("error", f"HTTP {response.status_code}")
        except Exception:
            result.error = f"HTTP {response.status_code}"
        return result

    try:
        data = response.json()
    except Exception as e:
        result.error = f"bad response: {e}"
        return result

    steps = data.get("steps") or []
    result.path = list(data.get("path") or [])
    result.cost_usd = float(data.get("totalCostUsd") or 0.0)

    routed_schema, fields, _ = _terminal_extraction(steps)
    result.routed_schema = routed_schema

    # Score extraction only when the doc routed to the expected schema. A wrong
    # route makes field comparison meaningless, so we leave field_results empty
    # and let routing_ok=False carry the failure.
    if result.routing_ok and isinstance(fields, dict):
        result.field_results = compare_results(
            expected, fields, fuzzy_threshold=fuzzy_threshold, schema_def=schema_dict
        )

    return result


def run_pipeline_bench(
    pipeline: str,
    corpus_root: Path,
    base_url: str,
    headers: dict[str, str],
    http_client: Any,
    category_filter: str | None = None,
    document_limit: int | None = None,
    progress_callback: Any = None,
) -> PipelineBenchResult:
    """Run a pipeline against a full corpus and return aggregated results.

    Args:
        pipeline: Pipeline slug to run each document through.
        corpus_root: Path to the corpus repo root (contains category dirs).
        base_url: Koji API base URL (e.g. https://api.getkoji.dev).
        headers: Auth headers (from ``resolve_api``).
        http_client: httpx.Client or compatible mock.
        category_filter: If set, only run this category.
        document_limit: Max documents per category (for fast runs).
        progress_callback: Optional callable(category, doc_index, doc_total, doc_name).
    """
    started = time.time()
    result = PipelineBenchResult(
        pipeline=pipeline,
        corpus_path=str(corpus_root),
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
    )

    categories = discover_categories(corpus_root)
    if category_filter:
        categories = [c for c in categories if c == category_filter]

    for category in categories:
        entries = discover_documents(corpus_root, category)
        if document_limit is not None:
            entries = entries[:document_limit]

        for i, entry in enumerate(entries, start=1):
            if progress_callback is not None:
                progress_callback(category, i, len(entries), entry.document_path.name)

            result.doc_results.append(
                bench_document(
                    entry=entry,
                    pipeline=pipeline,
                    base_url=base_url,
                    headers=headers,
                    http_client=http_client,
                )
            )

    result.elapsed_ms = int((time.time() - started) * 1000)
    return result


# ── Reporting ─────────────────────────────────────────────────────────


def format_report(result: PipelineBenchResult) -> str:
    """Format a pipeline bench result as human-readable plain text."""
    lines: list[str] = []
    lines.append("")
    lines.append(f"koji pipeline bench — {result.pipeline}")
    lines.append(f"corpus: {result.corpus_path}")
    lines.append("")

    for d in result.doc_results:
        if d.error:
            lines.append(f"  x {d.document_name}: {d.error}")
            continue
        if not d.routing_ok:
            routed = d.routed_schema or "(no extraction)"
            lines.append(f"  MISROUTE {d.document_name}: routed to {routed}, expected {d.expected_schema}")
            continue
        if d.all_passed:
            lines.append(f"  ok {d.document_name} → {d.routed_schema} ({d.total} fields, {d.elapsed_ms}ms)")
        else:
            lines.append(f"  -- {d.document_name} → {d.routed_schema}: {d.passed}/{d.total} fields ({d.elapsed_ms}ms)")
            for r in d.field_results:
                if not r.passed:
                    detail = r.detail or f"expected {r.expected!r}, got {r.actual!r}"
                    lines.append(f"       {r.field_name}: {detail}")

    lines.append("")
    lines.append("=" * 60)

    # Routing summary + confusion (only non-diagonal / misroutes shown)
    lines.append(
        f"ROUTING: {result.routed_correct}/{result.routable_documents} docs to correct schema "
        f"({result.routing_accuracy * 100:.1f}%)"
    )
    for expected_slug, routed_counts in sorted(result.routing_confusion().items()):
        misroutes = {k: v for k, v in routed_counts.items() if k != expected_slug}
        if misroutes:
            parts = ", ".join(f"{v}→{k}" for k, v in sorted(misroutes.items()))
            lines.append(f"  {expected_slug}: {parts}")

    # Extraction summary, broken out per terminal schema
    lines.append("")
    lines.append(
        f"EXTRACTION (correctly-routed only): {result.passed_fields}/{result.scored_fields} fields "
        f"({result.extraction_accuracy * 100:.1f}%)"
    )
    for slug, (passed, total) in sorted(result.extraction_by_schema().items()):
        acc = (passed / total * 100) if total else 0.0
        lines.append(f"  {slug}: {passed}/{total} fields ({acc:.1f}%)")

    if result.error_count > 0:
        lines.append("")
        lines.append(f"Errors: {result.error_count} documents failed to run")
    lines.append(f"Elapsed: {result.elapsed_ms / 1000:.1f}s")
    lines.append("")

    return "\n".join(lines)


# ── Small utilities (kept local so the module has no heavy imports) ────


def _load_json(path: Path) -> dict:
    import json

    return json.loads(path.read_text())


def _guess_mime(path: Path) -> str:
    import mimetypes

    mime, _ = mimetypes.guess_type(path.name)
    if mime:
        return mime
    if path.suffix == ".md":
        return "text/markdown"
    return "text/plain"
