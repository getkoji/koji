"""Tests for services/extract/pipeline.py — prompts, validation, reconciliation, end-to-end."""

from __future__ import annotations

import json

import pytest

from services.extract.pipeline import (
    _resolve_conditional_hints,
    _score_label,
    _toposort_fields,
    _unwrap_nested_result,
    build_gap_fill_prompt,
    build_group_prompt,
    compute_confidence_score,
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
    make_field_route,
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
        """Schema name must still appear in the prompt so the LLM can
        see it in the negative example in the instructions — but it
        must NOT sit in a header where the model might interpret it as
        "wrap output under this key". See oss-60."""
        group = {
            "fields": ["f"],
            "field_specs": {"f": {"type": "string"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "my_schema")
        assert "my_schema" in prompt
        # Must not appear in the "Fields to extract" section header — the
        # header that previously caused gpt-4o-mini to wrap output under
        # the schema name on single-field groups.
        assert "## Fields to extract (my_schema)" not in prompt
        assert "## Fields to extract\n" in prompt

    def test_instructs_flat_output_shape(self):
        """Prompt must explicitly tell the model not to wrap extracted
        fields under a schema name. See oss-60 — the repro was gpt-4o-mini
        returning {"filing_metadata": {"filing_date": ...}} for a
        single-field group because the section header mentioned the
        schema name and the instructions didn't forbid wrapping."""
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "filing_metadata")
        assert "FLAT JSON object" in prompt
        assert "do NOT nest" in prompt

    def test_array_of_objects_includes_property_names(self):
        """Array fields with nested object properties must tell the LLM the shape.

        Without this, the LLM guesses at field names and silently drops
        fields it thinks are redundant (e.g., dropping `amount` because it
        could be derived from `quantity * unit_price`).
        """
        group = {
            "fields": ["items"],
            "field_specs": {
                "items": {
                    "type": "array",
                    "description": "Line items",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "quantity": {"type": "number"},
                            "unit_price": {"type": "number"},
                            "amount": {"type": "number"},
                        },
                    },
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "invoice")
        # Every property name must appear in the prompt
        assert "name" in prompt
        assert "quantity" in prompt
        assert "unit_price" in prompt
        assert "amount" in prompt
        # And the shape hint should be there
        assert "array of objects" in prompt or "properties" in prompt

    def test_array_of_primitives_describes_element_type(self):
        group = {
            "fields": ["tags"],
            "field_specs": {
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "array of string" in prompt

    def test_nested_array_of_objects_renders_recursively(self):
        """oss-65: a top-level `policies` array whose items have a `limits`
        sub-array of `{name, amount}` objects must render the inner shape
        too. Pre-fix the inner array was rendered as the bare token
        `array`, the LLM had no shape to extract into and returned `[]`,
        and the COI bench dropped from 100% to 83.3%."""
        group = {
            "fields": ["policies"],
            "field_specs": {
                "policies": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "policy_number": {"type": "string"},
                            "limits": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "amount": {"type": "number"},
                                    },
                                },
                            },
                            "additional_insureds": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                        },
                    },
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "coi")
        # Outer array is described
        assert "policies: array of objects" in prompt
        # Inner limits array carries its own object shape
        assert "limits: array of objects with properties {name: string, amount: number}" in prompt
        # Inner primitive array is rendered as `array of string`, not bare `array`
        assert "additional_insureds: array of string" in prompt

    def test_array_of_arrays_renders(self):
        """Defensive: array-of-arrays (matrix-like) must not crash and
        should describe the inner element type."""
        group = {
            "fields": ["matrix"],
            "field_specs": {
                "matrix": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"type": "number"},
                    },
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "matrix: array of arrays of number" in prompt

    def test_array_without_item_spec_still_works(self):
        group = {
            "fields": ["items"],
            "field_specs": {"items": {"type": "array"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        # Should still render something — we don't know the shape
        assert "items" in prompt
        assert "array" in prompt

    def test_extraction_hint_rendered_in_notes_section(self):
        """Field with extraction_hint gets an 'Extraction notes' section in the prompt."""
        group = {
            "fields": ["filing_date"],
            "field_specs": {
                "filing_date": {
                    "type": "date",
                    "required": True,
                    "description": "Date the filing was submitted",
                    "extraction_hint": "Use the date in the signature block at the bottom. "
                    "For amendment forms, do not use the original filing date.",
                }
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "## Extraction notes" in prompt
        assert "**filing_date**" in prompt
        assert "signature block" in prompt
        assert "amendment forms" in prompt

    def test_multiple_extraction_hints_appear_in_order(self):
        group = {
            "fields": ["filing_date", "period_of_report"],
            "field_specs": {
                "filing_date": {"type": "date", "extraction_hint": "HINT_FILING_DATE"},
                "period_of_report": {"type": "date", "extraction_hint": "HINT_PERIOD_OF_REPORT"},
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "HINT_FILING_DATE" in prompt
        assert "HINT_PERIOD_OF_REPORT" in prompt
        assert prompt.index("HINT_FILING_DATE") < prompt.index("HINT_PERIOD_OF_REPORT")

    def test_no_extraction_notes_section_when_no_hints(self):
        """Schemas without any extraction_hint shouldn't get an empty Notes section."""
        group = {
            "fields": ["name"],
            "field_specs": {"name": {"type": "string"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "Extraction notes" not in prompt

    def test_extraction_hint_non_string_ignored(self):
        group = {
            "fields": ["x", "y", "z"],
            "field_specs": {
                "x": {"type": "string", "extraction_hint": None},
                "y": {"type": "string", "extraction_hint": 42},
                "z": {"type": "string", "extraction_hint": "   "},  # whitespace only
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "Extraction notes" not in prompt

    def test_extraction_hint_mix_of_hinted_and_unhinted_fields(self):
        group = {
            "fields": ["a", "b"],
            "field_specs": {
                "a": {"type": "string"},
                "b": {"type": "string", "extraction_hint": "B_HINT_TEXT"},
            },
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")
        assert "## Extraction notes" in prompt
        assert "**b**" in prompt
        assert "B_HINT_TEXT" in prompt
        # Unhinted field shouldn't appear in notes
        assert "**a**:" not in prompt

    def test_context_chunks_rendered_when_not_in_group(self):
        """oss-58: isolated groups should see the document's opening
        region so the model can apply schema-level conditional rules."""
        header_chunk = make_chunk(index=0, title="Document Start", content="FORM 10-K DOCUMENT HEADER")
        body_chunk = make_chunk(index=42, title="SIGNATURES", content="/s/ Officer Dated: April 10, 2026")
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [body_chunk],
        }
        prompt = build_group_prompt(group, "test", context_chunks=[header_chunk])
        # The context section appears
        assert "## Document context" in prompt
        assert "FORM 10-K DOCUMENT HEADER" in prompt
        # Context comes BEFORE Document sections
        assert prompt.index("## Document context") < prompt.index("## Document sections")
        # Routed chunk still rendered in the main sections
        assert "SIGNATURES" in prompt
        assert "Dated: April 10, 2026" in prompt

    def test_context_chunks_skip_duplicates_already_in_group(self):
        """Context chunks already in the group's routed set are dropped
        to avoid duplication in the prompt."""
        shared_chunk = make_chunk(index=0, title="Document Start", content="DO NOT DUPLICATE")
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [shared_chunk],
        }
        prompt = build_group_prompt(group, "test", context_chunks=[shared_chunk])
        # DO NOT DUPLICATE should appear exactly once — in Document sections,
        # not also in Document context.
        assert prompt.count("DO NOT DUPLICATE") == 1
        assert "## Document context" not in prompt

    def test_context_chunks_partial_dedupe(self):
        """If some context chunks are in the group and others aren't,
        render only the new ones in the context section."""
        in_group = make_chunk(index=0, title="Header", content="ALREADY HERE")
        not_in_group = make_chunk(index=1, title="Commission", content="UNIQUE CONTEXT")
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [in_group],
        }
        prompt = build_group_prompt(group, "test", context_chunks=[in_group, not_in_group])
        assert "## Document context" in prompt
        assert "UNIQUE CONTEXT" in prompt
        # ALREADY HERE appears in Document sections, not Document context
        assert prompt.count("ALREADY HERE") == 1

    def test_context_chunks_none_omits_section(self):
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test")  # no context_chunks
        assert "## Document context" not in prompt

    def test_context_chunks_empty_list_omits_section(self):
        group = {
            "fields": ["filing_date"],
            "field_specs": {"filing_date": {"type": "date"}},
            "chunks": [make_chunk()],
        }
        prompt = build_group_prompt(group, "test", context_chunks=[])
        assert "## Document context" not in prompt


class TestExcludeContains:
    def test_matching_lines_stripped_from_prompt(self):
        chunk = make_chunk(
            content="| Nature of Injury | Crush Injury |\n| Cause of Injury | Caught in/between |\n\n## Description of Accident\n\nWorker caught left wrist in conveyor belt."
        )
        group = {
            "fields": ["description"],
            "field_specs": {
                "description": {
                    "type": "string",
                    "hints": {
                        "exclude_contains": ["Nature of Injury", "Cause of Injury"],
                    },
                }
            },
            "chunks": [chunk],
        }
        prompt = build_group_prompt(group, "test")
        assert "Crush Injury" not in prompt
        assert "Caught in/between" not in prompt
        assert "Worker caught left wrist" in prompt

    def test_no_exclusions_passes_all_content(self):
        chunk = make_chunk(content="| Nature of Injury | Crush Injury |\nSome other content")
        group = {
            "fields": ["description"],
            "field_specs": {"description": {"type": "string"}},
            "chunks": [chunk],
        }
        prompt = build_group_prompt(group, "test")
        assert "Crush Injury" in prompt
        assert "Some other content" in prompt

    def test_case_insensitive_exclusion(self):
        chunk = make_chunk(content="NATURE OF INJURY: Burns\nDescription: Fire in warehouse")
        group = {
            "fields": ["description"],
            "field_specs": {
                "description": {
                    "type": "string",
                    "hints": {"exclude_contains": ["nature of injury"]},
                }
            },
            "chunks": [chunk],
        }
        prompt = build_group_prompt(group, "test")
        assert "Burns" not in prompt
        assert "Fire in warehouse" in prompt


# ── build_gap_fill_prompt ─────────────────────────────────────────────


class TestBuildGapFillPrompt:
    def test_includes_extraction_hint(self):
        spec = {
            "type": "date",
            "required": True,
            "extraction_hint": "GAP_FILL_HINT_CONTENT",
        }
        prompt = build_gap_fill_prompt("filing_date", spec, [make_chunk()], "test")
        assert "## Extraction notes" in prompt
        assert "**filing_date**" in prompt
        assert "GAP_FILL_HINT_CONTENT" in prompt

    def test_no_notes_section_when_no_hint(self):
        spec = {"type": "date"}
        prompt = build_gap_fill_prompt("filing_date", spec, [make_chunk()], "test")
        assert "Extraction notes" not in prompt

    def test_gap_fill_context_chunks_rendered(self):
        """Gap-fill prompts also get document context so retry pass
        sees top-of-document information."""
        header_chunk = make_chunk(index=0, title="Header", content="DOC IDENTITY CONTEXT")
        body_chunk = make_chunk(index=42, title="Body", content="body text")
        spec = {"type": "date", "extraction_hint": "use signature date"}
        prompt = build_gap_fill_prompt(
            "filing_date",
            spec,
            [body_chunk],
            "test",
            context_chunks=[header_chunk],
        )
        assert "## Document context" in prompt
        assert "DOC IDENTITY CONTEXT" in prompt

    def test_gap_fill_no_context_chunks_omits_section(self):
        spec = {"type": "date"}
        prompt = build_gap_fill_prompt("filing_date", spec, [make_chunk()], "test")
        assert "## Document context" not in prompt

    def test_gap_fill_instructs_flat_output_shape(self):
        """Gap-fill prompt must tell the model not to nest the field
        under a schema name. See oss-60."""
        spec = {"type": "date"}
        prompt = build_gap_fill_prompt("filing_date", spec, [make_chunk()], "filing_metadata")
        assert "FLAT JSON object" in prompt
        assert "do NOT nest" in prompt


# ── _unwrap_nested_result — oss-60 defensive flattening ───────────────


class TestUnwrapNestedResult:
    """Flatten LLM output that was wrapped under a non-field key.

    Despite a prompt that asks for a flat JSON object, gpt-4o-mini
    sometimes wraps single-field output under the schema name or another
    label from the prompt. The unwrap helper lets reconcile still find
    the field at the top level. See oss-60 for the sec_filings
    filing_date repro that uncovered this.
    """

    def test_already_flat_passes_through(self):
        result = {"filing_date": "2026-04-10"}
        assert _unwrap_nested_result(result, {"filing_date"}) == {"filing_date": "2026-04-10"}

    def test_wrapped_under_schema_name(self):
        result = {"filing_metadata": {"filing_date": "2026-04-10"}}
        assert _unwrap_nested_result(result, {"filing_date"}) == {"filing_date": "2026-04-10"}

    def test_wrapped_under_any_wrapper_key(self):
        # The wrapper key can be anything; the helper detects "no expected
        # field at top level, exactly one nested dict containing the fields"
        # regardless of what that wrapper is named.
        result = {"result": {"merchant_name": "Acme", "total": 100}}
        assert _unwrap_nested_result(result, {"merchant_name", "total"}) == {
            "merchant_name": "Acme",
            "total": 100,
        }

    def test_partial_nested_match_unwraps(self):
        # Only filing_date is expected and it's the only thing nested —
        # unwrap still applies even though the inner dict has only one
        # of the expected fields.
        result = {"filing_metadata": {"filing_date": "2026-04-10"}}
        expected = {"filing_date", "filer_name", "form_type"}
        assert _unwrap_nested_result(result, expected) == {"filing_date": "2026-04-10"}

    def test_top_level_field_wins_over_nested(self):
        # If the expected field IS at the top level, don't touch the
        # result — even if a nested dict also contains the name.
        result = {
            "filing_date": "2026-04-10",
            "nested": {"filing_date": "2025-01-01"},
        }
        assert _unwrap_nested_result(result, {"filing_date"}) == result

    def test_two_candidate_wrappers_pass_through(self):
        # If there are multiple nested dicts containing expected fields,
        # we can't confidently pick one — pass through unchanged and let
        # reconcile mark not_found rather than guess wrong.
        result = {
            "first": {"filing_date": "2026-04-10"},
            "second": {"filing_date": "2025-01-01"},
        }
        assert _unwrap_nested_result(result, {"filing_date"}) == result

    def test_nested_without_expected_fields_pass_through(self):
        # A nested dict that doesn't overlap with expected fields
        # (e.g., legitimate array-item metadata) is not touched.
        result = {"metadata": {"source": "xbrl", "confidence": 0.9}}
        assert _unwrap_nested_result(result, {"filing_date"}) == result

    def test_empty_inputs(self):
        assert _unwrap_nested_result({}, {"filing_date"}) == {}
        assert _unwrap_nested_result({"a": 1}, set()) == {"a": 1}

    def test_non_dict_input_passes_through(self):
        assert _unwrap_nested_result(None, {"x"}) is None  # type: ignore[arg-type]
        assert _unwrap_nested_result([1, 2, 3], {"x"}) == [1, 2, 3]  # type: ignore[arg-type]


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
        routes = [make_field_route(field_name="policy_number", source="hint")]
        out = reconcile(results, schema, routes=routes)
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
        routes = [make_field_route(field_name="items", source="hint")]
        out = reconcile(results, schema, routes=routes)
        assert out["confidence"]["items"] == "high"

    def test_single_array_source_high_confidence_with_hint(self):
        results = [{"items": [1, 2]}]
        schema = {"fields": {"items": {"type": "array"}}}
        routes = [make_field_route(field_name="items", source="hint")]
        out = reconcile(results, schema, routes=routes)
        # hint(0.4) + single(0.15) + validation(0.2) = 0.75 => high
        assert out["confidence"]["items"] == "high"

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
        assert "document_map_summary" in result
        assert "routing_plan" in result
        assert "groups" in result
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

    async def test_context_chunks_flow_to_single_field_group_prompt(self, monkeypatch):
        """oss-58 regression guard: a single-field group's prompt must
        include the document's opening chunks as Document context so the
        model can disambiguate schema-level conditional rules."""
        schema = {
            "name": "test_context",
            "fields": {
                "filing_date": {
                    "type": "date",
                    "required": True,
                    "hints": {"look_in": ["header"]},
                },
            },
        }
        provider = MockProvider(responses=[json.dumps({"filing_date": "2026-04-10"})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        # Multi-chunk markdown so routing can land deep; the first chunk
        # carries the distinguishing identifier and must make it into the
        # prompt even if filing_date routes elsewhere.
        markdown = (
            "# Document Start\n\n"
            "DOC_IDENTITY_MARKER FORM 10-K\n\n"
            "# Body\n\n"
            "Lots of text without the marker.\n\n"
            "# Body 2\n\n"
            "More body text.\n\n"
            "# Signatures\n\n"
            "Dated: April 10, 2026 /s/ Officer\n"
        )
        await intelligent_extract(markdown=markdown, schema_def=schema, model="mock/test")

        assert len(provider.calls) >= 1
        prompt = provider.calls[0]["prompt"]
        # The marker from chunk 0 is present in the prompt even though
        # filing_date routes on hints.look_in=header — the context block
        # threads it in regardless.
        assert "DOC_IDENTITY_MARKER" in prompt
        assert "## Document context" in prompt or "Document Start" in prompt


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

    async def test_gap_fill_strips_hints_to_escape_restrictive_look_in(self, monkeypatch):
        """When look_in filters out the chunk that actually contains the value,
        gap-fill should strip the hints and re-route across the full pool so the
        missing value can be found in a chunk the main pass never saw."""
        schema = {
            "name": "test_gap",
            "categories": {
                "keywords": {
                    "header": ["preamble"],
                    "body": ["content"],
                }
            },
            "fields": {
                "secret_value": {
                    "type": "string",
                    "required": True,
                    # The schema author thinks the value lives in the "header"
                    # category — but the document puts it in "body".
                    "hints": {"look_in": ["header"]},
                },
            },
        }
        # Main pass sees only the header chunk and returns null. Gap-fill
        # should then strip look_in and search across all chunks, which
        # includes the body chunk where the value actually lives.
        provider = MockProvider(
            responses=[
                json.dumps({"secret_value": None}),
                json.dumps({"secret_value": "hidden-in-body"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        markdown = (
            "# Preamble\n\nThis is a preamble section with nothing useful.\n\n"
            "# Content\n\nThe content section has the secret_value: hidden-in-body"
        )
        result = await intelligent_extract(
            markdown=markdown,
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["secret_value"] == "hidden-in-body"
        assert "secret_value" in result["gap_filled"]
        # Main pass + gap fill = 2 calls
        assert len(provider.calls) == 2

    async def test_gap_fill_preserves_extraction_hint_in_prompt(self, monkeypatch):
        """Gap-fill strips *routing* hints but keeps extraction_hint in the prompt."""
        schema = {
            "name": "test_gap",
            "fields": {
                "tricky": {
                    "type": "string",
                    "required": True,
                    "extraction_hint": "THIS_HINT_MUST_SURVIVE_GAP_FILL",
                    "hints": {"look_in": ["nowhere"]},
                },
            },
        }
        provider = MockProvider(
            responses=[
                json.dumps({"tricky": None}),
                json.dumps({"tricky": "found"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        await intelligent_extract(
            markdown="# Body\n\nSome content where tricky: found lives.",
            schema_def=schema,
            model="mock/test",
        )

        # Second call is the gap-fill; its prompt should include the extraction_hint
        gap_call_prompt = provider.calls[1]["prompt"]
        assert "THIS_HINT_MUST_SURVIVE_GAP_FILL" in gap_call_prompt


# ── Pipeline metadata (document_map_summary, routing_plan, groups) ────


class TestPipelineMetadata:
    async def test_document_map_summary_structure(self, monkeypatch):
        """document_map_summary contains total_chunks, by_category, signal_counts."""
        provider = MockProvider(responses=[json.dumps({"title": "X", "amount": 1})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: X\nAmount: $1",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        dms = result["document_map_summary"]
        assert "total_chunks" in dms
        assert "by_category" in dms
        assert "signal_counts" in dms
        assert isinstance(dms["total_chunks"], int)
        assert isinstance(dms["by_category"], dict)

    async def test_routing_plan_has_all_fields(self, monkeypatch):
        """routing_plan has an entry for every schema field."""
        provider = MockProvider(responses=[json.dumps({"title": "X", "amount": 1})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: X\nAmount: $1",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        rp = result["routing_plan"]
        for field_name in MINIMAL_SCHEMA["fields"]:
            assert field_name in rp
            assert "source" in rp[field_name]
            assert "chunks" in rp[field_name]

    async def test_groups_structure(self, monkeypatch):
        """groups is a list of dicts with fields and chunk_count."""
        provider = MockProvider(responses=[json.dumps({"title": "X", "amount": 1})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: X\nAmount: $1",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        groups = result["groups"]
        assert isinstance(groups, list)
        assert len(groups) >= 1
        for group in groups:
            assert "fields" in group
            assert "chunk_count" in group
            assert isinstance(group["fields"], list)
            assert isinstance(group["chunk_count"], int)
            assert group["chunk_count"] >= 1

    async def test_groups_cover_all_fields(self, monkeypatch):
        """All schema fields appear across the groups."""
        provider = MockProvider(responses=[json.dumps({"title": "X", "amount": 1})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: X\nAmount: $1",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        all_fields = set()
        for group in result["groups"]:
            all_fields.update(group["fields"])
        for field_name in MINIMAL_SCHEMA["fields"]:
            assert field_name in all_fields

    async def test_insurance_metadata_rich(self, monkeypatch):
        """Insurance doc produces multiple categories and routing sources."""
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
                ]
            }
        )
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

        dms = result["document_map_summary"]
        assert dms["total_chunks"] == 6
        assert "declarations" in dms["by_category"]

        rp = result["routing_plan"]
        assert rp["policy_number"]["source"] == "hint"

        assert len(result["groups"]) >= 1


# ── Confidence scoring ─────────────────────────────────────────────────


class TestComputeConfidenceScore:
    """Unit tests for the compute_confidence_score function."""

    def test_route_source_hint_contributes_0_4(self):
        score = compute_confidence_score(
            route_source="hint",
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.4

    def test_route_source_signal_inferred_contributes_0_25(self):
        score = compute_confidence_score(
            route_source="signal_inferred",
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.25

    def test_route_source_broadened_contributes_0_1(self):
        score = compute_confidence_score(
            route_source="broadened",
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.1

    def test_route_source_fallback_contributes_0_05(self):
        score = compute_confidence_score(
            route_source="fallback",
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.05

    def test_multi_source_agree_contributes_0_3(self):
        score = compute_confidence_score(
            route_source=None,
            multi_source_agree=True,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.3

    def test_single_source_contributes_0_15(self):
        score = compute_confidence_score(
            route_source=None,
            multi_source_agree=False,
            single_source=True,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.15

    def test_validation_passed_contributes_0_2(self):
        score = compute_confidence_score(
            route_source=None,
            multi_source_agree=False,
            single_source=False,
            validation_passed=True,
            has_relevant_signals=False,
        )
        assert score == 0.2

    def test_signal_density_contributes_0_1(self):
        score = compute_confidence_score(
            route_source=None,
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=True,
        )
        assert score == 0.1

    def test_all_factors_max_score_is_1_0(self):
        score = compute_confidence_score(
            route_source="hint",
            multi_source_agree=True,
            single_source=False,
            validation_passed=True,
            has_relevant_signals=True,
        )
        assert score == pytest.approx(1.0)

    def test_no_factors_score_is_0(self):
        score = compute_confidence_score(
            route_source=None,
            multi_source_agree=False,
            single_source=False,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert score == 0.0

    def test_hint_routed_scores_higher_than_fallback(self):
        hint_score = compute_confidence_score(
            route_source="hint",
            multi_source_agree=False,
            single_source=True,
            validation_passed=True,
            has_relevant_signals=True,
        )
        fallback_score = compute_confidence_score(
            route_source="fallback",
            multi_source_agree=False,
            single_source=True,
            validation_passed=True,
            has_relevant_signals=True,
        )
        assert hint_score > fallback_score

    def test_multi_source_agreement_boosts_score(self):
        with_agreement = compute_confidence_score(
            route_source="hint",
            multi_source_agree=True,
            single_source=False,
            validation_passed=True,
            has_relevant_signals=False,
        )
        without_agreement = compute_confidence_score(
            route_source="hint",
            multi_source_agree=False,
            single_source=True,
            validation_passed=True,
            has_relevant_signals=False,
        )
        assert with_agreement > without_agreement
        assert with_agreement - without_agreement == pytest.approx(0.15)  # 0.3 - 0.15

    def test_validation_failure_reduces_score(self):
        valid = compute_confidence_score(
            route_source="hint",
            multi_source_agree=False,
            single_source=True,
            validation_passed=True,
            has_relevant_signals=False,
        )
        invalid = compute_confidence_score(
            route_source="hint",
            multi_source_agree=False,
            single_source=True,
            validation_passed=False,
            has_relevant_signals=False,
        )
        assert valid > invalid
        assert valid - invalid == pytest.approx(0.2)


class TestScoreLabel:
    """Test the threshold-to-label mapping."""

    def test_high_threshold(self):
        assert _score_label(0.7) == "high"
        assert _score_label(0.85) == "high"
        assert _score_label(1.0) == "high"

    def test_medium_threshold(self):
        assert _score_label(0.4) == "medium"
        assert _score_label(0.5) == "medium"
        assert _score_label(0.69) == "medium"

    def test_low_threshold(self):
        assert _score_label(0.01) == "low"
        assert _score_label(0.1) == "low"
        assert _score_label(0.39) == "low"

    def test_not_found_threshold(self):
        assert _score_label(0.0) == "not_found"


class TestReconcileConfidenceScores:
    """Test that reconcile produces both string labels and numeric scores."""

    def test_confidence_scores_key_present(self):
        results = [{"f": "val"}]
        schema = {"fields": {"f": {"type": "string"}}}
        out = reconcile(results, schema)
        assert "confidence_scores" in out
        assert isinstance(out["confidence_scores"]["f"], float)

    def test_backwards_compatible_string_labels(self):
        results = [{"f": "val"}]
        schema = {"fields": {"f": {"type": "string"}}}
        out = reconcile(results, schema)
        assert out["confidence"]["f"] in ("high", "medium", "low", "not_found")

    def test_not_found_score_is_zero(self):
        results = [{}]
        schema = {"fields": {"f": {"type": "string"}}}
        out = reconcile(results, schema)
        assert out["confidence_scores"]["f"] == 0.0
        assert out["confidence"]["f"] == "not_found"

    def test_hint_route_with_agreement_scores_high(self):
        results = [{"f": "val"}, {"f": "val"}]
        schema = {"fields": {"f": {"type": "string"}}}
        routes = [
            make_field_route(
                field_name="f",
                source="hint",
                chunks=[make_chunk(signals={"has_key_value_pairs": True})],
            )
        ]
        out = reconcile(results, schema, routes=routes)
        # hint(0.4) + multi(0.3) + valid(0.2) + signals(0.1) = 1.0
        assert out["confidence_scores"]["f"] == pytest.approx(1.0)
        assert out["confidence"]["f"] == "high"

    def test_fallback_route_single_source_low(self):
        results = [{"f": "val"}]
        schema = {"fields": {"f": {"type": "string"}}}
        routes = [make_field_route(field_name="f", source="fallback")]
        out = reconcile(results, schema, routes=routes)
        # fallback(0.05) + single(0.15) + valid(0.2) + no_signals(0.0) = 0.4
        assert out["confidence_scores"]["f"] == 0.4
        assert out["confidence"]["f"] == "medium"

    def test_validation_failure_lowers_score(self):
        results = [{"f": "not-a-date"}]
        schema = {"fields": {"f": {"type": "date"}}}
        routes = [
            make_field_route(
                field_name="f",
                source="hint",
                chunks=[make_chunk(signals={"has_dates": True})],
            )
        ]
        out = reconcile(results, schema, routes=routes)
        # hint(0.4) + single(0.15) + failed_validation(0.0) + signals(0.1) = 0.65
        assert out["confidence_scores"]["f"] == 0.65
        assert out["confidence"]["f"] == "medium"

    def test_no_routes_still_works(self):
        """reconcile works without routes (backwards compatible signature)."""
        results = [{"f": "val"}]
        schema = {"fields": {"f": {"type": "string"}}}
        out = reconcile(results, schema)
        # No route: source=None(0.0) + single(0.15) + valid(0.2) = 0.35
        assert out["confidence_scores"]["f"] == 0.35
        assert out["confidence"]["f"] == "low"

    def test_signal_density_boost(self):
        """Chunk with relevant signals for the field type adds 0.1."""
        results = [{"amt": 100}]
        schema = {"fields": {"amt": {"type": "number"}}}
        chunk_with = make_chunk(signals={"has_dollar_amounts": True})
        chunk_without = make_chunk(signals={})

        routes_with = [make_field_route(field_name="amt", source="hint", chunks=[chunk_with])]
        routes_without = [make_field_route(field_name="amt", source="hint", chunks=[chunk_without])]

        out_with = reconcile(results, schema, routes=routes_with)
        out_without = reconcile(results, schema, routes=routes_without)

        assert out_with["confidence_scores"]["amt"] > out_without["confidence_scores"]["amt"]
        assert out_with["confidence_scores"]["amt"] - out_without["confidence_scores"]["amt"] == pytest.approx(0.1)


class TestIntelligentExtractConfidenceScores:
    """End-to-end tests verifying confidence_scores in pipeline output."""

    async def test_confidence_scores_in_output(self, monkeypatch):
        canned = json.dumps({"title": "Test", "amount": 42})
        provider = MockProvider(responses=[canned])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Test\nAmount: $42",
            schema_def=MINIMAL_SCHEMA,
            model="mock/test",
        )

        assert "confidence_scores" in result
        assert isinstance(result["confidence_scores"]["title"], float)
        assert isinstance(result["confidence_scores"]["amount"], float)
        # Both string labels and numeric scores present
        assert "confidence" in result
        for field in MINIMAL_SCHEMA["fields"]:
            assert field in result["confidence"]
            assert field in result["confidence_scores"]


# ── _toposort_fields ──────────────────────────────────────────────────


class TestToposortFields:
    def test_single_wave_when_no_depends(self):
        schema = {
            "fields": {
                "a": {"type": "string"},
                "b": {"type": "string"},
                "c": {"type": "string"},
            }
        }
        waves = _toposort_fields(schema)
        assert len(waves) == 1
        assert set(waves[0]) == {"a", "b", "c"}

    def test_simple_parent_child(self):
        schema = {
            "fields": {
                "form_type": {"type": "enum"},
                "period_of_report": {"type": "date", "depends_on": ["form_type"]},
            }
        }
        waves = _toposort_fields(schema)
        assert waves == [["form_type"], ["period_of_report"]]

    def test_multi_child_same_parent(self):
        schema = {
            "fields": {
                "form_type": {"type": "enum"},
                "filing_date": {"type": "date", "depends_on": ["form_type"]},
                "period_of_report": {"type": "date", "depends_on": ["form_type"]},
            }
        }
        waves = _toposort_fields(schema)
        assert len(waves) == 2
        assert waves[0] == ["form_type"]
        assert set(waves[1]) == {"filing_date", "period_of_report"}

    def test_multi_level_chain(self):
        schema = {
            "fields": {
                "a": {"type": "string"},
                "b": {"type": "string", "depends_on": ["a"]},
                "c": {"type": "string", "depends_on": ["b"]},
            }
        }
        waves = _toposort_fields(schema)
        assert waves == [["a"], ["b"], ["c"]]

    def test_circular_dependency_raises(self):
        schema = {
            "fields": {
                "a": {"type": "string", "depends_on": ["b"]},
                "b": {"type": "string", "depends_on": ["a"]},
            }
        }
        with pytest.raises(ValueError, match="Circular"):
            _toposort_fields(schema)

    def test_self_dependency_raises(self):
        schema = {"fields": {"a": {"type": "string", "depends_on": ["a"]}}}
        with pytest.raises(ValueError, match="cannot depend on itself"):
            _toposort_fields(schema)

    def test_unknown_parent_reference_raises(self):
        schema = {
            "fields": {
                "a": {"type": "string", "depends_on": ["ghost"]},
            }
        }
        with pytest.raises(ValueError, match="unknown field"):
            _toposort_fields(schema)

    def test_empty_schema(self):
        assert _toposort_fields({"fields": {}}) == []
        assert _toposort_fields({}) == []

    def test_non_list_depends_on_ignored(self):
        """Defensive: non-list depends_on values don't crash, just get ignored."""
        schema = {
            "fields": {
                "a": {"type": "string"},
                "b": {"type": "string", "depends_on": "a"},  # string, not list
            }
        }
        waves = _toposort_fields(schema)
        # Both end up in wave 0 since the invalid depends_on was ignored
        assert len(waves) == 1
        assert set(waves[0]) == {"a", "b"}


# ── _resolve_conditional_hints ────────────────────────────────────────


class TestResolveConditionalHints:
    def test_no_conditional_block_returns_original(self):
        spec = {"type": "date", "extraction_hint": "default"}
        assert _resolve_conditional_hints(spec, {}) is spec

    def test_parent_value_matches_produces_resolved_copy(self):
        spec = {
            "type": "date",
            "extraction_hint": "default",
            "extraction_hint_by": {
                "form_type": {
                    "10-K": "HINT_FOR_10K",
                    "10-Q": "HINT_FOR_10Q",
                }
            },
        }
        resolved = _resolve_conditional_hints(spec, {"form_type": "10-K"})
        assert resolved is not spec  # new dict
        assert resolved["extraction_hint"] == "HINT_FOR_10K"
        # Original untouched
        assert spec["extraction_hint"] == "default"

    def test_parent_missing_falls_back_to_default(self):
        spec = {
            "type": "date",
            "extraction_hint": "default_hint",
            "extraction_hint_by": {"form_type": {"10-K": "other"}},
        }
        resolved = _resolve_conditional_hints(spec, {})
        assert resolved["extraction_hint"] == "default_hint"

    def test_parent_value_not_in_map_falls_back(self):
        spec = {
            "type": "date",
            "extraction_hint": "default_hint",
            "extraction_hint_by": {"form_type": {"10-K": "other"}},
        }
        resolved = _resolve_conditional_hints(spec, {"form_type": "S-1"})
        assert resolved["extraction_hint"] == "default_hint"

    def test_parent_value_none_falls_back(self):
        spec = {
            "type": "date",
            "extraction_hint": "default_hint",
            "extraction_hint_by": {"form_type": {"10-K": "other"}},
        }
        resolved = _resolve_conditional_hints(spec, {"form_type": None})
        assert resolved["extraction_hint"] == "default_hint"

    def test_enum_value_match(self):
        """Enum values (like '10-K/A') match as strings."""
        spec = {
            "extraction_hint": "default",
            "extraction_hint_by": {
                "form_type": {
                    "10-K/A": "amendment_hint",
                }
            },
        }
        resolved = _resolve_conditional_hints(spec, {"form_type": "10-K/A"})
        assert resolved["extraction_hint"] == "amendment_hint"

    def test_empty_string_hint_falls_back(self):
        """A conditional hint that's an empty/whitespace string doesn't override."""
        spec = {
            "extraction_hint": "default",
            "extraction_hint_by": {"form_type": {"10-K": "   "}},
        }
        resolved = _resolve_conditional_hints(spec, {"form_type": "10-K"})
        assert resolved["extraction_hint"] == "default"

    def test_multiple_parents_first_match_wins(self):
        spec = {
            "extraction_hint": "default",
            "extraction_hint_by": {
                "form_type": {"10-K": "from_form_type"},
                "filer_name": {"ACME": "from_filer"},
            },
        }
        # Both parents have matching values — the first declared wins (dict order).
        resolved = _resolve_conditional_hints(spec, {"form_type": "10-K", "filer_name": "ACME"})
        assert resolved["extraction_hint"] == "from_form_type"

    def test_non_dict_field_spec_returns_as_is(self):
        assert _resolve_conditional_hints("not a dict", {}) == "not a dict"


# ── Wave-based extraction integration ────────────────────────────────


class TestWaveExtraction:
    async def test_dependent_field_gets_resolved_hint_in_prompt(self, monkeypatch):
        """The wave 1 prompt should contain the conditional hint keyed on wave 0's value."""
        schema = {
            "name": "waves",
            "fields": {
                "form_type": {"type": "string", "required": True},
                "period_of_report": {
                    "type": "date",
                    "required": True,
                    "depends_on": ["form_type"],
                    "extraction_hint": "generic hint",
                    "extraction_hint_by": {
                        "form_type": {
                            "10-K": "MATCHED_10K_HINT_CONTENT",
                            "10-Q": "MATCHED_10Q_HINT_CONTENT",
                        }
                    },
                },
            },
        }
        provider = MockProvider(
            responses=[
                json.dumps({"form_type": "10-K"}),  # wave 0
                json.dumps({"period_of_report": "2025-12-31"}),  # wave 1
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Cover\n\nForm: 10-K\nFor the fiscal year ended December 31, 2025",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"]["form_type"] == "10-K"
        assert result["extracted"]["period_of_report"] == "2025-12-31"
        # Two LLM calls — one per wave
        assert len(provider.calls) == 2
        # Wave 1 prompt must contain the conditional hint, not the generic one
        wave1_prompt = provider.calls[1]["prompt"]
        assert "MATCHED_10K_HINT_CONTENT" in wave1_prompt
        assert "MATCHED_10Q_HINT_CONTENT" not in wave1_prompt

    async def test_fallback_to_default_hint_when_parent_null(self, monkeypatch):
        """If wave 0 can't extract the parent, wave 1 falls back to the default extraction_hint."""
        schema = {
            "name": "waves",
            "fields": {
                "form_type": {"type": "string"},
                "period_of_report": {
                    "type": "date",
                    "depends_on": ["form_type"],
                    "extraction_hint": "DEFAULT_HINT_FALLBACK",
                    "extraction_hint_by": {
                        "form_type": {"10-K": "NEVER_PICKED"},
                    },
                },
            },
        }
        provider = MockProvider(
            responses=[
                json.dumps({"form_type": None}),
                json.dumps({"period_of_report": "2025-12-31"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        await intelligent_extract(
            markdown="# Cover\n\nSome content.",
            schema_def=schema,
            model="mock/test",
        )

        wave1_prompt = provider.calls[1]["prompt"]
        assert "DEFAULT_HINT_FALLBACK" in wave1_prompt
        assert "NEVER_PICKED" not in wave1_prompt

    async def test_no_depends_on_runs_as_single_wave(self, monkeypatch):
        """Schemas without depends_on run in a single wave — one LLM call per group, not one per field."""
        schema = {
            "name": "single_wave",
            "fields": {
                "a": {"type": "string", "required": True},
                "b": {"type": "string", "required": True},
            },
        }
        provider = MockProvider(responses=[json.dumps({"a": "foo", "b": "bar"})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        result = await intelligent_extract(
            markdown="# Header\n\nA is foo and B is bar",
            schema_def=schema,
            model="mock/test",
        )

        assert result["extracted"] == {"a": "foo", "b": "bar"}
        # Grouping means both fields extract in one call
        assert len(provider.calls) == 1

    async def test_circular_dep_schema_raises(self, monkeypatch):
        schema = {
            "name": "bad",
            "fields": {
                "a": {"type": "string", "depends_on": ["b"]},
                "b": {"type": "string", "depends_on": ["a"]},
            },
        }
        provider = MockProvider(responses=[])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        with pytest.raises(ValueError, match="Circular"):
            await intelligent_extract(
                markdown="# X\n\nstuff",
                schema_def=schema,
                model="mock/test",
            )


# ── Classifier-enabled intelligent_extract (packet splitting) ────────


class TestClassifierEnabled:
    async def test_no_classify_config_preserves_flat_shape(self, monkeypatch):
        """classify_config=None → response is byte-identical to pre-classifier."""
        schema = {
            "name": "doc",
            "fields": {"title": {"type": "string", "required": True}},
        }
        provider = MockProvider(responses=[json.dumps({"title": "Hello"})])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Hello",
            schema_def=schema,
            model="mock/test",
        )
        assert "extracted" in result
        assert "sections" not in result  # flat shape
        assert result["extracted"]["title"] == "Hello"

    async def test_classifier_enabled_wraps_response_in_sections(self, monkeypatch):
        """classify_config set → response always wraps in sections, even for single section."""
        schema = {
            "name": "invoice",
            "fields": {"invoice_number": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # 1st call = classifier: one invoice section
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 1, "confidence": 0.95},
                        ]
                    }
                ),
                # 2nd call = extract on that section
                json.dumps({"invoice_number": "INV-001"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "invoice", "description": "Invoice"}],
            "short_doc_chunks": 0,  # force LLM path regardless of doc size
        }
        result = await intelligent_extract(
            markdown="# Header\n\nInvoice Number: INV-001\n\n# Items\n\nWidget",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )

        assert "sections" in result
        assert "extracted" not in result  # wrapped shape
        assert len(result["sections"]) == 1
        assert result["sections"][0]["section_type"] == "invoice"
        assert result["sections"][0]["extracted"]["invoice_number"] == "INV-001"
        assert result["classifier"]["total_sections"] == 1
        assert result["classifier"]["sections_matched"] == 1

    async def test_apply_to_filters_sections_by_type(self, monkeypatch):
        """Schema with apply_to:[policy] only runs against policy sections."""
        schema = {
            "name": "insurance_policy",
            "apply_to": ["policy"],
            "fields": {"policy_number": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # Classifier: invoice + coi + policy
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 1, "confidence": 0.9},
                            {"type": "coi", "start_chunk": 2, "end_chunk": 3, "confidence": 0.9},
                            {"type": "policy", "start_chunk": 4, "end_chunk": 5, "confidence": 0.95},
                        ]
                    }
                ),
                # Extract: only the policy section gets extracted
                json.dumps({"policy_number": "BOP-9999"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [
                {"id": "invoice", "description": "Invoice"},
                {"id": "coi", "description": "Cert of insurance"},
                {"id": "policy", "description": "Policy"},
            ],
        }
        # Six chunks so the classifier can split them three ways.
        markdown = (
            "# Invoice\n\nINV-111\n\n# Invoice items\n\nWidget\n\n"
            "# COI\n\nInsurer: ACME\n\n# COI details\n\nCoverage\n\n"
            "# Policy\n\nPolicy Number: BOP-9999\n\n# Policy details\n\nLimits"
        )
        result = await intelligent_extract(
            markdown=markdown,
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )

        assert len(result["sections"]) == 1
        assert result["sections"][0]["section_type"] == "policy"
        assert result["sections"][0]["extracted"]["policy_number"] == "BOP-9999"
        assert result["classifier"]["total_sections"] == 3
        assert result["classifier"]["sections_matched"] == 1
        # Extraction ran only once — one classifier call + one extract call
        assert len(provider.calls) == 2

    async def test_apply_to_matches_multiple_sections(self, monkeypatch):
        """Schema with apply_to:[invoice] runs once per matching section in a multi-invoice packet."""
        schema = {
            "name": "invoice",
            "apply_to": ["invoice"],
            "fields": {"invoice_number": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 1, "confidence": 0.9},
                            {"type": "invoice", "start_chunk": 2, "end_chunk": 3, "confidence": 0.9},
                        ]
                    }
                ),
                json.dumps({"invoice_number": "INV-001"}),
                json.dumps({"invoice_number": "INV-002"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "invoice", "description": "Invoice"}],
        }
        markdown = "# First\n\nINV-001\n\n# Items1\n\nA\n\n# Second\n\nINV-002\n\n# Items2\n\nB"
        result = await intelligent_extract(
            markdown=markdown,
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        assert len(result["sections"]) == 2
        # Each section got its own extract call
        numbers = {s["extracted"]["invoice_number"] for s in result["sections"]}
        assert numbers == {"INV-001", "INV-002"}

    async def test_apply_to_no_matching_section_returns_empty_list(self, monkeypatch):
        """Schema declares apply_to:[policy] but no policy section is classified."""
        schema = {
            "name": "policy",
            "apply_to": ["policy"],
            "fields": {"policy_number": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 1, "confidence": 0.9},
                        ]
                    }
                ),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [
                {"id": "invoice", "description": "Invoice"},
                {"id": "policy", "description": "Policy"},
            ],
            "short_doc_chunks": 0,
        }
        result = await intelligent_extract(
            markdown="# Inv\n\nINV-001\n\n# More\n\nfoo",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        assert result["sections"] == []
        assert result["classifier"]["reason"] == "no_matching_section"
        # Only the classifier call — no wasted extract calls
        assert len(provider.calls) == 1

    async def test_require_apply_to_strict_mode_raises_when_missing(self, monkeypatch):
        schema = {
            "name": "invoice",
            # no apply_to declared
            "fields": {"invoice_number": {"type": "string", "required": True}},
        }
        provider = MockProvider(responses=[])
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "require_apply_to": True,
            "types": [{"id": "invoice", "description": "Invoice"}],
        }
        with pytest.raises(ValueError, match="apply_to"):
            await intelligent_extract(
                markdown="# H\n\nstuff",
                schema_def=schema,
                model="mock/test",
                classify_config=classify_config,
            )

    async def test_forgiving_mode_runs_against_every_section(self, monkeypatch):
        """Schema with no apply_to + forgiving mode runs against every section."""
        schema = {
            "name": "generic",
            # no apply_to
            "fields": {"title": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                json.dumps(
                    {
                        "sections": [
                            {"type": "invoice", "start_chunk": 0, "end_chunk": 0, "confidence": 0.9},
                            {"type": "policy", "start_chunk": 1, "end_chunk": 1, "confidence": 0.9},
                        ]
                    }
                ),
                json.dumps({"title": "Invoice Title"}),
                json.dumps({"title": "Policy Title"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "require_apply_to": False,
            "types": [
                {"id": "invoice", "description": "Invoice"},
                {"id": "policy", "description": "Policy"},
            ],
            "short_doc_chunks": 0,
        }
        result = await intelligent_extract(
            markdown="# Inv\n\nInvoice Title\n\n# Pol\n\nPolicy Title",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        # Ran against both sections regardless of type
        assert len(result["sections"]) == 2

    async def test_classifier_fallback_when_llm_returns_garbage(self, monkeypatch):
        schema = {
            "name": "doc",
            "fields": {"title": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                "not json at all",  # classifier garbage → normalizer fallback
                json.dumps({"title": "Found"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "doc", "description": "Doc"}],
            "short_doc_chunks": 0,
        }
        result = await intelligent_extract(
            markdown="# Header\n\nTitle: Found",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        # Fallback produced a single `document` section
        assert len(result["sections"]) == 1
        assert result["sections"][0]["section_type"] == "document"
        assert result["sections"][0]["extracted"]["title"] == "Found"
        assert result["classifier"]["normalizer_corrections"] >= 1

    async def test_apply_to_forces_classifier_on_short_doc(self, monkeypatch):
        """Short doc + apply_to declared — regression test for oss-62.

        Before oss-62: the short-doc fast path emitted a single
        `document`-typed section, which `_schema_matches_section` treats
        as matching any apply_to (the oss-55 escape hatch for classifier
        failures). That hatch silently ran schemas against wrong-domain
        short docs (e.g. a COI handed to the SEC schema hallucinated
        filer_name='Zephyr Logistics LLC').

        Fix: when the schema declares apply_to, pipeline forces
        `short_doc_chunks=0` so the classifier runs and assigns a real
        type. The happy path (true SEC stub → classifier labels
        sec_filing → apply_to matches → extract runs) still works — the
        regression that oss-55 guarded against is preserved via the
        classifier rather than via a type-agnostic bypass.
        """
        schema = {
            "name": "sec_filing",
            "apply_to": ["sec_filing"],
            "fields": {"company_name": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # 1) Classifier call (fast path disabled by apply_to)
                json.dumps(
                    {"sections": [{"type": "sec_filing", "start_chunk": 0, "end_chunk": 0, "confidence": 0.97}]}
                ),
                # 2) Extract call for the classified section
                json.dumps({"company_name": "Acme Corp"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "sec_filing", "description": "SEC filing"}],
            # Use default short_doc_chunks — pipeline must override to 0
            # when apply_to is declared.
        }
        result = await intelligent_extract(
            markdown="# 10-K Cover\n\nAcme Corp",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        assert len(result["sections"]) == 1
        assert result["sections"][0]["section_type"] == "sec_filing"
        assert result["sections"][0]["extracted"]["company_name"] == "Acme Corp"
        # Fast path was overridden by apply_to — classifier actually ran.
        assert result["classifier"]["bypassed_short_doc"] is False
        assert result["classifier"]["sections_matched"] == 1
        # Both the classifier call and the extract call happened.
        assert len(provider.calls) == 2

    async def test_apply_to_forces_classifier_to_reject_wrong_domain_short_doc(self, monkeypatch):
        """oss-62 negative case: a short doc from the wrong domain now gets
        filtered out by apply_to instead of hallucinating.

        Before: one-chunk COI + sec_filing schema → fast path emits
        `document`, apply_to bypass → extract runs → filer_name='Zephyr
        Logistics LLC' hallucinated.
        After: classifier forced to run, labels it `coi`, apply_to
        filters it out → zero matching sections, no hallucination."""
        schema = {
            "name": "sec_filing",
            "apply_to": ["sec_filing"],
            "fields": {"company_name": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # Classifier says: this is a coi.
                json.dumps({"sections": [{"type": "coi", "start_chunk": 0, "end_chunk": 0, "confidence": 0.94}]}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )

        classify_config = {
            "model": "mock/classify",
            "types": [
                {"id": "sec_filing", "description": "SEC filing"},
                {"id": "coi", "description": "Certificate of insurance"},
            ],
        }
        result = await intelligent_extract(
            markdown="# Certificate of Liability\n\nZephyr Logistics LLC",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        # Classifier ran, labeled coi, apply_to dropped it — no extract call.
        assert result["sections"] == []
        assert result["classifier"]["bypassed_short_doc"] is False
        assert result["classifier"]["sections_matched"] == 0
        assert result["classifier"]["reason"] == "no_matching_section"
        # Only the classifier call — no extract call.
        assert len(provider.calls) == 1

    async def test_document_fallback_without_error_respects_apply_to(self, monkeypatch):
        """Classifier runs, returns garbage that normalizes to `document`
        fallback (no LLM error), and apply_to is declared. The `document`
        escape hatch must NOT fire — the classifier is saying "I don't
        recognize this as any declared type", which means apply_to should
        filter normally. This is the oss-68 cross-domain leak: a COI
        handed to an SEC schema with the classifier returning `document`
        fallback was bypassing apply_to and hallucinating SEC fields."""
        schema = {
            "name": "sec_filing",
            "apply_to": ["sec_filing"],
            "fields": {"company_name": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # Classifier returns garbage — normalizer will correct
                # it to a single `document`-type fallback section.
                "this is not valid json at all",
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        classify_config = {
            "model": "mock/classify",
            "types": [
                {"id": "sec_filing", "description": "SEC filing"},
                {"id": "coi", "description": "Certificate of insurance"},
            ],
        }
        result = await intelligent_extract(
            markdown="# Certificate of Liability\n\nZephyr Logistics LLC",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        # Classifier ran (no error — it returned a response, just bad JSON),
        # normalizer fell back to `document`, apply_to=[sec_filing] should
        # filter it out. No hallucination.
        assert result["sections"] == []
        assert result["classifier"]["sections_matched"] == 0
        assert result["classifier"]["reason"] == "no_matching_section"

    async def test_document_fallback_with_error_preserves_escape_hatch(self, monkeypatch):
        """When the classifier LLM errors (network failure, timeout), the
        normalizer produces a `document` fallback AND the metadata has an
        `error` key. In this case the escape hatch should STILL fire —
        a transient failure shouldn't silently drop extraction for a
        potentially-legitimate document."""
        schema = {
            "name": "sec_filing",
            "apply_to": ["sec_filing"],
            "fields": {"company_name": {"type": "string", "required": True}},
        }
        # First call raises (classifier error), second call is the extract.
        call_count = 0
        original_provider = MockProvider(responses=[])

        async def _generate_with_error(prompt, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("network timeout")
            return json.dumps({"company_name": "Acme Corp"})

        original_provider.generate = _generate_with_error
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: original_provider,
        )
        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "sec_filing", "description": "SEC filing"}],
        }
        result = await intelligent_extract(
            markdown="# 10-K Cover\n\nAcme Corp",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        # Classifier errored → `document` fallback → escape hatch fires →
        # extraction runs. The extract call is the second generate call.
        assert len(result["sections"]) == 1
        assert result["sections"][0]["section_type"] == "document"
        assert result["sections"][0]["extracted"]["company_name"] == "Acme Corp"
        assert "error" in result["classifier"]
        assert result["classifier"]["sections_matched"] == 1

    async def test_no_apply_to_keeps_short_doc_fast_path(self, monkeypatch):
        """Schema without apply_to still gets the fast path (oss-62 only
        overrides when apply_to is declared — the optimization stays for
        schemas that don't opt into type filtering)."""
        schema = {
            "name": "doc",
            "fields": {"title": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                # Only the extract call — classifier is still bypassed.
                json.dumps({"title": "Hello"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "doc", "description": "Generic"}],
        }
        result = await intelligent_extract(
            markdown="# Hi\n\nHello",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        assert result["classifier"]["bypassed_short_doc"] is True
        assert len(provider.calls) == 1

    async def test_short_doc_bypass_respects_config_override(self, monkeypatch):
        """short_doc_chunks: 0 forces classifier even on tiny docs."""
        schema = {
            "name": "doc",
            "fields": {"title": {"type": "string", "required": True}},
        }
        provider = MockProvider(
            responses=[
                json.dumps({"sections": [{"type": "doc", "start_chunk": 0, "end_chunk": 0, "confidence": 0.9}]}),
                json.dumps({"title": "Hi"}),
            ]
        )
        monkeypatch.setattr(
            "services.extract.pipeline.create_provider",
            lambda model: provider,
        )
        classify_config = {
            "model": "mock/classify",
            "types": [{"id": "doc", "description": "Doc"}],
            "short_doc_chunks": 0,
        }
        result = await intelligent_extract(
            markdown="# H\n\nHi",
            schema_def=schema,
            model="mock/test",
            classify_config=classify_config,
        )
        assert result["classifier"]["bypassed_short_doc"] is False
        assert len(result["sections"]) == 1
        assert len(provider.calls) == 2
