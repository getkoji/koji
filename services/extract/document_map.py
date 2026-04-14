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


DEFAULT_CLASSIFICATION_CONFIG: dict = {
    "window": 500,
    "threshold": 2,
    "scan": "head",
    "title_priority": True,
}

_VALID_SCAN_STRATEGIES = {"head", "all", "head_and_tail"}


def _build_classification_config(schema_def: dict | None) -> dict:
    """Build the classification config from a schema definition.

    Schema format:
        classification:
          window: 1000          # chars of content to scan (default 500)
          threshold: 2          # min content keyword hits to match (default 2)
          scan: head            # head | all | head_and_tail (default head)
          title_priority: true  # title match short-circuits (default true)

    Unknown or invalid values fall back to defaults silently — schema
    authors get sensible behavior without having to validate their config.
    """
    cfg = dict(DEFAULT_CLASSIFICATION_CONFIG)
    if not schema_def:
        return cfg
    raw = schema_def.get("classification")
    if not isinstance(raw, dict):
        return cfg

    window = raw.get("window")
    if isinstance(window, int) and window > 0:
        cfg["window"] = window

    threshold = raw.get("threshold")
    if isinstance(threshold, int) and threshold >= 1:
        cfg["threshold"] = threshold

    scan = raw.get("scan")
    if isinstance(scan, str) and scan in _VALID_SCAN_STRATEGIES:
        cfg["scan"] = scan

    title_priority = raw.get("title_priority")
    if isinstance(title_priority, bool):
        cfg["title_priority"] = title_priority

    return cfg


def _scan_text(content: str, window: int, strategy: str) -> str:
    """Extract the portion of content to classify against.

    - head: first `window` chars
    - all: entire content
    - head_and_tail: first window/2 + last window/2 (useful when a
      category's keywords cluster at the start *or* end of a long section)
    """
    if strategy == "all":
        return content
    if strategy == "head_and_tail":
        half = max(1, window // 2)
        if len(content) <= window:
            return content
        return content[:half] + "\n" + content[-half:]
    return content[:window]


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
    config: dict | None = None,
) -> str:
    """Classify a chunk using schema-provided category keywords.

    Matching rules (tunable via `config`, see DEFAULT_CLASSIFICATION_CONFIG):
    - If `title_priority` is true, a keyword match in the title is a
      strong signal (immediate hit).
    - Content matches need `threshold` keyword hits to count.
    - Only `window` chars of content are scanned, selected by `scan`
      strategy (head / all / head_and_tail).
    - If no keywords match, the chunk is categorized as "other".

    When no category_keywords are provided, every chunk is "other".
    Domain categorization is the schema author's responsibility.
    """
    if not category_keywords:
        return "other"

    cfg = config or DEFAULT_CLASSIFICATION_CONFIG
    window = cfg.get("window", 500)
    threshold = cfg.get("threshold", 2)
    scan = cfg.get("scan", "head")
    title_priority = cfg.get("title_priority", True)

    scanned = _scan_text(content, window, scan)
    text = f"{title} {scanned}".lower()
    title_lower = title.lower()

    for keywords, category in category_keywords:
        if title_priority:
            for kw in keywords:
                if kw in title_lower:
                    return category
        matches = sum(1 for kw in keywords if kw in text)
        if matches >= threshold:
            return category

    return "other"


# ── Content Signal Detection ────────────────────────────────────────

# Generic signals only — no domain-specific patterns. Schema authors
# can define custom signals via `signals:` in their schema.

DOLLAR_PATTERN = re.compile(r"[$€£¥][\d,]+\.?\d*|\b\d+[.,]\d{2}\s*(?:USD|EUR|GBP|JPY|CAD|AUD)\b")
# Date detector recognizes seven families. The signal is used by the router
# to boost chunks that probably contain dates, so broadness helps as long as
# it doesn't over-fire on obvious non-dates (building numbers, stock tickers,
# etc). Anything ambiguous — year-only "2026", compact 8-digit "20260410",
# spelled-out "the tenth day of April", date ranges — is deliberately omitted.
#
# 1. Numeric separators:        04/10/2026, 04-10-2026, 04.10.2026, 2026-04-10
# 2. Month-name leading:        April 10, 2026 / Apr 10 2026 / Sept 15, 2024
# 3. Day-leading European:      10 April 2026 / 22nd March 2025
# 4. Month + year (no day):     April 2026 / Apr 2026 / April, 2026
# 5. Quarter references:        Q1 2026, Q3 FY26, Q4 FY2025
# 6. Fiscal year prefix:        FY2026, FY 2026, FY 2025-26, FY25
# 7. Non-English month names:   10 avril 2026 / 15 März 2025 / 1 de enero de 2026
#
# Boundary guards (`\b`) keep the regex from over-matching building numbers,
# part IDs, or month-as-word sentences ("may be liable", "April showers").
_MONTHS_EN = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
# French: janvier, février, mars, avril, mai, juin, juillet, août,
# septembre, octobre, novembre, décembre. `\xe9` = é, `\xfb` = û.
_MONTHS_FR = (
    r"(?:janvier|f[e\xe9]vrier|mars|avril|mai|juin|juillet|ao[u\xfb]t|"
    r"septembre|octobre|novembre|d[e\xe9]cembre)"
)
# German: Januar, Februar, März, April, Mai, Juni, Juli, August,
# September, Oktober, November, Dezember. `\xe4` = ä.
_MONTHS_DE = (
    r"(?:Januar|Februar|M[a\xe4]rz|April|Mai|Juni|Juli|August|"
    r"September|Oktober|November|Dezember)"
)
# Spanish: enero, febrero, marzo, abril, mayo, junio, julio, agosto,
# septiembre, octubre, noviembre, diciembre.
_MONTHS_ES = (
    r"(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|"
    r"septiembre|octubre|noviembre|diciembre)"
)
# Italian: gennaio, febbraio, marzo, aprile, maggio, giugno, luglio,
# agosto, settembre, ottobre, novembre, dicembre.
_MONTHS_IT = (
    r"(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|"
    r"settembre|ottobre|novembre|dicembre)"
)
# Non-English months combined into one alternation — used for families
# 2, 3, and 4 so "10 avril 2026", "avril 2026", and "22 marzo 2026" all
# match. English stays in its own constant so the common case doesn't
# pay for the alternation width on every match.
_MONTHS_I18N = rf"(?:{_MONTHS_EN[3:-1]}|{_MONTHS_FR[3:-1]}|{_MONTHS_DE[3:-1]}|{_MONTHS_ES[3:-1]}|{_MONTHS_IT[3:-1]})"
DATE_PATTERN = re.compile(
    # Family 1: numeric separators
    r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}"
    r"|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}"
    # Family 2: month-name leading — April 10, 2026 / Apr 10 2026 (English)
    rf"|\b{_MONTHS_EN}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}\b"
    # Family 3: day-leading European — 10 April 2026 / 10th Apr 2026 (English)
    rf"|\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTHS_EN}\s+\d{{4}}\b"
    # Family 4: month + year without day — April 2026 / Apr, 2026
    rf"|\b{_MONTHS_EN},?\s+\d{{4}}\b"
    # Family 5: quarter reference — Q1 2026 / Q3 FY26 / Q4 FY 2025
    r"|\bQ[1-4][\s-]+(?:FY\s*)?\d{2,4}\b"
    # Family 6: fiscal-year prefix — FY2026 / FY 2026 / FY 2025-26 / FY25
    r"|\bFY\s*\d{2,4}(?:[/\-]\d{2,4})?\b"
    # Family 7: non-English month-name leading + day-leading
    rf"|\b{_MONTHS_I18N}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}\b"
    rf"|\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:de\s+)?{_MONTHS_I18N}(?:\s+de)?\s+\d{{4}}\b"
    rf"|\b{_MONTHS_I18N},?\s+\d{{4}}\b",
    re.IGNORECASE | re.UNICODE,
)
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


# ── Heading Inference ───────────────────────────────────────────────

# Used when the parsed markdown contains no `#` headers — a common failure
# mode for OCR'd PDFs, invoices, and table-heavy docs that docling emits as
# flat text. We promote visually prominent standalone lines (bold, ALL CAPS,
# or schema-defined patterns) to `##` headings so the chunker has something
# to split on.

_HAS_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s", re.MULTILINE)
_BOLD_LINE_RE = re.compile(r"^\*\*([^*]+?)\*\*:?\s*$")
_ALLCAPS_LINE_RE = re.compile(r"^[A-Z][A-Z0-9 &/\-]{2,60}:?$")
_HEADING_MAX_LEN = 80

# A "stanza" is a run of consecutive bold / ALL CAPS lines separated only by
# blanks. Short stanzas (2..N-1 lines) are merged into a single heading
# so multi-line titles like `**Book Title**` / `**Author Name**` stay
# intact. Stanzas of length N or more are assumed to be word-wrapped
# boilerplate (cover pages, legal front matter) where no single line is
# a meaningful heading — nothing gets promoted in that case.
_STANZA_DISBAND_THRESHOLD = 5


def _looks_like_heading_text(text: str) -> bool:
    """Reject bold spans that are clearly not semantic headings.

    Parsers routinely bold per-word form fields like phone numbers,
    registration IDs, and ZIP codes. Those aren't headings and shouldn't
    anchor a chunk. Require enough alphabetic content to count as text.
    """
    alpha = sum(1 for c in text if c.isalpha())
    return alpha >= 3 and alpha / max(len(text), 1) >= 0.3


def _compile_heading_patterns(schema_def: dict | None) -> list[re.Pattern]:
    """Compile schema-defined heading regexes.

    Schema format:
        headings:
          infer: true           # optional, defaults to true
          patterns:
            - "^INVOICE$"
            - "^SECTION \\d+"
    """
    if not schema_def:
        return []
    headings = schema_def.get("headings") or {}
    if not isinstance(headings, dict):
        return []
    patterns = headings.get("patterns") or []
    if not isinstance(patterns, list):
        return []
    compiled = []
    for p in patterns:
        if not isinstance(p, str):
            continue
        try:
            compiled.append(re.compile(p))
        except re.error:
            continue
    return compiled


def _heading_inference_enabled(schema_def: dict | None) -> bool:
    if not schema_def:
        return True
    headings = schema_def.get("headings")
    if not isinstance(headings, dict):
        return True
    return headings.get("infer", True) is not False


def _generic_heading_heuristics_enabled(schema_def: dict | None) -> bool:
    """Whether the bold / ALL CAPS heuristics should run.

    Schema authors can disable the generic heuristics while keeping
    their explicit `patterns` — useful on docs where bold/all-caps
    lines are stylistic rather than structural.
    """
    if not schema_def:
        return True
    headings = schema_def.get("headings")
    if not isinstance(headings, dict):
        return True
    return headings.get("generic", True) is not False


def _infer_headings(markdown: str, schema_def: dict | None = None) -> str:
    """Inject synthetic ## markers for prominent lines when markdown has no headings.

    Returns markdown unchanged if any `#` heading already exists — we trust
    well-structured input and only fill the gap for parse outputs that lost
    their structure.

    Consecutive bold / ALL CAPS lines separated only by blanks are a
    **stanza** — think book cover, article header, multi-line company name.
    The whole stanza is merged into a single heading so multi-line titles
    like `**CXJ**` / `**GROUP CO., Limited**` stay intact. If the stanza
    grows past _STANZA_DISBAND_THRESHOLD lines it's treated as word-wrapped
    boilerplate (cover pages, legal front matter) and nothing is promoted.
    """
    if _HAS_MARKDOWN_HEADING_RE.search(markdown):
        return markdown
    if not _heading_inference_enabled(schema_def):
        return markdown

    schema_patterns = _compile_heading_patterns(schema_def)
    generic_enabled = _generic_heading_heuristics_enabled(schema_def)
    lines = markdown.split("\n")
    out: list[str] = []

    # Each stanza entry is (index in `out`, extracted heading text).
    # Heuristic lines are appended as their original form during the
    # walk and get rewritten into `## heading` on flush.
    stanza: list[tuple[int, str]] = []

    def _flush_stanza() -> None:
        if not stanza:
            return
        if len(stanza) >= _STANZA_DISBAND_THRESHOLD:
            # Too long to be a semantic title — leave all original lines
            # in place and let the stanza fall through to the next chunk.
            stanza.clear()
            return
        merged = " ".join(text for _, text in stanza)
        first_idx = stanza[0][0]
        out[first_idx] = f"## {merged}"
        stanza.clear()

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            out.append(line)
            continue

        # Heading-like lines must start a fresh paragraph — that's the
        # signal that the line stands apart from surrounding prose.
        above_blank = i == 0 or lines[i - 1].strip() == ""
        schema_promoted: str | None = None
        heuristic_text: str | None = None

        if above_blank:
            for pat in schema_patterns:
                if pat.fullmatch(stripped):
                    schema_promoted = stripped.rstrip(":").strip()
                    break

            if schema_promoted is None and generic_enabled:
                m = _BOLD_LINE_RE.match(stripped)
                if m:
                    captured = m.group(1).strip()
                    if len(captured) <= _HEADING_MAX_LEN and _looks_like_heading_text(captured):
                        heuristic_text = captured.rstrip(":").strip()
                elif _ALLCAPS_LINE_RE.match(stripped):
                    heuristic_text = stripped.rstrip(":").strip()

        if heuristic_text is not None:
            # Accumulate into the current stanza; commit on flush.
            stanza.append((len(out), heuristic_text))
            out.append(line)
        else:
            # Any non-heuristic content (including schema-pattern
            # promotions and regular prose) ends the current stanza.
            _flush_stanza()
            if schema_promoted is not None:
                out.append(f"## {schema_promoted}")
            else:
                out.append(line)

    _flush_stanza()
    return "\n".join(out)


# ── Table Cell Normalization ────────────────────────────────────────

_TABLE_ROW_CELL_MIN_RUN = 3  # collapse a run of N identical cells into 1 when N >= this
_TABLE_ROW_PREFIX_RE = re.compile(r"^\s*\|")


def _row_is_tripled(parts: list[str]) -> bool:
    """Heuristic: does this row look like a parser-duplicated table row?

    A row qualifies if at least one run of _TABLE_ROW_CELL_MIN_RUN or more
    consecutive identical non-empty cells contains alphabetic text. Pure
    numeric / symbol duplicates alone (e.g. `$100 | $100 | $100`) are not
    enough — real financial tables legitimately repeat values across
    quarters or columns.
    """
    i = 0
    while i < len(parts):
        current = parts[i].strip()
        if not current:
            i += 1
            continue
        run_end = i + 1
        while run_end < len(parts) and parts[run_end].strip() == current:
            run_end += 1
        run_length = run_end - i
        if run_length >= _TABLE_ROW_CELL_MIN_RUN and any(c.isalpha() for c in current):
            return True
        i = run_end
    return False


def _dedupe_table_row_repeats(markdown: str) -> str:
    """Collapse runs of identical adjacent cells in markdown table rows.

    Parsers (notably docling) sometimes represent column-spanning cells by
    duplicating the cell content N times across the row. The result — e.g.
    `| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 |` —
    confuses the extractor because the same field appears repeated in a
    way that looks like distinct values. Collapsing the repeats restores
    the original meaning without losing information.

    A row is only deduped when it shows an alphabetic-cell triplication
    signal (see `_row_is_tripled`); otherwise it's left alone so a
    legitimate financial row like `| Revenue | $100 | $100 | $100 |`
    keeps its column structure.
    """
    if "|" not in markdown:
        return markdown

    out_lines: list[str] = []
    for line in markdown.split("\n"):
        if not _TABLE_ROW_PREFIX_RE.match(line):
            out_lines.append(line)
            continue

        stripped = line.strip()
        # Preserve separator rows (all dashes/colons/pipes/spaces)
        if all(c in "-:| \t" for c in stripped):
            out_lines.append(line)
            continue

        parts = line.split("|")
        if not _row_is_tripled(parts):
            out_lines.append(line)
            continue

        # Row is confirmed tripled — collapse every run of ≥N identical
        # non-empty cells regardless of cell type.
        new_parts: list[str] = []
        i = 0
        while i < len(parts):
            current = parts[i]
            current_stripped = current.strip()
            if not current_stripped:
                new_parts.append(current)
                i += 1
                continue
            run_end = i + 1
            while run_end < len(parts) and parts[run_end].strip() == current_stripped:
                run_end += 1
            run_length = run_end - i
            if run_length >= _TABLE_ROW_CELL_MIN_RUN:
                new_parts.append(current)
                i = run_end
            else:
                new_parts.append(current)
                i += 1
        out_lines.append("|".join(new_parts))

    return "\n".join(out_lines)


# ── Document Mapper ─────────────────────────────────────────────────


def build_document_map(markdown: str, schema_def: dict | None = None) -> list[Chunk]:
    """Parse markdown into classified, annotated chunks.

    Categorization and custom signals come from the schema definition.
    Without a schema, all chunks are categorized as "other" with only
    built-in generic signals.

    Preprocessing runs in order:
    1. `_dedupe_table_row_repeats` — collapse parser-duplicated table cells
    2. `_infer_headings` — promote visually-prominent lines to `##` when
       the markdown has no `#` headings
    """
    markdown = _dedupe_table_row_repeats(markdown)
    markdown = _infer_headings(markdown, schema_def)
    category_keywords = _build_category_keywords(schema_def)
    custom_signals = _compile_custom_signals(schema_def)
    classification_config = _build_classification_config(schema_def)

    chunks: list[Chunk] = []
    current_title = "Document Start"
    current_lines: list[str] = []
    index = 0

    def _finalize() -> None:
        nonlocal index
        content = "\n".join(current_lines).strip()
        if not content:
            return
        category = classify_chunk(current_title, content, category_keywords, classification_config)
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
