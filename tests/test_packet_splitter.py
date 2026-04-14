"""Tests for services/extract/packet_splitter.py — classifier + normalizer."""

from __future__ import annotations

import json

import pytest

from services.extract.document_map import Chunk
from services.extract.packet_splitter import (
    Section,
    _build_classifier_prompt,
    _coalesce_other_sections,
    _normalize_classifier_response,
    _parse_classifier_json,
    classify_chunks_to_sections,
)
from tests.conftest import MockProvider

# ── Section dataclass ────────────────────────────────────────────────


class TestSection:
    def test_start_and_end_chunk_derived(self):
        s = Section(type="invoice", title="t", chunk_indices=[3, 4, 5])
        assert s.start_chunk == 3
        assert s.end_chunk == 5

    def test_empty_indices_defaults_to_zero(self):
        s = Section(type="other", title="t")
        assert s.start_chunk == 0
        assert s.end_chunk == 0


# ── Prompt building ──────────────────────────────────────────────────


class TestBuildClassifierPrompt:
    def _chunks(self):
        return [
            Chunk(index=0, title="Header", content="INVOICE TO: Acme\nBILL TO: Beta"),
            Chunk(index=1, title="Totals", content="Total: $100\nTax: $10"),
        ]

    def test_includes_types_and_descriptions(self):
        prompt = _build_classifier_prompt(
            self._chunks(),
            [
                {"id": "invoice", "description": "Commercial invoice."},
                {"id": "policy", "description": "Insurance policy document."},
            ],
        )
        assert "invoice: Commercial invoice." in prompt
        assert "policy: Insurance policy document." in prompt
        # Reserved "other" type always appears
        assert "other:" in prompt

    def test_includes_chunk_content(self):
        prompt = _build_classifier_prompt(self._chunks(), [{"id": "invoice", "description": "Invoice"}])
        assert "[0] Header" in prompt
        assert "INVOICE TO: Acme" in prompt
        assert "[1] Totals" in prompt

    def test_skips_invalid_type_entries(self):
        prompt = _build_classifier_prompt(
            self._chunks(),
            [
                {"id": "invoice", "description": "Invoice"},
                "not a dict",
                {"description": "no id"},
                {"id": "", "description": "empty id"},
            ],
        )
        assert "invoice: Invoice" in prompt
        # Invalid entries don't contaminate the prompt
        assert "not a dict" not in prompt

    def test_empty_description_falls_back_to_id(self):
        prompt = _build_classifier_prompt(self._chunks(), [{"id": "report", "description": ""}])
        assert "report: report" in prompt


# ── JSON parsing ─────────────────────────────────────────────────────


class TestParseClassifierJson:
    def test_clean_json(self):
        raw = '{"sections": [{"type": "invoice", "start_chunk": 0, "end_chunk": 2}]}'
        parsed = _parse_classifier_json(raw)
        assert parsed is not None
        assert len(parsed["sections"]) == 1

    def test_json_with_surrounding_text(self):
        raw = 'Here is the JSON:\n{"sections": []}\nThanks.'
        parsed = _parse_classifier_json(raw)
        assert parsed == {"sections": []}

    def test_invalid_json_returns_none(self):
        assert _parse_classifier_json("not json at all") is None
        assert _parse_classifier_json("") is None
        assert _parse_classifier_json(None) is None  # type: ignore[arg-type]


# ── Normalizer — happy path ─────────────────────────────────────────


class TestNormalizeClassifierResponseHappy:
    def test_single_section_covering_all_chunks(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": 0.95},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 3, {"invoice"})
        assert corrections == 0
        assert len(sections) == 1
        assert sections[0].type == "invoice"
        assert sections[0].chunk_indices == [0, 1, 2]
        assert sections[0].confidence == 0.95

    def test_multiple_adjacent_sections(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9},
                {"type": "policy", "start_chunk": 3, "end_chunk": 7, "confidence": 0.92},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 8, {"invoice", "policy"})
        assert corrections == 0
        assert [s.type for s in sections] == ["invoice", "policy"]
        assert sections[0].chunk_indices == [0, 1, 2]
        assert sections[1].chunk_indices == [3, 4, 5, 6, 7]


# ── Normalizer — failure modes ──────────────────────────────────────


class TestNormalizerFailureModes:
    def test_none_response_falls_back(self):
        sections, corrections = _normalize_classifier_response(None, 5, {"invoice"})
        assert len(sections) == 1
        assert sections[0].type == "document"
        assert sections[0].chunk_indices == [0, 1, 2, 3, 4]
        assert corrections >= 1

    def test_non_dict_response_falls_back(self):
        sections, corrections = _normalize_classifier_response("not a dict", 3, set())  # type: ignore[arg-type]
        assert sections[0].type == "document"
        assert corrections >= 1

    def test_empty_sections_list_falls_back(self):
        sections, corrections = _normalize_classifier_response({"sections": []}, 3, {"invoice"})
        assert sections[0].type == "document"
        assert corrections >= 1

    def test_missing_sections_key_falls_back(self):
        sections, corrections = _normalize_classifier_response({"foo": "bar"}, 3, set())
        assert sections[0].type == "document"
        assert corrections >= 1

    def test_total_chunks_zero_returns_empty(self):
        sections, corrections = _normalize_classifier_response({"sections": []}, 0, set())
        assert sections == []
        assert corrections == 0

    def test_out_of_range_indices_dropped(self):
        """Section claiming chunks beyond the document → dropped, falls back."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 99, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 5, {"invoice"})
        assert sections[0].type == "document"  # fallback
        assert corrections >= 2  # drop + fallback

    def test_negative_indices_dropped(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": -1, "end_chunk": 2, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 5, {"invoice"})
        assert sections[0].type == "document"
        assert corrections >= 2

    def test_inverted_range_dropped(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 5, "end_chunk": 2, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 10, {"invoice"})
        assert sections[0].type == "document"
        assert corrections >= 2

    def test_missing_type_field_dropped(self):
        response = {
            "sections": [
                {"start_chunk": 0, "end_chunk": 2, "confidence": 0.9},  # no type
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 3, {"invoice"})
        assert len(sections) == 1
        assert sections[0].type == "invoice"
        assert corrections >= 1  # the type-less entry was dropped

    def test_missing_start_end_dropped(self):
        response = {
            "sections": [
                {"type": "invoice", "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 3, {"invoice"})
        assert sections[0].type == "document"

    def test_unknown_type_coerced_to_other(self):
        response = {
            "sections": [
                {"type": "widget", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 3, {"invoice"})
        assert len(sections) == 1
        assert sections[0].type == "other"
        assert corrections >= 1

    def test_reserved_other_type_always_valid(self):
        """The reserved `other` type ID is always valid even if not declared."""
        response = {
            "sections": [
                {"type": "other", "start_chunk": 0, "end_chunk": 2, "confidence": 0.5},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 3, set())
        assert len(sections) == 1
        assert sections[0].type == "other"
        assert corrections == 0  # no coercion needed

    def test_overlapping_sections_first_wins(self):
        """section A claims 0-5, section B claims 3-7 → B trimmed to 6-7."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 5, "confidence": 0.9},
                {"type": "policy", "start_chunk": 3, "end_chunk": 7, "confidence": 0.8},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 8, {"invoice", "policy"})
        assert len(sections) == 2
        assert sections[0].type == "invoice"
        assert sections[0].chunk_indices == [0, 1, 2, 3, 4, 5]
        assert sections[1].type == "policy"
        assert sections[1].chunk_indices == [6, 7]
        assert corrections >= 1

    def test_fully_consumed_overlap_dropped(self):
        """If section B is entirely inside A, B is dropped."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 9, "confidence": 0.9},
                {"type": "policy", "start_chunk": 3, "end_chunk": 5, "confidence": 0.8},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 10, {"invoice", "policy"})
        assert len(sections) == 1
        assert sections[0].type == "invoice"
        # One correction for detecting + dropping the consumed overlap.
        assert corrections >= 1

    def test_gap_filled_with_other_section(self):
        """Chunks 3-4 not claimed by any section → filled with an `other` section."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9},
                {"type": "policy", "start_chunk": 5, "end_chunk": 7, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 8, {"invoice", "policy"})
        assert len(sections) == 3
        assert sections[0].type == "invoice"
        assert sections[1].type == "other"
        assert sections[1].chunk_indices == [3, 4]
        assert sections[2].type == "policy"
        assert corrections >= 1

    def test_leading_gap_filled(self):
        """Classifier starts at chunk 2 → chunks 0-1 filled with `other`."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 2, "end_chunk": 4, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 5, {"invoice"})
        assert len(sections) == 2
        assert sections[0].type == "other"
        assert sections[0].chunk_indices == [0, 1]
        assert sections[1].type == "invoice"
        assert corrections >= 1

    def test_trailing_gap_filled(self):
        """Classifier ends at chunk 4 → chunks 5-9 filled with `other`."""
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 4, "confidence": 0.9},
            ]
        }
        sections, corrections = _normalize_classifier_response(response, 10, {"invoice"})
        assert len(sections) == 2
        assert sections[0].type == "invoice"
        assert sections[1].type == "other"
        assert sections[1].chunk_indices == [5, 6, 7, 8, 9]
        assert corrections >= 1

    def test_confidence_clamped(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": 2.5},
            ]
        }
        sections, _ = _normalize_classifier_response(response, 3, {"invoice"})
        assert sections[0].confidence == 1.0

    def test_invalid_confidence_becomes_zero(self):
        response = {
            "sections": [
                {"type": "invoice", "start_chunk": 0, "end_chunk": 2, "confidence": "high"},
            ]
        }
        sections, _ = _normalize_classifier_response(response, 3, {"invoice"})
        assert sections[0].confidence == 0.0


# ── End-to-end with mock provider ────────────────────────────────────


@pytest.mark.asyncio
class TestClassifyChunksToSections:
    async def test_happy_path(self, monkeypatch):
        chunks = [
            Chunk(index=0, title="Inv header", content="INVOICE"),
            Chunk(index=1, title="Inv items", content="Line items"),
            Chunk(index=2, title="COI header", content="CERT OF INSURANCE"),
        ]
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 1, "confidence": 0.92},
                            {"type": "coi", "start_chunk": 2, "end_chunk": 2, "confidence": 0.95},
                        ]
                    }
                )
            ]
        )
        types = [
            {"id": "invoice", "description": "Invoice"},
            {"id": "coi", "description": "Cert of insurance"},
        ]
        sections, meta = await classify_chunks_to_sections(chunks, provider, types)
        assert len(sections) == 2
        assert [s.type for s in sections] == ["invoice", "coi"]
        assert meta["total_sections"] == 2
        assert meta["normalizer_corrections"] == 0
        assert "error" not in meta

    async def test_empty_chunks(self, monkeypatch):
        provider = MockProvider(responses=[])
        sections, meta = await classify_chunks_to_sections([], provider, [])
        assert sections == []
        assert meta["total_sections"] == 0

    async def test_provider_exception_falls_back(self, monkeypatch):
        chunks = [
            Chunk(index=0, title="H", content="text"),
            Chunk(index=1, title="H2", content="more"),
            Chunk(index=2, title="H3", content="even more"),
        ]

        class FailingProvider:
            model = "mock"

            async def generate(self, prompt, json_mode=False):
                raise RuntimeError("network down")

        sections, meta = await classify_chunks_to_sections(chunks, FailingProvider(), [])
        assert len(sections) == 1
        assert sections[0].type == "document"  # fallback
        assert "error" in meta
        assert "network down" in meta["error"]

    async def test_invalid_json_response_falls_back(self, monkeypatch):
        chunks = [
            Chunk(index=0, title="H", content="text"),
            Chunk(index=1, title="H2", content="more"),
            Chunk(index=2, title="H3", content="even more"),
        ]
        provider = MockProvider(responses=["not json"])
        sections, meta = await classify_chunks_to_sections(chunks, provider, [])
        assert len(sections) == 1
        assert sections[0].type == "document"
        assert meta["normalizer_corrections"] >= 1

    async def test_short_doc_bypasses_classifier(self, monkeypatch):
        """Docs at or below short_doc_chunks skip the LLM entirely."""
        chunks = [
            Chunk(index=0, title="Cover", content="SEC FILING"),
            Chunk(index=1, title="Body", content="more"),
        ]

        class TrackingProvider:
            def __init__(self):
                self.calls = 0

            async def generate(self, prompt, json_mode=False):
                self.calls += 1
                return "{}"

        provider = TrackingProvider()
        types = [{"id": "sec_filing", "description": "SEC filing"}]
        sections, meta = await classify_chunks_to_sections(chunks, provider, types)
        assert provider.calls == 0
        assert len(sections) == 1
        assert sections[0].type == "document"
        assert sections[0].chunk_indices == [0, 1]
        assert meta["bypassed_short_doc"] is True
        assert meta["total_sections"] == 1
        assert meta["normalizer_corrections"] == 0

    async def test_short_doc_threshold_configurable(self, monkeypatch):
        """short_doc_chunks=0 disables the bypass and restores classifier path."""
        chunks = [Chunk(index=0, title="Solo", content="text")]
        provider = MockProvider(
            responses=[
                json.dumps({"sections": [{"type": "other", "start_chunk": 0, "end_chunk": 0, "confidence": 0.5}]})
            ]
        )
        sections, meta = await classify_chunks_to_sections(chunks, provider, [], short_doc_chunks=0)
        assert meta["bypassed_short_doc"] is False
        assert len(sections) == 1
        assert sections[0].type == "other"
        assert len(provider.calls) == 1

    async def test_short_doc_bypass_above_threshold_uses_classifier(self, monkeypatch):
        """A document of N+1 chunks when threshold=N still uses the classifier."""
        chunks = [Chunk(index=i, title=f"H{i}", content=f"t{i}") for i in range(3)]
        provider = MockProvider(
            responses=[json.dumps({"sections": [{"type": "x", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9}]})]
        )
        types = [{"id": "x", "description": "X type"}]
        sections, meta = await classify_chunks_to_sections(chunks, provider, types, short_doc_chunks=2)
        assert meta["bypassed_short_doc"] is False
        assert len(sections) == 1
        assert sections[0].type == "x"


# ── Coalesce-other post-step ─────────────────────────────────────────


class TestCoalesceOtherSections:
    """Unit tests for the post-classify coalesce that undoes LLM over-splitting.

    Motivation: when a classifier sprinkles `other` sections into a single
    logical document (common failure on multi-section SEC filings), the
    coalesce step merges everything into one dominant-type section so
    apply_to filtering doesn't silently drop half the extraction.
    """

    def test_dominant_type_with_other_coalesces(self):
        """4 sec_filing chunks + 2 other chunks → one sec_filing section."""
        sections = [
            Section(type="sec_filing", title="Cover", chunk_indices=[0, 1], confidence=0.9),
            Section(type="other", title="Signatures", chunk_indices=[2, 3], confidence=0.2),
            Section(type="sec_filing", title="Voting", chunk_indices=[4, 5], confidence=0.95),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=6, threshold=0.5)
        assert dominant == "sec_filing"
        assert len(new_sections) == 1
        assert new_sections[0].type == "sec_filing"
        assert new_sections[0].chunk_indices == [0, 1, 2, 3, 4, 5]
        # Confidence averaged over the two sec_filing sections
        assert new_sections[0].confidence == pytest.approx((0.9 + 0.95) / 2)

    def test_no_other_sections_no_coalesce(self):
        """If the classifier had no `other` sections, trust it — don't coalesce."""
        sections = [
            Section(type="invoice", title="Inv", chunk_indices=[0, 1], confidence=0.9),
            Section(type="policy", title="Pol", chunk_indices=[2, 3], confidence=0.9),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=4, threshold=0.5)
        assert dominant is None
        assert new_sections is sections

    def test_two_real_types_below_threshold_no_coalesce(self):
        """Genuine multi-type packet stays split — no single dominant type."""
        sections = [
            Section(type="invoice", title="Inv", chunk_indices=[0, 1], confidence=0.9),
            Section(type="policy", title="Pol", chunk_indices=[2, 3], confidence=0.9),
            Section(type="other", title="Misc", chunk_indices=[4], confidence=0.1),
        ]
        # invoice is 2/5 = 40%, below 0.5 threshold
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=5, threshold=0.5)
        assert dominant is None
        assert new_sections is sections

    def test_single_section_all_other_no_coalesce(self):
        """All `other` sections → nothing to promote to, no-op."""
        sections = [
            Section(type="other", title="Mystery", chunk_indices=[0, 1, 2], confidence=0.1),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=3, threshold=0.5)
        assert dominant is None
        assert new_sections is sections

    def test_threshold_disabled(self):
        sections = [
            Section(type="sec_filing", title="Cover", chunk_indices=[0, 1], confidence=0.9),
            Section(type="other", title="Other", chunk_indices=[2], confidence=0.2),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=3, threshold=0.0)
        assert dominant is None
        assert new_sections is sections

    def test_fallback_type_not_counted_as_dominant(self):
        """`document` fallback sections don't become a coalesce target."""
        sections = [
            Section(type="document", title="Whole", chunk_indices=[0, 1, 2], confidence=0.0),
            Section(type="other", title="Trailer", chunk_indices=[3], confidence=0.1),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=4, threshold=0.5)
        assert dominant is None
        assert new_sections is sections

    def test_above_threshold_with_higher_bar(self):
        """A strict threshold (0.8) still coalesces when dominant is overwhelming."""
        sections = [
            Section(type="sec_filing", title="Body", chunk_indices=list(range(9)), confidence=0.9),
            Section(type="other", title="Footer", chunk_indices=[9], confidence=0.1),
        ]
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=10, threshold=0.8)
        assert dominant == "sec_filing"
        assert len(new_sections) == 1
        assert new_sections[0].chunk_indices == list(range(10))

    def test_just_below_threshold_no_coalesce(self):
        """Threshold is inclusive-on-the-high-side: just under leaves sections alone."""
        sections = [
            Section(type="sec_filing", title="Body", chunk_indices=[0, 1, 2, 3], confidence=0.9),
            Section(type="other", title="Rest", chunk_indices=[4, 5, 6, 7, 8], confidence=0.1),
        ]
        # sec_filing is 4/9 ≈ 0.444, below 0.5
        new_sections, dominant = _coalesce_other_sections(sections, total_chunks=9, threshold=0.5)
        assert dominant is None

    async def test_classify_chunks_emits_coalesced_type_in_metadata(self, monkeypatch):
        """The end-to-end classifier call surfaces coalesced_type in metadata."""
        chunks = [Chunk(index=i, title=f"S{i}", content=f"c{i}") for i in range(6)]
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "sec_filing", "start_chunk": 0, "end_chunk": 1, "confidence": 0.9},
                            {"type": "other", "start_chunk": 2, "end_chunk": 3, "confidence": 0.2},
                            {"type": "sec_filing", "start_chunk": 4, "end_chunk": 5, "confidence": 0.95},
                        ]
                    }
                )
            ]
        )
        types = [{"id": "sec_filing", "description": "SEC filing"}]
        sections, meta = await classify_chunks_to_sections(chunks, provider, types)
        assert meta["coalesced_type"] == "sec_filing"
        assert len(sections) == 1
        assert sections[0].type == "sec_filing"

    async def test_classify_chunks_coalesce_disabled_via_threshold(self, monkeypatch):
        """Setting coalesce_other_threshold=0 preserves the split output."""
        chunks = [Chunk(index=i, title=f"S{i}", content=f"c{i}") for i in range(4)]
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "sec_filing", "start_chunk": 0, "end_chunk": 2, "confidence": 0.9},
                            {"type": "other", "start_chunk": 3, "end_chunk": 3, "confidence": 0.2},
                        ]
                    }
                )
            ]
        )
        types = [{"id": "sec_filing", "description": "SEC filing"}]
        sections, meta = await classify_chunks_to_sections(
            chunks,
            provider,
            types,
            coalesce_other_threshold=0.0,
        )
        assert meta["coalesced_type"] is None
        assert len(sections) == 2
