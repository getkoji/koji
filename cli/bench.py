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
root). The bencher calls Koji's /api/extract endpoint, compares the
actual output against the expected JSON using the same field-level
comparison as `koji test`, and produces both human-readable and
machine-readable reports.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

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

    def to_dict(self) -> dict:
        """Machine-readable JSON output, suitable for CI and accuracy dashboards."""
        return {
            "model": self.model,
            "corpus_path": self.corpus_path,
            "started_at": self.started_at,
            "elapsed_ms": self.elapsed_ms,
            "total_documents": self.total_documents,
            "total_fields": self.total_fields,
            "passed_fields": self.passed_fields,
            "accuracy": self.accuracy,
            "error_count": self.error_count,
            "categories": [
                {
                    "category": c.category,
                    "documents": c.total_documents,
                    "fields_checked": c.total_fields,
                    "passed": c.passed_fields,
                    "accuracy": c.accuracy,
                    "errors": c.error_count,
                    "mean_elapsed_ms": c.mean_elapsed_ms,
                    "documents_detail": [
                        {
                            "document": d.document_name,
                            "schema": d.schema_name,
                            "passed": d.passed,
                            "total": d.total,
                            "accuracy": d.accuracy,
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

    compare_config = schema_dict.get("compare") or {} if isinstance(schema_dict, dict) else {}
    fuzzy_threshold = float(compare_config.get("fuzzy_threshold", 0.0))

    payload: dict = {"markdown": markdown, "schema": schema_content}
    if model:
        payload["model"] = model

    started = time.time()
    try:
        response = http_client.post(
            f"{server_url}/api/extract",
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

    result.field_results = compare_results(expected, actual, fuzzy_threshold=fuzzy_threshold)
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

        accuracy_pct = cat.accuracy * 100
        lines.append(
            f"[{cat.category}] {cat.total_documents} docs, "
            f"{cat.passed_fields}/{cat.total_fields} fields "
            f"({accuracy_pct:.1f}%, avg {cat.mean_elapsed_ms / 1000:.1f}s/doc)"
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
    accuracy_pct = result.accuracy * 100
    lines.append(
        f"TOTAL: {result.passed_fields}/{result.total_fields} fields "
        f"across {result.total_documents} documents "
        f"({accuracy_pct:.1f}%)"
    )
    if result.error_count > 0:
        lines.append(f"Errors: {result.error_count} documents failed to extract")
    lines.append(f"Elapsed: {result.elapsed_ms / 1000:.1f}s")
    lines.append("")

    return "\n".join(lines)
