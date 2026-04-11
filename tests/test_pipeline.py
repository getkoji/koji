"""Tests for services/extract/pipeline.py — prompts, validation, reconciliation, end-to-end."""

from __future__ import annotations

import json

from services.extract.pipeline import (
    build_group_prompt,
    intelligent_extract,
    reconcile,
    validate_field,
)
from tests.conftest import (
    MINIMAL_SCHEMA,
    SAMPLE_INSURANCE_MARKDOWN,
    SAMPLE_SCHEMA,
    MockProvider,
    make_chunk,
)

# ── build_group_prompt ────────────────────────────────────────────────


class TestBuildGroupPrompt:
    def test_contains_field_names(self):
        group = {
            "fields": ["policy_number", "insured_name"],
            "field_specs": {
                "policy_number": {"type": "string", "required": True, "description": "Policy number"},
                "insured_name": {"type": "string", "required": True, "description": "Named insured"},
            },
            "chunks": [make_chunk(title="Declarations", content="Policy Number: BOP123")],
        }
        prompt = build_group_prompt(group, "insurance_policy")
        assert "policy_number" in prompt
        assert "insured_name" in prompt

    def test_contains_chunk_content(self):
        group = {
            "fields": ["policy_number"],
            "field_specs": {"policy_number": {"type": "string"}},
            "chunks": [make_chunk(title="Dec Page", content="Policy Number: BOP7284930")],
        }
        prompt = build_group_prompt(group, "test")
        assert "BOP7284930" in prompt
        assert "Dec Page" in prompt

    def test_required_label(self):
        group = {
            "fields": ["name"],
            "field_specs": {"name": {"type": "string", "required": True}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "(REQUIRED)" in prompt

    def test_optional_field_no_required_label(self):
        group = {
            "fields": ["name"],
            "field_specs": {"name": {"type": "string"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "(REQUIRED)" not in prompt

    def test_enum_options_in_prompt(self):
        group = {
            "fields": ["policy_type"],
            "field_specs": {
                "policy_type": {
                    "type": "enum",
                    "options": ["BOP", "General Liability", "Workers Compensation"],
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "pick from:" in prompt
        assert "BOP" in prompt
        assert "General Liability" in prompt

    def test_multiple_chunks_separated(self):
        group = {
            "fields": ["f"],
            "field_specs": {"f": {"type": "string"}},
            "chunks": [
                make_chunk(title="Section A", content="content A"),
                make_chunk(title="Section B", content="content B"),
            ],
        }
        prompt = build_group_prompt(group, "test")
        assert "Section A" in prompt
        assert "Section B" in prompt
        assert "---" in prompt

    def test_schema_name_in_prompt(self):
        group = {
            "fields": ["f"],
            "field_specs": {"f": {"type": "string"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "my_schema")
        assert "my_schema" in prompt


# ── validate_field ────────────────────────────────────────────────────


class TestValidateField:
    def test_null_required_field(self):
        value, valid, issue = validate_field("name", None, {"type": "string", "required": True})
        assert value is None
        assert valid is False
        assert "required" in issue

    def test_null_optional_field(self):
        value, valid, issue = validate_field("name", None, {"type": "string"})
        assert value is None
        assert valid is True
        assert issue is None

    def test_date_normalization(self):
        value, valid, issue = validate_field("d", "2025-1-5", {"type": "date"})
        assert value == "2025-01-05"
        assert valid is True

    def test_date_already_normalized(self):
        value, valid, issue = validate_field("d", "2025-01-15", {"type": "date"})
        assert value == "2025-01-15"
        assert valid is True

    def test_date_invalid(self):
        value, valid, issue = validate_field("d", "not a date", {"type": "date"})
        assert valid is False
        assert "could not parse date" in issue

    def test_number_from_string(self):
        value, valid, issue = validate_field("amt", "$4,250.00", {"type": "number"})
        assert value == 4250.0
        assert valid is True

    def test_number_integer_returned_as_int(self):
        value, valid, issue = validate_field("amt", "$1,000", {"type": "number"})
        assert value == 1000
        assert isinstance(value, int)

    def test_number_already_numeric(self):
        value, valid, issue = validate_field("amt", 42, {"type": "number"})
        assert value == 42
        assert valid is True

    def test_number_invalid_string(self):
        value, valid, issue = validate_field("amt", "N/A", {"type": "number"})
        assert valid is False
        assert "could not parse number" in issue

    def test_enum_exact_match(self):
        value, valid, issue = validate_field("t", "BOP", {"type": "enum", "options": ["BOP", "GL"]})
        assert value == "BOP"
        assert valid is True

    def test_enum_fuzzy_match_case(self):
        value, valid, issue = validate_field("t", "bop", {"type": "enum", "options": ["BOP", "GL"]})
        assert value == "BOP"
        assert valid is True

    def test_enum_fuzzy_match_partial(self):
        value, valid, issue = validate_field(
            "t",
            "Business Owners Policy",
            {"type": "enum", "options": ["BOP", "General Liability"]},
        )
        # "bop" not in "business owners policy" and vice versa — no fuzzy match
        assert valid is False

    def test_enum_no_match(self):
        value, valid, issue = validate_field("t", "Unknown", {"type": "enum", "options": ["BOP", "GL"]})
        assert valid is False
        assert "not in allowed options" in issue

    def test_string_passthrough(self):
        value, valid, issue = validate_field("s", "hello", {"type": "string"})
        assert value == "hello"
        assert valid is True


# ── reconcile ─────────────────────────────────────────────────────────


class TestReconcile:
    def test_single_result(self):
        results = [{"policy_number": "BOP123", "insured_name": "Acme"}]
        schema = {
            "fields": {
                "policy_number": {"type": "string"},
                "insured_name": {"type": "string"},
            }
        }
        out = reconcile(results, schema)
        assert out["extracted"]["policy_number"] == "BOP123"
        assert out["extracted"]["insured_name"] == "Acme"

    def test_missing_field_is_none(self):
        results = [{"policy_number": "BOP123"}]
        schema = {
            "fields": {
                "policy_number": {"type": "string"},
                "missing_field": {"type": "string"},
            }
        }
        out = reconcile(results, schema)
        assert out["extracted"]["missing_field"] is None
        assert out["confidence"]["missing_field"] == "not_found"

    def test_multiple_agreeing_results_high_confidence(self):
        results = [
            {"policy_number": "BOP123"},
            {"policy_number": "BOP123"},
        ]
        schema = {"fields": {"policy_number": {"type": "string"}}}
        out = reconcile(results, schema)
        assert out["extracted"]["policy_number"] == "BOP123"
        assert out["confidence"]["policy_number"] == "high"

    def test_array_deduplication(self):
        results = [
            {"items": [{"name": "A"}, {"name": "B"}]},
            {"items": [{"name": "B"}, {"name": "C"}]},
        ]
        schema = {"fields": {"items": {"type": "array"}}}
        out = reconcile(results, schema)
        items = out["extracted"]["items"]
        names = [i["name"] for i in items]
        assert names == ["A", "B", "C"]

    def test_array_from_multiple_sources_high_confidence(self):
        results = [
            {"items": [1, 2]},
            {"items": [3]},
        ]
        schema = {"fields": {"items": {"type": "array"}}}
        out = reconcile(results, schema)
        assert out["confidence"]["items"] == "high"

    def test_single_array_source_medium_confidence(self):
        results = [{"items": [1, 2]}]
        schema = {"fields": {"items": {"type": "array"}}}
        out = reconcile(results, schema)
        assert out["confidence"]["items"] == "medium"

    def test_validation_applied_during_reconcile(self):
        results = [{"premium": "$4,250.00"}]
        schema = {"fields": {"premium": {"type": "number"}}}
        out = reconcile(results, schema)
        assert out["extracted"]["premium"] == 4250.0

    def test_empty_results(self):
        results = [{}]
        schema = {"fields": {"f": {"type": "string"}}}
        out = reconcile(results, schema)
        assert out["extracted"]["f"] is None
        assert out["confidence"]["f"] == "not_found"


# ── intelligent_extract (end-to-end with MockProvider) ────────────────


class TestIntelligentExtract:
    async def test_end_to_end_minimal(self, monkeypatch):
        """Full pipeline with MockProvider returns expected structure."""
        canned = json.dumps({"title": "Test Doc", "amount": 42})
        provider = MockProvider(responses=[canned])

        # Monkeypatch create_provider to return our mock
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Test Doc\nAmount: $42",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        assert "extracted" in result
        assert "confidence" in result
        assert "chunks_total" in result
        assert "extraction_groups" in result
        assert "elapsed_ms" in result
        assert result["extracted"]["title"] == "Test Doc"
        assert result["extracted"]["amount"] == 42

    async def test_end_to_end_insurance(self, monkeypatch):
        """Full pipeline with insurance markdown and schema."""
        canned_dec = json.dumps(
            {
                "policy_number": "BOP7284930",
                "insured_name": "Acme Widget Corporation",
                "effective_date": "2025-01-15",
                "expiration_date": "2026-01-15",
                "premium": 4250.00,
                "policy_type": "BOP",
            }
        )
        canned_cov = json.dumps(
            {
                "coverages": [
                    {"coverage_name": "Building", "limit": "$500,000", "deductible": "$1,000"},
                    {"coverage_name": "General Liability", "limit": "$1,000,000", "deductible": "N/A"},
                ]
            }
        )
        # Provide enough responses for all extraction groups
        provider = MockProvider(responses=[canned_dec, canned_cov, canned_dec, canned_cov])

        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown=SAMPLE_INSURANCE_MARKDOWN,
            schema_def=SAMPLE_SCHEMA,
            model="mock/test",
        )

        assert result["extracted"]["policy_number"] == "BOP7284930"
        assert result["chunks_total"] == 6
        assert result["extraction_groups"] >= 1
        assert len(provider.calls) >= 1

    async def test_provider_called_with_json_mode(self, monkeypatch):
        """Verify the provider is called with json_mode=True."""
        provider = MockProvider(responses=['{"title": "X"}'])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        await intelligent_extract(
            markdown="# Test\n\nContent",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        assert len(provider.calls) >= 1
        assert provider.calls[0]["json_mode"] is True

    async def test_handles_invalid_json_from_provider(self, monkeypatch):
        """Pipeline handles provider returning invalid JSON gracefully."""
        provider = MockProvider(responses=["not valid json at all"])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Test\n\nContent",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        # Should still return a result structure, fields just won't be found
        assert "extracted" in result
        assert "confidence" in result
