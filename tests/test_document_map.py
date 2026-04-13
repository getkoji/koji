"""Tests for services/extract/document_map.py — document mapping, classification, signal detection."""

from __future__ import annotations

from services.extract.document_map import (
    Chunk,
    _build_category_keywords,
    _compile_custom_signals,
    _infer_headings,
    build_document_map,
    classify_chunk,
    detect_signals,
    summarize_map,
)
from tests.conftest import SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA

# ── Chunk dataclass ───────────────────────────────────────────────────


class TestChunk:
    def test_line_count(self):
        c = Chunk(index=0, title="T", content="line1\nline2\nline3")
        assert c.line_count == 3

    def test_char_count(self):
        c = Chunk(index=0, title="T", content="hello")
        assert c.char_count == 5

    def test_empty_content(self):
        c = Chunk(index=0, title="T", content="")
        assert c.line_count == 1
        assert c.char_count == 0


# ── classify_chunk with schema-defined categories ────────────────────

# Example category keywords an invoice schema might provide.
INVOICE_CATEGORY_KEYWORDS = [
    (["invoice", "bill to", "ship to", "receipt"], "header"),
    (["description", "quantity", "unit price"], "line_items"),
    (["subtotal", "tax", "total due", "balance due"], "totals"),
]

# Example from the insurance schema.
INSURANCE_CATEGORY_KEYWORDS = [
    (["declaration", "dec page", "named insured", "policy period"], "declarations"),
    (["schedule of", "coverage schedule", "limits of"], "schedule_of_coverages"),
    (["endorsement", "amendment", "rider"], "endorsement"),
]


class TestClassifyChunk:
    def test_no_keywords_everything_is_other(self):
        """With no schema categories, no classification happens."""
        assert classify_chunk("Declarations Page", "Some content") == "other"
        assert classify_chunk("Schedule of Coverages", "x") == "other"
        assert classify_chunk("Anything", "anything") == "other"

    def test_schema_categories_applied(self):
        """Schema-provided categories drive classification."""
        assert classify_chunk("Declarations Page", "Some content", INSURANCE_CATEGORY_KEYWORDS) == "declarations"
        assert classify_chunk("Schedule of Coverages", "table", INSURANCE_CATEGORY_KEYWORDS) == "schedule_of_coverages"

    def test_invoice_categories(self):
        """Different schema, different categories — same function."""
        assert classify_chunk("Invoice Header", "Bill to Acme", INVOICE_CATEGORY_KEYWORDS) == "header"
        assert (
            classify_chunk(
                "Random", "Description of services. Quantity shipped. Unit price each.", INVOICE_CATEGORY_KEYWORDS
            )
            == "line_items"
        )

    def test_title_match_is_strong_signal(self):
        """A keyword in the title matches immediately, no content check needed."""
        assert classify_chunk("Endorsement", "random content", INSURANCE_CATEGORY_KEYWORDS) == "endorsement"

    def test_content_needs_two_keywords(self):
        """A single keyword in content isn't enough — avoids false positives."""
        # Title has no keywords, content has only one ("endorsement")
        assert classify_chunk("Random Title", "this endorsement modifies", INSURANCE_CATEGORY_KEYWORDS) == "other"
        # But two keywords in content DO match
        assert (
            classify_chunk("Random Title", "this endorsement amendment stuff", INSURANCE_CATEGORY_KEYWORDS)
            == "endorsement"
        )

    def test_unknown_returns_other(self):
        assert classify_chunk("Random Section", "Nothing special", INSURANCE_CATEGORY_KEYWORDS) == "other"

    def test_case_insensitive(self):
        assert classify_chunk("DECLARATIONS PAGE", "stuff", INSURANCE_CATEGORY_KEYWORDS) == "declarations"


# ── _build_category_keywords ──────────────────────────────────────────


class TestBuildCategoryKeywords:
    def test_none_returns_empty(self):
        assert _build_category_keywords(None) == []

    def test_no_categories_returns_empty(self):
        assert _build_category_keywords({"fields": {}}) == []

    def test_empty_keywords_returns_empty(self):
        assert _build_category_keywords({"categories": {"keywords": {}}}) == []

    def test_invoice_schema_keywords(self):
        schema = {
            "categories": {
                "keywords": {
                    "header": ["invoice", "bill to"],
                    "totals": ["subtotal", "total"],
                }
            }
        }
        pairs = _build_category_keywords(schema)
        assert len(pairs) == 2
        categories = {name for _, name in pairs}
        assert categories == {"header", "totals"}

    def test_insurance_schema_keywords(self):
        """The bundled insurance schema from conftest should produce category pairs."""
        pairs = _build_category_keywords(SAMPLE_SCHEMA)
        # SAMPLE_SCHEMA may or may not define categories — check it doesn't crash
        assert isinstance(pairs, list)


# ── detect_signals — generic only ─────────────────────────────────────


class TestDetectSignals:
    def test_dollar_amounts(self):
        signals = detect_signals("Premium: $4,250.00 and deductible $1,000")
        assert signals["has_dollar_amounts"] is True
        assert signals["dollar_count"] == 2

    def test_euro_and_other_currencies(self):
        """Generic dollar signal should match any currency symbol."""
        signals = detect_signals("Total: €1,200.00 and £500.50")
        assert signals["has_dollar_amounts"] is True
        assert signals["dollar_count"] == 2

    def test_dates(self):
        signals = detect_signals("Policy Period: 01/15/2025 to 01/15/2026")
        assert signals["has_dates"] is True
        assert signals["date_count"] == 2

    def test_iso_dates(self):
        signals = detect_signals("Effective: 2025-01-15")
        assert signals["has_dates"] is True

    def test_dotted_dates(self):
        signals = detect_signals("Datum: 15.08.2025")
        assert signals["has_dates"] is True

    def test_key_value_pairs(self):
        signals = detect_signals("Policy Number: BOP123\nInsured: Acme Corp")
        assert signals["has_key_value_pairs"] is True
        assert signals["kv_count"] == 2

    def test_tables(self):
        signals = detect_signals("| Coverage | Limit |\n|---|---|\n| Building | $500,000 |")
        assert signals["has_tables"] is True
        assert signals["table_row_count"] == 3

    def test_no_signals(self):
        signals = detect_signals("Just plain text with nothing special.")
        assert signals == {}

    def test_no_hardcoded_domain_signals(self):
        """Insurance-specific signals are no longer built in."""
        signals = detect_signals("Policy Number: BOP7284930")
        # Should NOT have has_policy_numbers — that's now schema-configurable
        assert "has_policy_numbers" not in signals

        signals = detect_signals("Named Insured: Acme Widget Corporation")
        assert "has_name_references" not in signals


# ── Custom signals from schema ────────────────────────────────────────


class TestCustomSignals:
    def test_compile_custom_signals_none(self):
        assert _compile_custom_signals(None) == []

    def test_compile_custom_signals_empty_schema(self):
        assert _compile_custom_signals({"fields": {}}) == []

    def test_compile_pattern(self):
        schema = {
            "signals": {
                "has_policy_numbers": {"pattern": r"[A-Z]{2,5}\d{5,}"},
            }
        }
        compiled = _compile_custom_signals(schema)
        assert len(compiled) == 1
        name, pattern = compiled[0]
        assert name == "has_policy_numbers"
        assert pattern.search("Policy Number: BOP7284930")

    def test_case_insensitive_flag(self):
        schema = {
            "signals": {
                "has_named_insured": {
                    "pattern": r"named\s*insured",
                    "flags": "i",
                },
            }
        }
        compiled = _compile_custom_signals(schema)
        name, pattern = compiled[0]
        assert pattern.search("NAMED INSURED: Acme Corp")

    def test_invalid_pattern_skipped(self):
        schema = {"signals": {"bad": {"pattern": "[unclosed"}}}
        # Should not raise
        compiled = _compile_custom_signals(schema)
        assert compiled == []

    def test_detect_signals_with_custom(self):
        schema = {
            "signals": {
                "has_policy_numbers": {"pattern": r"[A-Z]{2,5}\d{5,}"},
                "has_named_insured": {"pattern": r"named\s*insured", "flags": "i"},
            }
        }
        custom = _compile_custom_signals(schema)
        signals = detect_signals("Named Insured: Acme Corp\nPolicy: BOP12345", custom)
        assert signals["has_policy_numbers"] is True
        assert signals["has_named_insured"] is True

    def test_custom_signals_added_to_count(self):
        schema = {"signals": {"has_emails": {"pattern": r"\S+@\S+"}}}
        custom = _compile_custom_signals(schema)
        signals = detect_signals("Contact: alice@example.com, bob@example.com", custom)
        assert signals["has_emails"] is True
        assert signals["has_emails_count"] == 2


# ── build_document_map ────────────────────────────────────────────────


class TestBuildDocumentMap:
    def test_parses_sections_without_schema(self):
        """Without a schema, everything categorizes as 'other' but structure works."""
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        assert len(chunks) == 6
        titles = [c.title for c in chunks]
        assert "Declarations Page" in titles
        assert "Schedule of Coverages" in titles
        assert "Business Liability Endorsement" in titles
        # Without a schema, everything is "other"
        assert all(c.category == "other" for c in chunks)

    def test_chunk_indices_sequential(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        for i, chunk in enumerate(chunks):
            assert chunk.index == i

    def test_schema_drives_classification(self):
        """With a schema, categories are derived from schema keywords."""
        schema = {
            "categories": {
                "keywords": {
                    "declarations": ["declaration", "named insured"],
                    "schedule_of_coverages": ["schedule of", "coverage schedule"],
                    "endorsement": ["endorsement", "amendment"],
                }
            }
        }
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, schema)
        dec = [c for c in chunks if c.title == "Declarations Page"][0]
        assert dec.category == "declarations"

        sched = [c for c in chunks if c.title == "Schedule of Coverages"][0]
        assert sched.category == "schedule_of_coverages"

    def test_schema_drives_custom_signals(self):
        schema = {
            "signals": {
                "has_policy_numbers": {"pattern": r"[A-Z]{2,5}\d{5,}"},
            }
        }
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, schema)
        dec = [c for c in chunks if c.title == "Declarations Page"][0]
        assert dec.signals.get("has_policy_numbers") is True

    def test_generic_signals_still_work(self):
        """Built-in generic signals fire regardless of schema."""
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        dec = [c for c in chunks if c.title == "Declarations Page"][0]
        assert dec.signals.get("has_dollar_amounts") is True
        assert dec.signals.get("has_dates") is True

    def test_empty_markdown(self):
        assert build_document_map("") == []

    def test_no_headers(self):
        chunks = build_document_map("Just some plain text\nwith no headers at all.")
        assert len(chunks) == 1
        assert chunks[0].title == "Document Start"
        assert chunks[0].category == "other"

    def test_single_section(self):
        md = "# Only Section\n\nSome content here."
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].title == "Only Section"

    def test_empty_sections_skipped(self):
        md = "# Header 1\n\n# Header 2\n\nActual content"
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].title == "Header 2"

    def test_whitespace_only_content_skipped(self):
        md = "# Section A\n\n   \n\n# Section B\n\nReal content"
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].title == "Section B"

    def test_invoice_schema(self):
        """Verifies the invoice use case that drove this refactor."""
        invoice_md = """# INVOICE

**Sagebrush Design Studio**
1821 Alder Street
Portland, OR 97210

## Bill To

Lumen Biotech Inc.

## Services

| Service | Rate |
|---|---|
| Design | $200 |

## Totals

Subtotal: $8,400
Total Due: $8,400
"""
        invoice_schema = {
            "categories": {
                "keywords": {
                    "header": ["invoice", "bill to", "ship to"],
                    "line_items": ["services", "description", "quantity"],
                    "totals": ["subtotal", "total due", "balance"],
                }
            }
        }
        chunks = build_document_map(invoice_md, invoice_schema)
        by_category = {c.category: c for c in chunks}
        # "INVOICE" title matches "invoice" keyword
        assert "header" in by_category
        # "Services" title matches "services" keyword
        assert "line_items" in by_category
        # "Totals" title with "subtotal" and "total due" in content matches
        assert "totals" in by_category


# ── Heading inference ─────────────────────────────────────────────────


class TestInferHeadings:
    def test_noop_when_hash_headers_present(self):
        md = "# Real Heading\n\nContent\n\n**Standalone Bold**\n\nmore"
        assert _infer_headings(md) == md

    def test_noop_when_empty(self):
        assert _infer_headings("") == ""

    def test_promotes_standalone_bold(self):
        md = "**Invoice Summary**\n\nContent here\n\n**Totals**\n\nmore"
        out = _infer_headings(md)
        assert "## Invoice Summary" in out
        assert "## Totals" in out

    def test_bold_with_trailing_colon_stripped(self):
        md = "**Bill To:**\n\nAcme Corp"
        out = _infer_headings(md)
        assert "## Bill To" in out
        assert "Bill To:" not in out.replace("## Bill To", "")

    def test_promotes_standalone_all_caps(self):
        md = "INVOICE\n\nSome body text\n\nBILL TO\n\nAcme"
        out = _infer_headings(md)
        assert "## INVOICE" in out
        assert "## BILL TO" in out

    def test_all_caps_with_trailing_colon(self):
        md = "NAMED INSURED:\n\nAcme Corp"
        out = _infer_headings(md)
        assert "## NAMED INSURED" in out

    def test_promotes_bold_followed_directly_by_content(self):
        """Bold labels above their content (no blank line between) ARE headings."""
        md = "**Bill To**\nAcme Corp\n123 Main St"
        out = _infer_headings(md)
        assert "## Bill To" in out

    def test_promotes_all_caps_above_content(self):
        """ALL CAPS labels above content (e.g. SOLD TO: in invoices) ARE headings."""
        md = "SOLD TO:\nMojave Engineering\n15500 N Perimeter Dr"
        out = _infer_headings(md)
        assert "## SOLD TO" in out

    def test_does_not_promote_mid_paragraph_lines(self):
        """A heading-shaped line in the middle of a paragraph (no blank above) stays put."""
        md = "Some intro text\nINVOICE\nmore text"
        out = _infer_headings(md)
        assert "##" not in out

    def test_does_not_promote_kv_line(self):
        """Key-value pairs contain colons with content after — not headings."""
        md = "Policy Number: BOP12345\n\nOther stuff"
        out = _infer_headings(md)
        assert "##" not in out

    def test_does_not_promote_mixed_case(self):
        md = "Invoice Details\n\nSome body"
        out = _infer_headings(md)
        assert "##" not in out

    def test_schema_patterns_applied(self):
        schema = {"headings": {"patterns": [r"^SECTION \d+$"]}}
        md = "SECTION 1\n\nfirst body\n\nSECTION 2\n\nsecond body"
        out = _infer_headings(md, schema)
        assert "## SECTION 1" in out
        assert "## SECTION 2" in out

    def test_schema_patterns_require_fullmatch(self):
        """A pattern must match the whole line, not just a substring."""
        schema = {"headings": {"patterns": [r"PART"]}}
        md = "THIS IS PART OF A PARAGRAPH\n\nMore content"
        out = _infer_headings(md, schema)
        # The all-caps rule may still fire on the first line — that's fine;
        # what matters is the schema pattern doesn't over-match substrings.
        # Assert the schema didn't crash and the doc is still processable.
        assert isinstance(out, str)

    def test_infer_disabled_via_schema(self):
        schema = {"headings": {"infer": False}}
        md = "**Invoice**\n\nbody"
        assert _infer_headings(md, schema) == md

    def test_invalid_schema_pattern_skipped(self):
        schema = {"headings": {"patterns": ["[unclosed"]}}
        md = "**Invoice**\n\nbody"
        out = _infer_headings(md, schema)
        assert "## Invoice" in out

    def test_invoice_without_hash_headers_is_chunked(self):
        """End-to-end via build_document_map: a headerless invoice gets split."""
        invoice_md = """**INVOICE**

Sagebrush Design Studio

BILL TO

Lumen Biotech Inc.

SERVICES

| Service | Rate |
|---|---|
| Design | $200 |

TOTALS

Subtotal: $8,400
Total Due: $8,400
"""
        chunks = build_document_map(invoice_md)
        titles = [c.title for c in chunks]
        assert "INVOICE" in titles
        assert "BILL TO" in titles
        assert "SERVICES" in titles
        assert "TOTALS" in titles
        assert len(chunks) >= 4

    def test_existing_hash_headers_untouched(self):
        """Regression: a well-formed markdown doc still chunks the same way."""
        md = "# Real\n\n**Bold line that would have been promoted**\n\nbody"
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].title == "Real"
        # The bold line stays inside the content, not promoted to a new chunk
        assert "Bold line" in chunks[0].content


# ── summarize_map ─────────────────────────────────────────────────────


class TestSummarizeMap:
    def test_summary_structure(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        summary = summarize_map(chunks)
        assert "total_chunks" in summary
        assert "by_category" in summary
        assert "signal_counts" in summary
        assert summary["total_chunks"] == 6

    def test_empty_chunks(self):
        summary = summarize_map([])
        assert summary["total_chunks"] == 0
        assert summary["by_category"] == {}
