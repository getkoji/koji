"""Tests for services/extract/router.py — field routing, scoring, grouping."""

from __future__ import annotations

from services.extract.document_map import build_document_map
from services.extract.router import (
    FieldRoute,
    _score_chunk,
    group_routes,
    route_fields,
)
from tests.conftest import SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA, make_chunk

# ── _score_chunk: hint-based scoring ─────────────────────────────────


class TestScoreChunkHints:
    def test_look_in_category_match(self):
        chunk = make_chunk(category="declarations")
        spec = {"hints": {"look_in": ["declarations"]}}
        score = _score_chunk(chunk, "policy_number", spec)
        assert score >= 15.0

    def test_look_in_no_match(self):
        chunk = make_chunk(category="exclusions")
        spec = {"hints": {"look_in": ["declarations"]}}
        score = _score_chunk(chunk, "policy_number", spec)
        assert score == 0.0

    def test_pattern_match(self):
        chunk = make_chunk(content="Policy Number: BOP123456")
        spec = {"hints": {"patterns": ["policy.*number"]}}
        score = _score_chunk(chunk, "policy_number", spec)
        assert score >= 8.0

    def test_pattern_no_match(self):
        chunk = make_chunk(content="Nothing relevant here")
        spec = {"hints": {"patterns": ["policy.*number"]}}
        score = _score_chunk(chunk, "policy_number", spec)
        assert score == 0.0

    def test_signal_match(self):
        chunk = make_chunk(signals={"has_dollar_amounts": True})
        spec = {"hints": {"signals": ["has_dollar_amounts"]}}
        score = _score_chunk(chunk, "premium", spec)
        assert score >= 4.0

    def test_combined_hints(self):
        chunk = make_chunk(
            category="declarations",
            content="Policy Number: BOP123456",
            signals={"has_policy_numbers": True, "has_key_value_pairs": True},
        )
        spec = SAMPLE_SCHEMA["fields"]["policy_number"]
        score = _score_chunk(chunk, "policy_number", spec)
        # look_in(15) + pattern(8) + signals(4+4) = 31
        assert score >= 25.0

    def test_hints_present_but_no_match_returns_zero(self):
        chunk = make_chunk(category="other", content="unrelated stuff")
        spec = {"hints": {"look_in": ["declarations"], "patterns": ["policy.*number"]}}
        score = _score_chunk(chunk, "policy_number", spec)
        assert score == 0.0


# ── _score_chunk: generic inference (no hints) ───────────────────────


class TestScoreChunkGeneric:
    def test_date_type_infers_has_dates(self):
        chunk = make_chunk(signals={"has_dates": True})
        spec = {"type": "date"}  # no hints
        score = _score_chunk(chunk, "some_date", spec)
        assert score >= 2.0

    def test_number_type_infers_dollar_amounts(self):
        chunk = make_chunk(signals={"has_dollar_amounts": True})
        spec = {"type": "number"}
        score = _score_chunk(chunk, "some_amount", spec)
        assert score >= 2.0

    def test_array_type_infers_tables(self):
        chunk = make_chunk(signals={"has_tables": True})
        spec = {"type": "array"}
        score = _score_chunk(chunk, "items", spec)
        assert score >= 2.0

    def test_field_name_in_title(self):
        chunk = make_chunk(title="Policy Type")
        spec = {"type": "string"}
        score = _score_chunk(chunk, "policy_type", spec)
        assert score >= 6.0

    def test_field_name_in_content(self):
        chunk = make_chunk(content="The policy type is BOP")
        spec = {"type": "string"}
        score = _score_chunk(chunk, "policy_type", spec)
        assert score >= 3.0

    def test_individual_word_hits(self):
        chunk = make_chunk(title="Other", content="The premium amount is listed")
        spec = {"type": "number"}
        score = _score_chunk(chunk, "premium_amount", spec)
        # "premium" and "amount" both appear
        assert score >= 3.0

    def test_no_match_returns_zero(self):
        chunk = make_chunk(title="Exclusions", content="This does not apply")
        spec = {"type": "string"}
        score = _score_chunk(chunk, "xyz_field", spec)
        # "xyz" and "field" (len 3 but only "field" > 2 chars) — "field" not in content
        assert score == 0.0


# ── route_fields ──────────────────────────────────────────────────────


class TestRouteFields:
    def test_routes_all_fields(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        routed_names = {r.field_name for r in routes}
        schema_names = set(SAMPLE_SCHEMA["fields"].keys())
        assert routed_names == schema_names

    def test_policy_number_routed_to_declarations(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        pn_route = [r for r in routes if r.field_name == "policy_number"][0]
        categories = {c.category for c in pn_route.chunks}
        assert "declarations" in categories
        assert pn_route.source == "hint"

    def test_coverages_routed_to_schedule(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        cov_route = [r for r in routes if r.field_name == "coverages"][0]
        categories = {c.category for c in cov_route.chunks}
        assert "schedule_of_coverages" in categories

    def test_max_chunks_per_field(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN, SAMPLE_SCHEMA)
        routes = route_fields(SAMPLE_SCHEMA, chunks, max_chunks_per_field=2)
        for route in routes:
            assert len(route.chunks) <= 2

    def test_fallback_when_no_match(self):
        """Field with no hints and no matching signals falls back."""
        chunks = [make_chunk(index=0, title="Random", content="nothing", signals={})]
        schema = {
            "fields": {
                "xyz_unknown": {"type": "string"},
            }
        }
        routes = route_fields(schema, chunks)
        assert len(routes) == 1
        assert routes[0].source == "fallback"

    def test_broadened_when_signals_exist(self):
        """Field with no match broadens to chunks with signals."""
        chunks = [
            make_chunk(index=0, title="Random", content="nothing", signals={"has_tables": True}),
            make_chunk(index=1, title="Other", content="stuff", signals={}),
        ]
        schema = {
            "fields": {
                "xyz_unknown": {"type": "string"},
            }
        }
        routes = route_fields(schema, chunks)
        assert len(routes) == 1
        # No scoring match, but chunk 0 has signals → broadened
        assert routes[0].source == "broadened"
        assert routes[0].chunks[0].index == 0

    def test_empty_schema(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        routes = route_fields({"fields": {}}, chunks)
        assert routes == []


# ── group_routes ──────────────────────────────────────────────────────


class TestGroupRoutes:
    def test_fields_sharing_chunks_grouped(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        groups = group_routes(routes)

        # Fewer groups than fields since some share chunks
        total_fields = sum(len(g["fields"]) for g in groups)
        assert total_fields == len(SAMPLE_SCHEMA["fields"])
        assert len(groups) <= len(SAMPLE_SCHEMA["fields"])

    def test_group_has_field_specs(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        groups = group_routes(routes)

        for group in groups:
            assert "fields" in group
            assert "field_specs" in group
            assert "chunks" in group
            for field_name in group["fields"]:
                assert field_name in group["field_specs"]

    def test_all_fields_covered_once(self):
        chunks = build_document_map(SAMPLE_INSURANCE_MARKDOWN)
        routes = route_fields(SAMPLE_SCHEMA, chunks)
        groups = group_routes(routes)

        all_fields = []
        for group in groups:
            all_fields.extend(group["fields"])
        # Each field appears exactly once
        assert len(all_fields) == len(set(all_fields))

    def test_single_field_makes_single_group(self):
        chunk = make_chunk(index=0)
        route = FieldRoute(
            field_name="solo",
            field_spec={"type": "string"},
            chunks=[chunk],
            source="hint",
        )
        groups = group_routes([route])
        assert len(groups) == 1
        assert groups[0]["fields"] == ["solo"]

    def test_disjoint_chunks_separate_groups(self):
        c1 = make_chunk(index=0, title="A")
        c2 = make_chunk(index=1, title="B")
        routes = [
            FieldRoute(field_name="f1", field_spec={"type": "string"}, chunks=[c1], source="hint"),
            FieldRoute(field_name="f2", field_spec={"type": "string"}, chunks=[c2], source="hint"),
        ]
        groups = group_routes(routes)
        assert len(groups) == 2
