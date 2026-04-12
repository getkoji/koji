"""Phase 1: Document Mapping — understand the structure before extracting.

The document mapper is domain-agnostic. It splits markdown into chunks by
heading, detects generic structural signals (dollars, dates, tables,
key-value pairs), and optionally applies schema-defined categories and
custom signals.

Users drive all domain knowledge via their schema:

    # my-schema.yaml
    categories:
      keywords:
        header: ["invoice", "bill to", "receipt"]
        line_items: ["description", "quantity", "unit price"]
        totals: ["subtotal", "tax", "total due"]

    signals:
      has_policy_numbers:
        pattern: "[A-Z]{2,5}\\d{5,}"
      has_named_insured:
        pattern: "(?:named insured|policyholder)"

The pipeline calls `build_document_map(markdown, schema_def)` and the
mapper uses the schema's category keywords and custom signal patterns
to annotate each chunk. Without a schema, all chunks are categorized
as "other" with only the built-in generic signals.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Chunk:
    """A classified, annotated section of the document."""

    index: int
    title: str
    content: str
    category: str = "other"
    signals: dict = field(default_factory=dict)

    @property
    def line_count(self) -> int:
        return len(self.content.split("\n"))

    @property
    def char_count(self) -> int:
        return len(self.content)


# ── Section Classification ──────────────────────────────────────────


def _build_category_keywords(schema_def: dict | None) -> list[tuple[list[str], str]]:
    """Extract category keyword pairs from a schema definition.

    Schema format:
        categories:
          keywords:
            header: ["invoice", "receipt"]
            line_items: ["description", "quantity"]

    Returns a list of (keywords, category_name) tuples. Empty list if the
    schema has no categories or is None — callers should treat that as
    "everything is 'other'".
    """
    if not schema_def:
        return []
    categories = schema_def.get("categories") or {}
    keywords_by_category = categories.get("keywords") or {}
    if not isinstance(keywords_by_category, dict):
        return []
    return [(list(keywords), category) for category, keywords in keywords_by_category.items() if keywords]


def classify_chunk(
    title: str,
    content: str,
    category_keywords: list[tuple[list[str], str]] | None = None,
) -> str:
    """Classify a chunk using schema-provided category keywords.

    Matching rules:
    - A keyword match in the title is a strong signal (immediate hit).
    - Content matches need 2+ keywords to reduce false positives.
    - If no keywords match, the chunk is categorized as "other".

    When no category_keywords are provided, every chunk is "other".
    Domain categorization is the schema author's responsibility.
    """
    if not category_keywords:
        return "other"

    text = f"{title} {content[:500]}".lower()
    title_lower = title.lower()

    for keywords, category in category_keywords:
        # Title match is strong signal
        for kw in keywords:
            if kw in title_lower:
                return category
        # Content match needs 2+ keywords
        matches = sum(1 for kw in keywords if kw in text)
        if matches >= 2:
            return category

    return "other"


# ── Content Signal Detection ────────────────────────────────────────

# Generic signals only — no domain-specific patterns. Schema authors
# can define custom signals via `signals:` in their schema.

DOLLAR_PATTERN = re.compile(r"[$€£¥][\d,]+\.?\d*|\b\d+[.,]\d{2}\s*(?:USD|EUR|GBP|JPY|CAD|AUD)\b")
DATE_PATTERN = re.compile(r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}")
KEY_VALUE_PATTERN = re.compile(r"^[\w\s]+:\s+\S+", re.MULTILINE)
TABLE_ROW_PATTERN = re.compile(r"\|.*\|.*\|")


def _compile_custom_signals(schema_def: dict | None) -> list[tuple[str, re.Pattern]]:
    """Build a list of (signal_name, compiled_regex) from the schema.

    Schema format:
        signals:
          has_policy_numbers:
            pattern: "[A-Z]{2,5}\\d{5,}"
            flags: "i"  # optional, "i" for case-insensitive
    """
    if not schema_def:
        return []
    signals_def = schema_def.get("signals") or {}
    if not isinstance(signals_def, dict):
        return []

    compiled = []
    for name, spec in signals_def.items():
        if not isinstance(spec, dict):
            continue
        pattern = spec.get("pattern")
        if not pattern:
            continue
        flags = 0
        flag_str = spec.get("flags", "")
        if "i" in flag_str:
            flags |= re.IGNORECASE
        if "m" in flag_str:
            flags |= re.MULTILINE
        if "s" in flag_str:
            flags |= re.DOTALL
        try:
            compiled.append((name, re.compile(pattern, flags)))
        except re.error:
            # Skip invalid patterns silently — they'll be validated elsewhere
            continue

    return compiled


def detect_signals(
    content: str,
    custom_signals: list[tuple[str, re.Pattern]] | None = None,
) -> dict:
    """Detect content signals — what kind of data is in this chunk?

    Built-in generic signals:
      - has_dollar_amounts (with dollar_count)
      - has_dates (with date_count)
      - has_key_value_pairs (with kv_count)
      - has_tables (with table_row_count)

    Custom signals are defined in the schema and matched via regex.
    If a custom pattern matches, the signal is set to True and a
    <name>_count is set to the number of matches.
    """
    signals: dict = {}

    dollars = DOLLAR_PATTERN.findall(content)
    if dollars:
        signals["has_dollar_amounts"] = True
        signals["dollar_count"] = len(dollars)

    dates = DATE_PATTERN.findall(content)
    if dates:
        signals["has_dates"] = True
        signals["date_count"] = len(dates)

    kv_pairs = KEY_VALUE_PATTERN.findall(content)
    if kv_pairs:
        signals["has_key_value_pairs"] = True
        signals["kv_count"] = len(kv_pairs)

    table_rows = TABLE_ROW_PATTERN.findall(content)
    if table_rows:
        signals["has_tables"] = True
        signals["table_row_count"] = len(table_rows)

    if custom_signals:
        for name, pattern in custom_signals:
            matches = pattern.findall(content)
            if matches:
                signals[name] = True
                signals[f"{name}_count"] = len(matches)

    return signals


# ── Document Mapper ─────────────────────────────────────────────────


def build_document_map(markdown: str, schema_def: dict | None = None) -> list[Chunk]:
    """Parse markdown into classified, annotated chunks.

    Categorization and custom signals come from the schema definition.
    Without a schema, all chunks are categorized as "other" with only
    built-in generic signals.
    """
    category_keywords = _build_category_keywords(schema_def)
    custom_signals = _compile_custom_signals(schema_def)

    chunks: list[Chunk] = []
    current_title = "Document Start"
    current_lines: list[str] = []
    index = 0

    def _finalize() -> None:
        nonlocal index
        content = "\n".join(current_lines).strip()
        if not content:
            return
        category = classify_chunk(current_title, content, category_keywords)
        signals = detect_signals(content, custom_signals)
        chunks.append(
            Chunk(
                index=index,
                title=current_title,
                content=content,
                category=category,
                signals=signals,
            )
        )
        index += 1

    for line in markdown.split("\n"):
        if line.startswith("#"):
            _finalize()
            current_title = line.lstrip("#").strip()
            current_lines = []
        else:
            current_lines.append(line)

    # Last section
    _finalize()

    return chunks


def summarize_map(chunks: list[Chunk]) -> dict:
    """Summarize the document map for logging/debugging."""
    by_category: dict[str, int] = {}
    for c in chunks:
        by_category[c.category] = by_category.get(c.category, 0) + 1

    with_signals: dict[str, int] = {}
    for c in chunks:
        for signal in c.signals:
            with_signals[signal] = with_signals.get(signal, 0) + 1

    return {
        "total_chunks": len(chunks),
        "by_category": by_category,
        "signal_counts": with_signals,
    }
