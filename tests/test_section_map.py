"""Tests for services/extract/section_map.py — two-pass section mapping."""

from __future__ import annotations

import json

import pytest

from services.extract.document_map import Chunk
from services.extract.router import _score_chunk
from services.extract.section_map import (
    SectionMap,
    SectionMapEntry,
    _build_outline_prompt,
    apply_section_labels,
    build_section_map,
    parse_section_map,
)

# ── Fixtures ──────────────────────────────────────────────────────────


def _make_chunks(n: int) -> list[Chunk]:
    """Build N dummy chunks."""
    return [
        Chunk(
            index=i,
            title=f"Section {i}",
            content=f"Content of section {i}. " * 20,
        )
        for i in range(n)
    ]


# ── parse_section_map tests ──────────────────────────────────────────


class TestParseSectionMap:
    def test_valid_json(self):
        raw = json.dumps(
            [
                {"label": "header", "chunks": [0, 1], "description": "Document header"},
                {"label": "body", "chunks": [2, 3, 4], "description": "Main body"},
                {"label": "footer", "chunks": [5], "description": "Footer"},
            ]
        )
        result = parse_section_map(raw, 6)
        assert len(result.sections) == 3
        assert result.sections[0].label == "header"
        assert result.sections[0].chunk_indices == [0, 1]
        assert result.sections[1].chunk_indices == [2, 3, 4]

    def test_strips_markdown_fences(self):
        raw = "```json\n" + json.dumps([{"label": "all", "chunks": [0, 1]}]) + "\n```"
        result = parse_section_map(raw, 2)
        assert len(result.sections) == 1

    def test_deduplicates_indices(self):
        raw = json.dumps(
            [
                {"label": "a", "chunks": [0, 1]},
                {"label": "b", "chunks": [1, 2]},  # index 1 already claimed by "a"
            ]
        )
        result = parse_section_map(raw, 3)
        assert result.label_for_chunk(1) == "a"  # first claim wins

    def test_out_of_range_indices_filtered(self):
        raw = json.dumps(
            [
                {"label": "a", "chunks": [-1, 0, 1, 99]},
            ]
        )
        result = parse_section_map(raw, 3)
        assert result.sections[0].chunk_indices == [0, 1]

    def test_unmapped_chunks_get_other(self):
        raw = json.dumps(
            [
                {"label": "header", "chunks": [0]},
            ]
        )
        result = parse_section_map(raw, 3)
        # Chunks 1, 2 should be in "other"
        assert result.label_for_chunk(1) == "other"
        assert result.label_for_chunk(2) == "other"

    def test_invalid_json_returns_empty(self):
        result = parse_section_map("not json at all", 5)
        assert len(result.sections) == 0

    def test_non_array_returns_empty(self):
        result = parse_section_map('{"not": "an array"}', 5)
        assert len(result.sections) == 0

    def test_label_normalized_to_snake_case(self):
        raw = json.dumps(
            [
                {"label": "Line Items", "chunks": [0]},
            ]
        )
        result = parse_section_map(raw, 1)
        assert result.sections[0].label == "line_items"


# ── SectionMap methods ───────────────────────────────────────────────


class TestSectionMap:
    def test_label_for_chunk(self):
        sm = SectionMap(
            sections=[
                SectionMapEntry(label="header", chunk_indices=[0, 1]),
                SectionMapEntry(label="body", chunk_indices=[2, 3]),
            ]
        )
        assert sm.label_for_chunk(0) == "header"
        assert sm.label_for_chunk(2) == "body"
        assert sm.label_for_chunk(99) is None

    def test_chunks_for_label(self):
        sm = SectionMap(
            sections=[
                SectionMapEntry(label="header", chunk_indices=[0, 1]),
                SectionMapEntry(label="body", chunk_indices=[2, 3]),
            ]
        )
        assert sm.chunks_for_label("header") == [0, 1]
        assert sm.chunks_for_label("nonexistent") == []

    def test_chunks_for_label_case_insensitive(self):
        sm = SectionMap(
            sections=[
                SectionMapEntry(label="header", chunk_indices=[0]),
            ]
        )
        assert sm.chunks_for_label("Header") == [0]


# ── apply_section_labels ──────────────────────────────────────────────


class TestApplySectionLabels:
    def test_labels_applied_to_chunk_signals(self):
        chunks = _make_chunks(3)
        sm = SectionMap(
            sections=[
                SectionMapEntry(label="header", chunk_indices=[0]),
                SectionMapEntry(label="body", chunk_indices=[1, 2]),
            ]
        )
        apply_section_labels(chunks, sm)
        assert chunks[0].signals["section_label"] == "header"
        assert chunks[1].signals["section_label"] == "body"
        assert chunks[2].signals["section_label"] == "body"


# ── build_section_map ────────────────────────────────────────────────


class MockProvider:
    def __init__(self, response: str):
        self._response = response

    async def generate(self, prompt: str, json_mode: bool = False) -> str:
        return self._response


class TestBuildSectionMap:
    @pytest.mark.asyncio
    async def test_skips_small_documents(self):
        chunks = _make_chunks(5)
        schema = {"fields": {"name": {"type": "string"}}}
        provider = MockProvider("[]")
        result = await build_section_map(chunks, schema, provider)
        assert result is None  # 5 < 10 threshold

    @pytest.mark.asyncio
    async def test_runs_for_large_documents(self):
        chunks = _make_chunks(15)
        schema = {"fields": {"name": {"type": "string"}}}
        response = json.dumps(
            [
                {"label": "header", "chunks": list(range(3)), "description": "Header"},
                {"label": "body", "chunks": list(range(3, 12)), "description": "Body"},
                {"label": "footer", "chunks": list(range(12, 15)), "description": "Footer"},
            ]
        )
        provider = MockProvider(response)
        result = await build_section_map(chunks, schema, provider)
        assert result is not None
        assert len(result.sections) == 3

    @pytest.mark.asyncio
    async def test_opt_out_via_schema(self):
        chunks = _make_chunks(15)
        schema = {"fields": {"name": {"type": "string"}}, "section_map": False}
        provider = MockProvider("[]")
        result = await build_section_map(chunks, schema, provider)
        assert result is None

    @pytest.mark.asyncio
    async def test_custom_threshold(self):
        chunks = _make_chunks(8)
        schema = {"fields": {"name": {"type": "string"}}, "section_map": {"threshold": 5}}
        response = json.dumps(
            [
                {"label": "all", "chunks": list(range(8)), "description": "Everything"},
            ]
        )
        provider = MockProvider(response)
        result = await build_section_map(chunks, schema, provider)
        assert result is not None

    @pytest.mark.asyncio
    async def test_llm_failure_returns_none(self):
        chunks = _make_chunks(15)
        schema = {"fields": {"name": {"type": "string"}}}

        class FailProvider:
            async def generate(self, prompt, json_mode=False):
                raise RuntimeError("LLM failed")

        result = await build_section_map(chunks, schema, FailProvider())
        assert result is None


# ── _build_outline_prompt ─────────────────────────────────────────────


class TestBuildOutlinePrompt:
    def test_includes_chunk_titles(self):
        chunks = _make_chunks(3)
        schema = {"name": "invoice", "fields": {"total": {"type": "number"}}}
        prompt = _build_outline_prompt(chunks, schema)
        assert "Section 0" in prompt
        assert "Section 1" in prompt
        assert "invoice" in prompt
        assert "total" in prompt

    def test_truncates_preview(self):
        chunks = [Chunk(index=0, title="Long", content="x" * 500)]
        schema = {"name": "test", "fields": {}}
        prompt = _build_outline_prompt(chunks, schema)
        assert "..." in prompt


# ── Router integration: section_label scoring ─────────────────────────


class TestSectionLabelRouterScoring:
    def test_section_label_boosts_matching_look_in(self):
        chunk_with_label = Chunk(
            index=0,
            title="Page 1",
            content="Some content",
            signals={"section_label": "header"},
        )
        chunk_without_label = Chunk(
            index=1,
            title="Page 2",
            content="Some content",
            signals={},
        )
        field_spec = {"type": "string", "hints": {"look_in": ["header"]}}

        score_with = _score_chunk(chunk_with_label, "company_name", field_spec, 5)
        score_without = _score_chunk(chunk_without_label, "company_name", field_spec, 5)
        assert score_with > score_without

    def test_section_label_boosts_field_name_match(self):
        chunk = Chunk(
            index=0,
            title="Page 1",
            content="Some content",
            signals={"section_label": "payment_terms"},
        )
        # Field name "payment_due_date" shares "payment" with label
        score = _score_chunk(chunk, "payment_due_date", {"type": "date"}, 5)
        assert score > 0

    def test_no_section_label_no_crash(self):
        chunk = Chunk(index=0, title="Title", content="Content", signals={})
        score = _score_chunk(chunk, "some_field", {"type": "string"}, 1)
        # Should still work without section labels
        assert isinstance(score, float)
