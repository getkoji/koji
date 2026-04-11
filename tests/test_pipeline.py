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


# ── mapping field type ───────────────────────────────────────────────

MAPPING_SPEC = {
    "type": "mapping",
    "required": True,
    "description": "Type of policy",
    "mappings": {
        "BOP": ["Business Owners Policy", "Businessowners", "Bus. Owners", "BOP"],
        "GL": ["General Liability", "CGL", "Commercial General Liability"],
        "WC": ["Workers Compensation", "Workers Comp", "Work Comp"],
    },
}


class TestValidateFieldMapping:
    def test_exact_canonical_match(self):
        value, valid, issue = validate_field("t", "BOP", MAPPING_SPEC)
        assert value == "BOP"
        assert valid is True

    def test_alias_match(self):
        value, valid, issue = validate_field("t", "Business Owners Policy", MAPPING_SPEC)
        assert value == "BOP"
        assert valid is True

    def test_case_insensitive_alias(self):
        value, valid, issue = validate_field("t", "business owners policy", MAPPING_SPEC)
        assert value == "BOP"
        assert valid is True

    def test_case_insensitive_canonical(self):
        value, valid, issue = validate_field("t", "bop", MAPPING_SPEC)
        assert value == "BOP"
        assert valid is True

    def test_another_alias(self):
        value, valid, issue = validate_field("t", "CGL", MAPPING_SPEC)
        assert value == "GL"
        assert valid is True

    def test_fuzzy_substring_match(self):
        """A substring of an alias should still match."""
        value, valid, issue = validate_field("t", "Workers Comp Insurance", MAPPING_SPEC)
        assert value == "WC"
        assert valid is True

    def test_no_match(self):
        value, valid, issue = validate_field("t", "Cyber Liability", MAPPING_SPEC)
        assert valid is False
        assert "not in allowed mappings" in issue

    def test_no_match_returns_raw_value(self):
        value, valid, issue = validate_field("t", "Unknown Policy", MAPPING_SPEC)
        assert value == "Unknown Policy"
        assert valid is False


class TestBuildGroupPromptMapping:
    def test_mapping_aliases_in_prompt(self):
        group = {
            "fields": ["policy_type"],
            "field_specs": {
                "policy_type": {
                    "type": "mapping",
                    "description": "Type of policy",
                    "mappings": {
                        "BOP": ["Business Owners Policy", "Businessowners"],
                        "GL": ["General Liability", "CGL"],
                    },
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "pick from:" in prompt
        assert "BOP" in prompt
        assert "Business Owners Policy" in prompt
        assert "GL" in prompt
        assert "CGL" in prompt

    def test_mapping_canonical_only_when_no_other_aliases(self):
        """When canonical value is the only alias, show it without parens."""
        group = {
            "fields": ["status"],
            "field_specs": {
                "status": {
                    "type": "mapping",
                    "mappings": {
                        "ACTIVE": ["ACTIVE"],
                        "CANCELLED": ["Cancelled", "Void"],
                    },
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        # ACTIVE has no aliases other than itself, so no parens
        assert "ACTIVE," in prompt or "ACTIVE]" in prompt or "ACTIVE " in prompt
        assert "CANCELLED (Cancelled, Void)" in prompt


class TestIntelligentExtractMapping:
    async def test_mapping_normalization_end_to_end(self, monkeypatch):
        """Full pipeline with mapping type normalizes alias values to canonical."""
        schema = {
            "name": "test_mapping",
            "fields": {
                "policy_type": MAPPING_SPEC,
                "title": {"type": "string", "required": True},
            },
        }
        # LLM returns an alias value instead of canonical
        canned = json.dumps({"policy_type": "Business Owners Policy", "title": "Test"})
        provider = MockProvider(responses=[canned])

        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Declarations\n\nPolicy Type: Business Owners Policy\nTitle: Test",
            schema_def=schema,
            model="mock/test",
        )

        # mapping validation should normalize the alias to canonical
        assert result["extracted"]["policy_type"] == "BOP"


# ── Gap filling ─────────────────────────────────────────────────────


class TestGapFilling:
    async def test_missing_required_triggers_retry(self, monkeypatch):
        """A missing required field triggers a broadened retry that fills it."""
        schema = {
            "name": "test_gap",
            "fields": {
                "title": {"type": "string", "required": True},
                "author": {"type": "string", "required": True},
            },
        }
        # First call: returns title but not author
        # Second call (gap fill): returns author
        provider = MockProvider(
            responses=[
                json.dumps({"title": "My Doc", "author": None}),
                json.dumps({"author": "Jane Doe"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: My Doc\n\n# About\n\nAuthor: Jane Doe",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["author"] == "Jane Doe"
        assert "author" in result["gap_filled"]
        # At least 2 calls: initial extraction + gap fill
        assert len(provider.calls) >= 2

    async def test_found_required_no_retry(self, monkeypatch):
        """A required field that was found does NOT trigger a retry."""
        schema = {
            "name": "test_gap",
            "fields": {
                "title": {"type": "string", "required": True},
            },
        }
        provider = MockProvider(responses=[json.dumps({"title": "Found It"})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Found It",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["title"] == "Found It"
        assert result["gap_filled"] == []
        # Only the initial extraction call(s), no gap fill
        assert len(provider.calls) == 1

    async def test_optional_null_not_retried(self, monkeypatch):
        """Non-required fields that are null should NOT be retried."""
        schema = {
            "name": "test_gap",
            "fields": {
                "title": {"type": "string", "required": True},
                "subtitle": {"type": "string"},  # optional
            },
        }
        provider = MockProvider(responses=[json.dumps({"title": "Got It", "subtitle": None})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Got It",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["subtitle"] is None
        assert result["gap_filled"] == []
        # Only one call — no gap fill for optional fields
        assert len(provider.calls) == 1

    async def test_gap_filled_list_populated(self, monkeypatch):
        """The gap_filled metadata lists exactly the fields that were gap-filled."""
        schema = {
            "name": "test_gap",
            "fields": {
                "a": {"type": "string", "required": True},
                "b": {"type": "string", "required": True},
                "c": {"type": "string"},  # optional
            },
        }
        # First call: only 'a' found
        # Gap fills: 'b' found on retry
        provider = MockProvider(
            responses=[
                json.dumps({"a": "val_a", "b": None, "c": None}),
                json.dumps({"b": "val_b"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Sec1\n\nA: val_a\n\n# Sec2\n\nB: val_b",
            schema_def=schema,
            model="mock/test",
        )

        assert result["gap_filled"] == ["b"]
        assert result["extracted"]["b"] == "val_b"
        assert result["extracted"]["c"] is None

    async def test_retry_limit_one_attempt(self, monkeypatch):
        """Each missing field is retried only once. If still null, stays null."""
        schema = {
            "name": "test_gap",
            "fields": {
                "ghost": {"type": "string", "required": True},
            },
        }
        # First call: ghost missing. Gap fill: still null. No third attempt.
        provider = MockProvider(
            responses=[
                json.dumps({"ghost": None}),
                json.dumps({"ghost": None}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nNothing useful here.",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["ghost"] is None
        assert result["gap_filled"] == []
        # Exactly 2 calls: initial + one gap fill attempt
        assert len(provider.calls) == 2
