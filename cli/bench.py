"""Corpus benchmark runner — evaluate extraction accuracy across a full corpus.

`koji bench` runs extraction against an entire validation corpus (see
github.com/getkoji/corpus) and reports per-category, per-document, and
aggregate accuracy. It's how we produce the numbers for
accuracy.getkoji.dev and catch regressions in CI.

Expected corpus layout (per category):

    corpus/
      <category>/
        documents/      # source documents (.md)
        schemas/        # extraction schemas (.yaml)
        expected/       # ground truth JSON (.expected.json)
        manifests/      # per-document metadata (.json)

Each document's manifest points at a schema path (relative to the corpus
root). The bencher calls Koji's extract endpoint, scores the actual output
against the expected JSON with `@koji/score` — the single scorer the server,
`koji test`, `koji validate` and `koji score` all use — and produces both
human-readable and machine-readable reports.

Since 0.120.0 the scoring is literally that scorer, not a Python
reimplementation of it, so a field scores the same number here as it does in
the dashboard. Numbers from before 0.120.0 came from a different comparison
engine and are not comparable; every report carries `scorer_version` so a
reader can tell.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .metrics import (
    SCORER_NAME,
    MetricCounts,
    counts_from_field_results,
    metrics_from_counts,
    scorer_stamp,
    scorer_version,
)
from .test_runner import FieldResult, compare_results

# ── Data model ────────────────────────────────────────────────────────


@dataclass
class DocumentBenchResult:
    """Result of benchmarking a single document."""

    document_name: str
    category: str
    schema_name: str
    field_results: list[FieldResult] = field(default_factory=list)
    elapsed_ms: int = 0
    error: str | None = None

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
        return self.error is None and self.passed == self.total

    @property
    def metric_counts(self) -> MetricCounts:
        """Presence / fabrication counts for this document (oss-523)."""
        return counts_from_field_results(self.field_results)


@dataclass
class CategoryBenchResult:
    """Aggregated results for one corpus category."""

    category: str
    document_results: list[DocumentBenchResult] = field(default_factory=list)

    @property
    def total_documents(self) -> int:
        return len(self.document_results)

    @property
    def total_fields(self) -> int:
        return sum(d.total for d in self.document_results)

    @property
    def passed_fields(self) -> int:
        return sum(d.passed for d in self.document_results)

    @property
    def error_count(self) -> int:
        return sum(1 for d in self.document_results if d.error is not None)

    @property
    def accuracy(self) -> float:
        return self.passed_fields / self.total_fields if self.total_fields else 0.0

    @property
    def mean_elapsed_ms(self) -> float:
        valid = [d.elapsed_ms for d in self.document_results if d.error is None]
        return sum(valid) / len(valid) if valid else 0.0

    @property
    def metric_counts(self) -> MetricCounts:
        """Presence / fabrication counts rolled up from this category's docs."""
        total = MetricCounts()
        for d in self.document_results:
            total.merge(d.metric_counts)
        return total


@dataclass
class BenchResult:
    """Top-level benchmark result across all categories."""

    model: str
    corpus_path: str
    category_results: list[CategoryBenchResult] = field(default_factory=list)
    started_at: str = ""
    elapsed_ms: int = 0

    @property
    def total_documents(self) -> int:
        return sum(c.total_documents for c in self.category_results)

    @property
    def total_fields(self) -> int:
        return sum(c.total_fields for c in self.category_results)

    @property
    def passed_fields(self) -> int:
        return sum(c.passed_fields for c in self.category_results)

    @property
    def error_count(self) -> int:
        return sum(c.error_count for c in self.category_results)

    @property
    def accuracy(self) -> float:
        return self.passed_fields / self.total_fields if self.total_fields else 0.0

    @property
    def all_passed(self) -> bool:
        return self.error_count == 0 and self.passed_fields == self.total_fields

    @property
    def metric_counts(self) -> MetricCounts:
        """Presence / fabrication counts rolled up across every category."""
        total = MetricCounts()
        for c in self.category_results:
            total.merge(c.metric_counts)
        return total

    def to_dict(self) -> dict:
        """Machine-readable JSON output, suitable for CI and accuracy dashboards.

        Carries the four metrics (oss-523) and the scorer stamp (oss-525)
        alongside the legacy `accuracy`. `accuracy` is retained because
        published numbers reference it, but it counts a correctly-absent field
        as a pass and so has an all-null floor — read `metrics` instead, and
        see `cli/metrics.py` for why there is no longer one number.
        """
        return {
            "model": self.model,
            "corpus_path": self.corpus_path,
            "started_at": self.started_at,
            "elapsed_ms": self.elapsed_ms,
            # Which scorer produced every number below. Two runs scored by
            # different versions are not comparable (oss-525).
            **scorer_stamp(),
            "total_documents": self.total_documents,
            "total_fields": self.total_fields,
            "passed_fields": self.passed_fields,
            # DEPRECATED: passed_fields / total_fields, where "correctly
            # absent" counts as passed. A document that extracts nothing
            # scores whatever fraction of its fields are legitimately empty
            # (19.2% on the reference corpus run). Use `metrics`.
            "accuracy": self.accuracy,
            "metrics": metrics_from_counts(self.metric_counts),
            "error_count": self.error_count,
            "categories": [
                {
                    "category": c.category,
                    "documents": c.total_documents,
                    "fields_checked": c.total_fields,
                    "passed": c.passed_fields,
                    "accuracy": c.accuracy,
                    "metrics": metrics_from_counts(c.metric_counts),
                    "errors": c.error_count,
                    "mean_elapsed_ms": c.mean_elapsed_ms,
                    "documents_detail": [
                        {
                            "document": d.document_name,
                            "schema": d.schema_name,
                            "passed": d.passed,
                            "total": d.total,
                            "accuracy": d.accuracy,
                            "metrics": metrics_from_counts(d.metric_counts),
                            "elapsed_ms": d.elapsed_ms,
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
                        for d in c.document_results
                    ],
                }
                for c in self.category_results
            ],
        }


# ── Config helpers ────────────────────────────────────────────────────


def model_from_config(config_path: Path | None = None) -> str | None:
    """Return the extract step's model from koji.yaml, or None.

    When ``koji bench`` is invoked without ``--model``, this is called to
    pick up the model configured in the project's ``koji.yaml`` so that
    bench and the live cluster always use the same model by default.

    Returns ``None`` on any error (file missing, parse error, no extract
    step, no model key on the step) so the caller can fall through to the
    server's own default.

    Args:
        config_path: Path to ``koji.yaml``. Defaults to ``./koji.yaml``
            relative to the current working directory.
    """
    from cli.config import load_config

    if config_path is None:
        config_path = Path("koji.yaml")
    try:
        config = load_config(config_path)
    except Exception:
        return None
    for step in config.pipeline:
        if step.step == "extract" and step.model:
            return step.model
    return None


# ── Corpus discovery ──────────────────────────────────────────────────


@dataclass
class DocumentEntry:
    """A single document in the corpus with its associated files."""

    category: str
    document_path: Path
    expected_path: Path
    manifest_path: Path
    schema_path: Path


def discover_categories(corpus_root: Path) -> list[str]:
    """Find all valid category directories in a corpus.

    A valid category has documents/, expected/, manifests/, and schemas/
    subdirectories.
    """
    if not corpus_root.is_dir():
        return []

    categories = []
    for entry in sorted(corpus_root.iterdir()):
        if not entry.is_dir() or entry.name.startswith(".") or entry.name.startswith("_"):
            continue
        required = ["documents", "expected", "manifests", "schemas"]
        if all((entry / sub).is_dir() for sub in required):
            categories.append(entry.name)
    return categories


def discover_documents(corpus_root: Path, category: str) -> list[DocumentEntry]:
    """Find all benchmarkable documents in a category.

    A document is benchmarkable if it has matching expected and manifest files,
    and its manifest points at an existing schema.
    """
    cat_dir = corpus_root / category
    docs_dir = cat_dir / "documents"
    if not docs_dir.is_dir():
        return []

    entries: list[DocumentEntry] = []
    for doc_path in sorted(docs_dir.iterdir()):
        if doc_path.is_dir() or doc_path.name.startswith("."):
            continue
        if doc_path.suffix not in (".md", ".txt"):
            continue

        stem = doc_path.stem
        expected_path = cat_dir / "expected" / f"{stem}.expected.json"
        manifest_path = cat_dir / "manifests" / f"{stem}.json"

        if not expected_path.exists() or not manifest_path.exists():
            continue

        # Resolve schema from manifest
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            continue

        schema_ref = manifest.get("schema")
        if not schema_ref:
            continue

        # Schema references are relative to the corpus root
        schema_path = corpus_root / schema_ref
        if not schema_path.exists():
            continue

        entries.append(
            DocumentEntry(
                category=category,
                document_path=doc_path,
                expected_path=expected_path,
                manifest_path=manifest_path,
                schema_path=schema_path,
            )
        )

    return entries


# ── Benchmark runner ──────────────────────────────────────────────────


def load_schema(schema_path: Path) -> tuple[dict, str]:
    """Load a schema YAML file. Returns (schema_dict, yaml_content)."""
    content = schema_path.read_text()
    schema_dict = yaml.safe_load(content)
    return schema_dict, content


def benchmark_document(
    entry: DocumentEntry,
    server_url: str,
    model: str | None,
    http_client: Any,
    timeout: float = 600.0,
) -> DocumentBenchResult:
    """Run extraction on a single document and compare to expected output.

    `http_client` must be an httpx.Client (or a compatible mock). Passed in
    so callers can share a client across documents and tests can inject mocks.
    """
    result = DocumentBenchResult(
        document_name=entry.document_path.name,
        category=entry.category,
        schema_name=entry.schema_path.stem,
    )

    try:
        schema_dict, schema_content = load_schema(entry.schema_path)
        markdown = entry.document_path.read_text()
        expected = json.loads(entry.expected_path.read_text())
    except Exception as e:
        result.error = f"setup: {e}"
        return result

    payload: dict = {"markdown": markdown, "schema_def": schema_dict}
    if model:
        payload["model"] = model

    started = time.time()
    try:
        response = http_client.post(
            f"{server_url}/extract",
            json=payload,
            timeout=timeout,
        )
    except Exception as e:
        result.error = f"extract: {e}"
        return result

    result.elapsed_ms = int((time.time() - started) * 1000)

    if response.status_code != 200:
        try:
            body = response.json()
            error_msg = body.get("error", f"HTTP {response.status_code}")
        except Exception:
            error_msg = f"HTTP {response.status_code}"
        result.error = error_msg
        return result

    try:
        data = response.json()
    except Exception as e:
        result.error = f"bad response: {e}"
        return result

    actual = _unwrap_extracted(data)
    if actual is None:
        result.error = f"bad response shape: {type(data).__name__}"
        return result
    if not isinstance(actual, dict):
        result.error = f"extracted is not an object: {type(actual).__name__}"
        return result

    # Scoring goes through `@koji/score`, which runs out of process. A missing
    # or broken scorer is recorded as this document's error — a 1000-document
    # bench must not die on its first field, and the message says how to fix it.
    try:
        result.field_results = compare_results(expected, actual, schema_dict if isinstance(schema_dict, dict) else None)
    except (FileNotFoundError, RuntimeError) as e:
        result.error = f"score: {e}"
    return result


def _unwrap_extracted(data: Any) -> dict | None:
    """Return the field-dict to compare against expected output.

    Handles both extraction response shapes:

    1. Flat shape (classifier disabled, non-intelligent strategies):
        {"extracted": {field: value, ...}, ...}

    2. Classify-wrapped shape (oss-28 packet splitting, classifier enabled):
        {"sections": [{"extracted": {...}, "section_type": ..., ...}], ...}

    For single-schema bench we collapse the wrapped shape to one field
    dict:

    - Zero matching sections → return an empty dict. The classifier
      correctly refused to extract (e.g. a recipe handed to an SEC
      schema). An empty actual compared against an all-null expected
      passes naturally via the null-aware field comparator (oss-25),
      which is exactly the score we want for these adversarial cases.
    - One matching section → return that section's `extracted` dict.
    - Multiple matching sections → union the fields, first non-null wins.
      This handles stapled packets where apply_to matched several sections
      of the same schema type (e.g. three stapled invoices). The expected
      JSON in the corpus still describes one extracted document, so the
      union produces the best single-document projection we can score
      against without requiring bench fixtures to become lists.

    Returns:
        A dict of extracted fields, or None only when the response is
        not a JSON object at all (malformed / unparseable shape).
    """
    if not isinstance(data, dict):
        return None

    # Classify-wrapped shape
    if "sections" in data and isinstance(data["sections"], list):
        sections = data["sections"]
        if not sections:
            return {}
        if len(sections) == 1:
            return sections[0].get("extracted") or {}
        # Union across matched sections, first non-null wins per field
        merged: dict = {}
        for section in sections:
            section_fields = section.get("extracted")
            if not isinstance(section_fields, dict):
                continue
            for key, value in section_fields.items():
                if merged.get(key) is None and value is not None:
                    merged[key] = value
        return merged

    # Flat shape — unchanged from pre-classifier behavior
    extracted = data.get("extracted")
    if isinstance(extracted, dict):
        return extracted
    # Best-effort fallback: if the payload itself looks like a field dict
    # (e.g. a custom strategy that returns the extracted shape directly),
    # let the caller type-check it.
    return data


def run_bench(
    corpus_root: Path,
    server_url: str,
    model: str | None,
    http_client: Any,
    category_filter: str | None = None,
    document_limit: int | None = None,
    progress_callback: Any = None,
) -> BenchResult:
    """Run benchmarks across a full corpus and return aggregated results.

    Args:
        corpus_root: Path to the corpus repo root (contains category dirs).
        server_url: Koji API server URL (e.g. http://127.0.0.1:9401).
        model: Model string to use (e.g. 'openai/gpt-4o-mini'). None uses server default.
        http_client: httpx.Client or compatible mock.
        category_filter: If set, only run this category.
        document_limit: Max documents per category (for fast CI runs).
        progress_callback: Optional callable(category, doc_index, doc_total, doc_name).
    """
    started = time.time()
    result = BenchResult(
        model=model or "default",
        corpus_path=str(corpus_root),
        started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
    )

    categories = discover_categories(corpus_root)
    if category_filter:
        categories = [c for c in categories if c == category_filter]

    for category in categories:
        cat_result = CategoryBenchResult(category=category)
        entries = discover_documents(corpus_root, category)
        if document_limit is not None:
            entries = entries[:document_limit]

        for i, entry in enumerate(entries, start=1):
            if progress_callback is not None:
                progress_callback(category, i, len(entries), entry.document_path.name)

            doc_result = benchmark_document(
                entry=entry,
                server_url=server_url,
                model=model,
                http_client=http_client,
            )
            cat_result.document_results.append(doc_result)

        result.category_results.append(cat_result)

    result.elapsed_ms = int((time.time() - started) * 1000)
    return result


# ── Human-readable reporting ──────────────────────────────────────────


def format_report(result: BenchResult) -> str:
    """Format a bench result as human-readable plain text (no color codes)."""
    lines: list[str] = []
    lines.append("")
    lines.append(f"koji bench — {result.model}")
    lines.append(f"corpus: {result.corpus_path}")
    lines.append("")

    for cat in result.category_results:
        if cat.total_documents == 0:
            lines.append(f"[{cat.category}] no documents found")
            continue

        cat_counts = cat.metric_counts
        cat_metrics = metrics_from_counts(cat_counts)
        recall = cat_metrics["presence_recall"]
        value = cat_metrics["value_accuracy"]
        lines.append(
            f"[{cat.category}] {cat.total_documents} docs, "
            f"{cat.passed_fields}/{cat.total_fields} exact fields, "
            f"recall {'n/a' if recall is None else f'{recall * 100:.1f}%'} / "
            f"value {'n/a' if value is None else f'{value * 100:.1f}%'}, "
            f"avg {cat.mean_elapsed_ms / 1000:.1f}s/doc"
        )

        for doc in cat.document_results:
            if doc.error:
                lines.append(f"  x {doc.document_name}: {doc.error}")
                continue
            if doc.all_passed:
                lines.append(f"  ok {doc.document_name} ({doc.total} fields, {doc.elapsed_ms}ms)")
            else:
                lines.append(f"  -- {doc.document_name}: {doc.passed}/{doc.total} fields ({doc.elapsed_ms}ms)")
                for r in doc.field_results:
                    if not r.passed:
                        detail = r.detail or f"expected {r.expected!r}, got {r.actual!r}"
                        lines.append(f"       {r.field_name}: {detail}")

    lines.append("")
    lines.append("=" * 60)
    lines.append(
        f"TOTAL: {result.passed_fields}/{result.total_fields} exact fields across {result.total_documents} documents"
    )
    lines.append("")
    lines.extend(format_metrics(result.metric_counts))
    if result.error_count > 0:
        lines.append(f"Errors: {result.error_count} documents failed to extract")
    lines.append(f"Elapsed: {result.elapsed_ms / 1000:.1f}s")
    lines.append(f"Scorer: {SCORER_NAME} {scorer_version()}")
    lines.append("")

    return "\n".join(lines)


def format_metrics(counts: MetricCounts) -> list[str]:
    """Render the four metrics as report lines (oss-523).

    Reported as four, never folded into one, and with the population each is
    computed over spelled out — "94.0%" means nothing without "of 1,431
    fields ground truth has a value for". See `cli/metrics.py`.
    """
    m = metrics_from_counts(counts)

    def pct(key: str) -> str:
        v = m[key]
        # `None` is not 0: it means the run had no fields in that population,
        # so the metric was never measured. Saying 0% would be a claim.
        return "  n/a" if v is None else f"{v * 100:5.1f}%"

    return [
        f"  presence recall   {pct('presence_recall')}   "
        f"({counts.found}/{counts.present} fields ground truth has a value for)",
        f"  value accuracy    {pct('value_accuracy')}   (credit over the {counts.found} we produced a value for)",
        f"  fabrication rate  {pct('fabrication_rate')}   "
        f"({counts.fabricated}/{counts.absent} fields ground truth leaves empty)",
        f"  null agreement    {pct('null_agreement')}   ({counts.agreed}/{counts.absent} correctly declined)",
        "",
    ]
