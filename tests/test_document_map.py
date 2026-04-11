"""Tests for services/extract/document_map.py — document mapping, classification, signal detection."""

from __future__ import annotations

from services.extract.document_map import (
    Chunk,
    build_document_map,
    classify_chunk,
    detect_signals,
    summarize_map,
)
from tests.conftest import SAMPLE_INSURANCE_MARKDOWN

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
        assert c.line_count == 1  # "".split("\n") == [""]
        assert c.char_count == 0


# ── classify_chunk ────────────────────────────────────────────────────


class TestClassifyChunk:
    def test_declarations_by_title(self):
        assert classify_chunk("Declarations Page", "Some content") == "declarations"

    def test_declarations_by_named_insured_in_title(self):
        assert classify_chunk("Named Insured Info", "blah") == "declarations"

    def test_endorsement_by_title(self):
        assert classify_chunk("Business Liability Endorsement", "modifies") == "endorsement"

    def test_conditions_by_title(self):
        assert classify_chunk("General Conditions", "stuff") == "conditions"

    def test_definitions_by_title(self):
        assert classify_chunk("Definitions", "As used in this policy") == "definitions"

    def test_exclusions_by_title(self):
        assert classify_chunk("Exclusions", "does not apply") == "exclusions"

    def test_schedule_by_title(self):
        assert classify_chunk("Schedule of Coverages", "table") == "schedule_of_coverages"

    def test_content_match_needs_two_keywords(self):
        # One keyword in content, not in title — not enough
        result = classify_chunk("Random Title", "this endorsement modifies something")
        # "endorsement" keyword appears, "this endorsement modifies" appears — that's 2 keywords
        assert result == "endorsement"

    def test_single_content_keyword_not_enough(self):
        # Only "amendment" appears, title doesn't match
        result = classify_chunk("Something Else", "this is an amendment to the form")
        # Only 1 keyword from endorsement group matches
        assert result == "other"

    def test_unknown_returns_other(self):
        assert classify_chunk("Random Section", "Nothing special here") == "other"

    def test_table_of_contents(self):
        assert classify_chunk("Table of Contents", "page 1, page 2") == "table_of_contents"


# ── detect_signals ────────────────────────────────────────────────────


class TestDetectSignals:
    def test_dollar_amounts(self):
        signals = detect_signals("Premium: $4,250.00 and deductible $1,000")
        assert signals["has_dollar_amounts"] is True
        assert signals["dollar_count"] == 2

    def test_dates(self):
        signals = detect_signals("Policy Period: 01/15/2025 to 01/15/2026")
        assert signals["has_dates"] is True
        assert signals["date_count"] == 2

    def test_iso_dates(self):
        signals = detect_signals("Effective: 2025-01-15")
        assert signals["has_dates"] is True

    def test_key_value_pairs(self):
        signals = detect_signals("Policy Number: BOP123\nInsured: Acme Corp")
        assert signals["has_key_value_pairs"] is True
        assert signals["kv_count"] == 2

    def test_tables(self):
        signals = detect_signals("| Coverage | Limit |\n|---|---|\n| Building | $500,000 |")
        assert signals["has_tables"] is True
        assert signals["table_row_count"] == 3

    def test_policy_numbers(self):
        signals = detect_signals("Policy Number: BOP7284930")
        assert signals["has_policy_numbers"] is True

    def test_name_references(self):
        signals = detect_signals("Named Insured: Acme Widget Corporation")
        assert signals["has_name_references"] is True

    def test_no_signals(self):
        signals = detect_signals("Just plain text with nothing special.")
        assert signals == {}

    def test_multiple_signals(self):
        signals = detect_signals("Named Insured: Acme Corp\nPolicy Number: BOP12345\nPremium: $1,000\nDate: 01/01/2025")
        assert signals["has_dollar_amounts"] is True
        assert signals["has_dates"] is True
        assert signals["has_key_value_pairs"] is True
        assert signals["has_policy_numbers"] is True
        assert signals["has_name_references"] is True


# ── build_document_map ────────────────────────────────────────────────


class TestBuildDocumentMap:
    def test_sample_insurance_markdown(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        assert len(chunks) == 6
        titles = [c.title for c in chunks]
        assert "Declarations Page" in titles
        assert "Schedule of Coverages" in titles
        assert "Business Liability Endorsement" in titles

    def test_chunk_indices_sequential(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        for i, chunk in enumerate(chunks):
            assert chunk.index == i

    def test_declarations_classified(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        dec = [c for c in chunks if c.title == "Declarations Page"][0]
        assert dec.category == "declarations"

    def test_declarations_signals(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        dec = [c for c in chunks if c.title == "Declarations Page"][0]
        assert dec.signals.get("has_dollar_amounts") is True
        assert dec.signals.get("has_dates") is True
        assert dec.signals.get("has_policy_numbers") is True

    def test_schedule_has_tables(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        sched = [c for c in chunks if c.title == "Schedule of Coverages"][0]
        assert sched.signals.get("has_tables") is True
        assert sched.category == "schedule_of_coverages"

    def test_empty_markdown(self):
        chunks = build_document_map("")
        assert chunks == []

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
        # Header 1 has no content so should be skipped
        assert len(chunks) == 1
        assert chunks[0].title == "Header 2"

    def test_whitespace_only_content_skipped(self):
        md = "# Section A\n\n   \n\n# Section B\n\nReal content"
        chunks = build_document_map(md)
        assert len(chunks) == 1
        assert chunks[0].title == "Section B"


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
