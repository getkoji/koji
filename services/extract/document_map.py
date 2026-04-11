"""Phase 1: Document Mapping — understand the structure before extracting."""

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

CATEGORY_KEYWORDS: list[tuple[list[str], str]] = [
    (["declaration", "dec page", "named insured", "policy period"], "declarations"),
    (["schedule of", "coverage schedule", "limits of", "schedule of coverage"], "schedule_of_coverages"),
    (["endorsement", "amendment", "rider", "this endorsement modifies"], "endorsement"),
    (["conditions", "general conditions", "policy conditions"], "conditions"),
    (["definitions", "defined terms", "as used in this"], "definitions"),
    (["exclusion", "does not apply", "we will not pay"], "exclusions"),
    (["table of contents", "index of forms"], "table_of_contents"),
    (["common policy", "interline"], "common_policy"),
]


def classify_chunk(title: str, content: str) -> str:
    """Classify a chunk by keywords. Returns category or 'other'."""
    text = f"{title} {content[:500]}".lower()

    for keywords, category in CATEGORY_KEYWORDS:
        # Title match is strong signal
        for kw in keywords:
            if kw in title.lower():
                return category
        # Content match needs 2+ keywords
        matches = sum(1 for kw in keywords if kw in text)
        if matches >= 2:
            return category

    return "other"


# ── Content Signal Detection ────────────────────────────────────────

DOLLAR_PATTERN = re.compile(r'\$[\d,]+\.?\d*')
DATE_PATTERN = re.compile(r'\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}|\d{4}[/\-]\d{1,2}[/\-]\d{1,2}')
KEY_VALUE_PATTERN = re.compile(r'^[\w\s]+:\s+\S+', re.MULTILINE)
TABLE_ROW_PATTERN = re.compile(r'\|.*\|.*\|')
POLICY_NUM_PATTERN = re.compile(r'[A-Z]{2,5}\d{5,}')
NAME_SIGNAL_PATTERN = re.compile(r'(?:named insured|insured|policyholder|name)\s*:?\s*(.+)', re.IGNORECASE)


def detect_signals(content: str) -> dict:
    """Detect content signals — what kind of data is in this chunk?"""
    signals = {}

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

    policy_nums = POLICY_NUM_PATTERN.findall(content)
    if policy_nums:
        signals["has_policy_numbers"] = True

    if NAME_SIGNAL_PATTERN.search(content):
        signals["has_name_references"] = True

    return signals


# ── Document Mapper ─────────────────────────────────────────────────

def build_document_map(markdown: str) -> list[Chunk]:
    """Parse markdown into classified, annotated chunks."""
    chunks: list[Chunk] = []
    current_title = "Document Start"
    current_lines: list[str] = []
    index = 0

    for line in markdown.split("\n"):
        if line.startswith("#"):
            if current_lines:
                content = "\n".join(current_lines).strip()
                if content:
                    category = classify_chunk(current_title, content)
                    signals = detect_signals(content)
                    chunks.append(Chunk(
                        index=index,
                        title=current_title,
                        content=content,
                        category=category,
                        signals=signals,
                    ))
                    index += 1
            current_title = line.lstrip("#").strip()
            current_lines = []
        else:
            current_lines.append(line)

    # Last section
    if current_lines:
        content = "\n".join(current_lines).strip()
        if content:
            category = classify_chunk(current_title, content)
            signals = detect_signals(content)
            chunks.append(Chunk(
                index=index,
                title=current_title,
                content=content,
                category=category,
                signals=signals,
            ))

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
