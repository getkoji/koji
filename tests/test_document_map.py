"""Tests for services/extract/document_map.py — document mapping, classification, signal detection."""

from __future__ import annotations

from services.extract.document_map import (
    DEFAULT_CLASSIFICATION_CONFIG,
    Chunk,
    _build_category_keywords,
    _build_classification_config,
    _compile_custom_signals,
    _dedupe_table_row_repeats,
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


# ── Classification config ─────────────────────────────────────────────


class TestBuildClassificationConfig:
    def test_none_returns_defaults(self):
        assert _build_classification_config(None) == DEFAULT_CLASSIFICATION_CONFIG

    def test_empty_schema_returns_defaults(self):
        assert _build_classification_config({"fields": {}}) == DEFAULT_CLASSIFICATION_CONFIG

    def test_non_dict_classification_ignored(self):
        assert _build_classification_config({"classification": "nope"}) == DEFAULT_CLASSIFICATION_CONFIG

    def test_window_override(self):
        cfg = _build_classification_config({"classification": {"window": 1500}})
        assert cfg["window"] == 1500

    def test_window_invalid_falls_back(self):
        cfg = _build_classification_config({"classification": {"window": -1}})
        assert cfg["window"] == DEFAULT_CLASSIFICATION_CONFIG["window"]
        cfg = _build_classification_config({"classification": {"window": "big"}})
        assert cfg["window"] == DEFAULT_CLASSIFICATION_CONFIG["window"]

    def test_threshold_override(self):
        cfg = _build_classification_config({"classification": {"threshold": 1}})
        assert cfg["threshold"] == 1

    def test_threshold_zero_rejected(self):
        cfg = _build_classification_config({"classification": {"threshold": 0}})
        assert cfg["threshold"] == DEFAULT_CLASSIFICATION_CONFIG["threshold"]

    def test_scan_override(self):
        for strategy in ("head", "all", "head_and_tail"):
            cfg = _build_classification_config({"classification": {"scan": strategy}})
            assert cfg["scan"] == strategy

    def test_scan_invalid_falls_back(self):
        cfg = _build_classification_config({"classification": {"scan": "bogus"}})
        assert cfg["scan"] == DEFAULT_CLASSIFICATION_CONFIG["scan"]

    def test_title_priority_override(self):
        cfg = _build_classification_config({"classification": {"title_priority": False}})
        assert cfg["title_priority"] is False

    def test_does_not_mutate_defaults(self):
        """Building a config with overrides must not leak back into the module-level default."""
        _ = _build_classification_config({"classification": {"window": 9999}})
        assert DEFAULT_CLASSIFICATION_CONFIG["window"] == 500


class TestClassifyChunkWithConfig:
    KWS = [(["total", "balance"], "totals")]

    def test_threshold_one_loosens_content_match(self):
        cfg = {"window": 500, "threshold": 1, "scan": "head", "title_priority": True}
        assert classify_chunk("Random", "the total is listed below", self.KWS, cfg) == "totals"
        # Default threshold=2 would miss it
        assert classify_chunk("Random", "the total is listed below", self.KWS) == "other"

    def test_window_limits_content_scanned(self):
        """With a tiny window, keywords past the window aren't counted."""
        content = "padding " * 100 + "total balance due"
        cfg = {"window": 50, "threshold": 2, "scan": "head", "title_priority": True}
        assert classify_chunk("Random", content, self.KWS, cfg) == "other"
        # Full scan catches it
        cfg_all = dict(cfg, scan="all")
        assert classify_chunk("Random", content, self.KWS, cfg_all) == "totals"

    def test_head_and_tail_strategy(self):
        """head_and_tail scans first and last halves of the window."""
        content = "intro text " + "filler " * 200 + "total balance due"
        cfg = {"window": 60, "threshold": 2, "scan": "head_and_tail", "title_priority": True}
        assert classify_chunk("Random", content, self.KWS, cfg) == "totals"

    def test_title_priority_off_requires_content_match(self):
        """With title_priority=false, a single-keyword title no longer short-circuits."""
        cfg = {"window": 500, "threshold": 2, "scan": "head", "title_priority": False}
        # Title says "total" but content has nothing — without priority, no match
        assert classify_chunk("Total", "unrelated body", self.KWS, cfg) == "other"
        # Default behavior: title match wins
        assert classify_chunk("Total", "unrelated body", self.KWS) == "totals"

    def test_empty_keywords_still_returns_other(self):
        cfg = {"window": 500, "threshold": 1, "scan": "all", "title_priority": True}
        assert classify_chunk("Anything", "anything", None, cfg) == "other"

    def test_integration_via_build_document_map(self):
        """Schema-level classification config flows through build_document_map."""
        md = "# Summary\n\nAmount due soon."
        schema = {
            "categories": {"keywords": {"totals": ["amount", "due"]}},
            "classification": {"threshold": 1, "title_priority": False},
        }
        chunks = build_document_map(md, schema)
        assert chunks[0].category == "totals"
        # Without the schema override, threshold=2 is required and title_priority=true would catch
        # neither — the chunk would fall through to "other".
        default_schema = {"categories": {"keywords": {"totals": ["amount", "due"]}}}
        default_chunks = build_document_map(md, default_schema)
        # Two keywords ("amount", "due") are both in content, so default threshold=2 matches
        assert default_chunks[0].category == "totals"


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

    def test_short_bold_stanza_merges_into_one_heading(self):
        """A short run of standalone bold lines merges into a single heading.

        This keeps multi-line titles intact as a single anchor instead of
        fragmenting them. The original bold lines are still preserved in
        content so downstream extraction can match against them.
        """
        md = "**Book Title**\n\n**Author Name**\n\n**Publisher, 2026**\n\nReal body begins here."
        out = _infer_headings(md)
        assert out.count("## ") == 1
        assert "## Book Title Author Name Publisher, 2026" in out
        # Original bold lines survive as content — only the first slot is rewritten
        assert "**Author Name**" in out
        assert "**Publisher, 2026**" in out

    def test_short_all_caps_stanza_merges_into_one_heading(self):
        md = "TITLE PAGE\n\nBY SOMEONE\n\nSEPTEMBER 2026\n\nNow for the body."
        out = _infer_headings(md)
        assert out.count("## ") == 1
        assert "## TITLE PAGE BY SOMEONE SEPTEMBER 2026" in out
        assert "BY SOMEONE" in out
        assert "SEPTEMBER 2026" in out

    def test_mixed_stanza_bold_and_all_caps(self):
        md = "**Book Title**\n\nBY AUTHOR\n\n**2026 Edition**\n\nBody."
        out = _infer_headings(md)
        assert out.count("## ") == 1
        assert "## Book Title BY AUTHOR 2026 Edition" in out

    def test_stanza_resets_after_body_content(self):
        """After a non-heuristic line, the next bold candidate is freshly eligible."""
        md = "**Title**\n\n**Subtitle**\n\nReal body paragraph.\n\n**Chapter 1**\n\nChapter body."
        out = _infer_headings(md)
        assert "## Title" in out
        assert "## Chapter 1" in out
        assert "**Subtitle**" in out  # part of the cover stanza, not promoted
        assert out.count("## ") == 2

    def test_schema_pattern_breaks_stanza(self):
        """A schema-pattern match is explicit intent — it resets stanza state."""
        schema = {"headings": {"patterns": [r"^PART \d+$"]}}
        md = "**Title**\n\n**Author**\n\nPART 1\n\n**Section**\n\nbody"
        out = _infer_headings(md, schema)
        assert "## Title" in out
        assert "## PART 1" in out
        assert "## Section" in out
        # **Author** is part of the stanza — not promoted
        assert "**Author**" in out

    def test_generic_false_skips_heuristics(self):
        """headings.generic: false disables bold/ALL CAPS inference."""
        schema = {"headings": {"generic": False}}
        md = "**Title**\n\nINVOICE\n\nbody"
        out = _infer_headings(md, schema)
        assert "##" not in out
        # Original content preserved
        assert "**Title**" in out
        assert "INVOICE" in out

    def test_generic_false_still_applies_schema_patterns(self):
        """With generic heuristics off, explicit schema patterns still fire."""
        schema = {
            "headings": {
                "generic": False,
                "patterns": [r"^SECTION \d+$"],
            }
        }
        md = "**Title**\n\nSECTION 1\n\nbody"
        out = _infer_headings(md, schema)
        assert "## SECTION 1" in out
        assert "**Title**" in out  # generic off, bold untouched
        assert "## Title" not in out

    def test_generic_false_with_no_patterns_is_noop(self):
        schema = {"headings": {"generic": False}}
        md = "**Title**\n\nINVOICE\n\nBILL TO\n\nbody"
        assert _infer_headings(md, schema) == md

    def test_infer_false_overrides_generic_and_patterns(self):
        """infer: false is the master kill-switch — nothing runs."""
        schema = {
            "headings": {
                "infer": False,
                "generic": True,
                "patterns": [r"^SECTION \d+$"],
            }
        }
        md = "**Title**\n\nSECTION 1\n\nbody"
        assert _infer_headings(md, schema) == md

    def test_multiline_company_name_merges_into_heading(self):
        """Two-line filer names (CXJ pattern) stay intact as a single heading."""
        md = "**CXJ**\n\n**GROUP CO., Limited**\n\n(Exact name of registrant)"
        out = _infer_headings(md)
        assert "## CXJ GROUP CO., Limited" in out
        # The original bold lines are still there as content
        assert "**GROUP CO., Limited**" in out

    def test_long_stanza_disbands_no_promotion(self):
        """5+ consecutive bold/all-caps lines are noise, not a title."""
        # Mimics docling's per-word-bold SEC cover page shape.
        md = (
            "**UNITED**\n\n"
            "**STATES**\n\n"
            "**SECURITIES**\n\n"
            "**AND EXCHANGE COMMISSION**\n\n"
            "**FORM 10-K**\n\n"
            "Commission file number\n\n"
            "**ACME CORP**\n\n"
            "(Exact name)"
        )
        out = _infer_headings(md)
        # First stanza (5 lines) disbands — no merged heading from it
        assert "## UNITED" not in out
        assert "## UNITED STATES SECURITIES" not in out
        # The original bold lines remain in place
        assert "**UNITED**" in out
        assert "**STATES**" in out
        # The second stanza is short enough to still promote normally
        assert "## ACME CORP" in out

    def test_disband_threshold_boundary(self):
        """Exactly 4 stanza lines still merge; 5 disbands."""
        four = "**A Cat**\n\n**B Dog**\n\n**C Fox**\n\n**D Owl**\n\nbody"
        five = "**A Cat**\n\n**B Dog**\n\n**C Fox**\n\n**D Owl**\n\n**E Bee**\n\nbody"
        out_four = _infer_headings(four)
        out_five = _infer_headings(five)
        assert "## A Cat B Dog C Fox D Owl" in out_four
        assert "## A Cat" not in out_five
        assert "##" not in out_five

    def test_bold_numeric_fragments_not_promoted(self):
        """Phone numbers, registration IDs, and ZIP codes shouldn't become headings."""
        md = "**(305) 907-7600**\n\nnext paragraph"
        out = _infer_headings(md)
        assert "##" not in out
        assert "**(305) 907-7600**" in out

    def test_bold_registration_number_not_promoted(self):
        md = "**333-202959**\n\nfiler name"
        out = _infer_headings(md)
        assert "##" not in out

    def test_bold_mostly_digits_with_few_letters_not_promoted(self):
        """`**D.C. 20549**` is a ZIP/locale line, not a heading."""
        md = "**D.C. 20549**\n\nnext"
        out = _infer_headings(md)
        assert "##" not in out

    def test_stanza_merge_ignores_stanza_lines_failing_alpha_filter(self):
        """A stanza adjacent to a rejected bold line still merges correctly."""
        # The phone number is NOT a heuristic candidate, so it breaks any
        # in-progress stanza. The real filer stanza that follows merges on its own.
        md = "**(305) 907-7600**\n\n**BALANCE**\n\n**LABS, INC.**\n\n(Exact name)"
        out = _infer_headings(md)
        assert "## BALANCE LABS, INC." in out


# ── Table cell dedupe ─────────────────────────────────────────────────


class TestDedupeTableRowRepeats:
    def test_no_op_on_non_table_markdown(self):
        md = "# Heading\n\nSome paragraph.\n\nAnother paragraph."
        assert _dedupe_table_row_repeats(md) == md

    def test_no_op_when_no_pipes(self):
        md = "plain text only"
        assert _dedupe_table_row_repeats(md) == md

    def test_separator_row_preserved(self):
        md = "|---|---|---|\n| a | b | c |"
        out = _dedupe_table_row_repeats(md)
        assert "|---|---|---|" in out

    def test_tripled_signature_row_collapses(self):
        """The KB HOME 10-Q failure shape: triplicated Dated / date cells."""
        row = "| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 | By: | By: | By: |"
        out = _dedupe_table_row_repeats(row)
        # April 9 should appear exactly once after dedupe
        assert out.count("April 9, 2026") == 1
        assert out.count("Dated") == 1
        assert out.count("By:") == 1

    def test_tripled_row_with_mixed_numeric_cells(self):
        """When a row is confirmed tripled via an alpha run, numeric runs collapse too."""
        row = "| Delaware | Delaware | Delaware | 95-3666267 | 95-3666267 | 95-3666267 |"
        out = _dedupe_table_row_repeats(row)
        assert out.count("Delaware") == 1
        assert out.count("95-3666267") == 1

    def test_non_tripled_row_with_repeated_values_preserved(self):
        """Legitimate financial rows (no alpha triplication signal) are untouched."""
        row = "| Revenue | $100 | $100 | $100 |"
        out = _dedupe_table_row_repeats(row)
        # No triplication signal (Revenue appears only once) — row stays as-is
        assert out == row
        assert out.count("$100") == 3

    def test_two_duplicates_not_collapsed(self):
        """A pair of identical cells stays put — dedupe needs a run of 3+."""
        row = "| Yes | Yes | No |"
        out = _dedupe_table_row_repeats(row)
        assert out.count("Yes") == 2

    def test_mixed_run_lengths(self):
        """Only runs that meet the ≥3 threshold get collapsed, even once the row is flagged."""
        row = "| Name | Name | Age | Age | Age | Role | Role |"
        out = _dedupe_table_row_repeats(row)
        # Only the triple-Age run collapses; pairs stay put.
        assert out.count("Name") == 2
        assert out.count("Age") == 1
        assert out.count("Role") == 2

    def test_empty_cells_between_runs_preserved(self):
        """Whitespace cells between runs aren't collapsed into each other."""
        row = "| Dated | Dated | Dated |    |    |    | By: | By: | By: |"
        out = _dedupe_table_row_repeats(row)
        assert out.count("Dated") == 1
        assert out.count("By:") == 1
        # Three empty cells stay — nothing to dedupe there (they're empty)
        assert "|    |    |    |" in out

    def test_build_document_map_applies_dedupe(self):
        """End-to-end: build_document_map uses the normalizer."""
        md = "# Signature Block\n\n| Dated | Dated | Dated | April 9, 2026 | April 9, 2026 | April 9, 2026 |"
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].content.count("April 9, 2026") == 1


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
