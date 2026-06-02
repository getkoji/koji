"""Tests for services/extract/normalize.py — post-extract value transforms."""

from __future__ import annotations

from services.extract.normalize import (
    TRANSFORMS,
    normalize_extracted,
)

# ── Individual transforms ───────────────────────────────────────────


class TestTransforms:
    def test_trim(self):
        assert TRANSFORMS["trim"]("  hello  ") == "hello"
        assert TRANSFORMS["trim"](42) == 42

    def test_lowercase(self):
        assert TRANSFORMS["lowercase"]("HELLO") == "hello"
        assert TRANSFORMS["lowercase"](None) is None

    def test_uppercase(self):
        assert TRANSFORMS["uppercase"]("hello") == "HELLO"

    def test_slugify(self):
        assert TRANSFORMS["slugify"]("Hello, World!") == "hello_world"
        assert TRANSFORMS["slugify"]("  Active Status  ") == "active_status"
        assert TRANSFORMS["slugify"]("ALL_CAPS_ALREADY") == "all_caps_already"

    def test_iso8601_iso_input(self):
        assert TRANSFORMS["iso8601"]("2026-4-3") == "2026-04-03"
        assert TRANSFORMS["iso8601"]("2026-04-03") == "2026-04-03"

    def test_iso8601_us_format(self):
        assert TRANSFORMS["iso8601"]("4/3/2026") == "2026-04-03"
        assert TRANSFORMS["iso8601"]("04-03-2026") == "2026-04-03"
        assert TRANSFORMS["iso8601"]("4/3/26") == "2026-04-03"

    def test_iso8601_passthrough_on_unknown(self):
        assert TRANSFORMS["iso8601"]("next Tuesday") == "next Tuesday"

    def test_minor_units_string_currency(self):
        assert TRANSFORMS["minor_units"]("$1,234.56") == 123456
        assert TRANSFORMS["minor_units"]("1234.56 USD") == 123456
        assert TRANSFORMS["minor_units"]("$0.99") == 99

    def test_minor_units_negative_parens(self):
        assert TRANSFORMS["minor_units"]("($50.00)") == -5000

    def test_minor_units_float(self):
        assert TRANSFORMS["minor_units"](1234.56) == 123456

    def test_minor_units_int(self):
        assert TRANSFORMS["minor_units"](100) == 10000

    def test_minor_units_garbage_passthrough(self):
        assert TRANSFORMS["minor_units"]("not a number") == "not a number"

    def test_e164_us_10_digit(self):
        assert TRANSFORMS["e164"]("(555) 123-4567") == "+15551234567"
        assert TRANSFORMS["e164"]("555.123.4567") == "+15551234567"

    def test_e164_us_11_digit_with_leading_1(self):
        assert TRANSFORMS["e164"]("1-555-123-4567") == "+15551234567"

    def test_e164_international(self):
        assert TRANSFORMS["e164"]("+44 20 7946 0958") == "+442079460958"

    def test_e164_empty_passthrough(self):
        assert TRANSFORMS["e164"]("") == ""


# ── normalize_extracted integration ─────────────────────────────────


class TestNormalizeExtracted:
    def test_applies_single_transform(self):
        data = {"vendor": "  Acme Corp  "}
        schema = {"fields": {"vendor": {"type": "string", "normalize": "trim"}}}
        result, report = normalize_extracted(data, schema)
        assert result["vendor"] == "Acme Corp"
        assert ("vendor", "trim") in report.applied

    def test_applies_transform_chain(self):
        data = {"slug": "  Hello World  "}
        schema = {"fields": {"slug": {"type": "string", "normalize": ["trim", "slugify"]}}}
        result, _ = normalize_extracted(data, schema)
        assert result["slug"] == "hello_world"

    def test_unknown_transform_warns_and_passes_through(self):
        data = {"x": "abc"}
        schema = {"fields": {"x": {"type": "string", "normalize": "nonsense"}}}
        result, report = normalize_extracted(data, schema)
        assert result["x"] == "abc"
        assert any("nonsense" in w for w in report.warnings)

    def test_field_without_directive_unchanged(self):
        data = {"vendor": "Acme", "other": "x"}
        schema = {"fields": {"vendor": {"type": "string"}, "other": {"type": "string"}}}
        result, report = normalize_extracted(data, schema)
        assert result == data
        assert report.applied == []

    def test_array_of_objects_normalizes_per_row(self):
        data = {
            "line_items": [
                {"description": "  A  ", "total": "$1.00"},
                {"description": "  B  ", "total": "$2.00"},
            ]
        }
        schema = {
            "fields": {
                "line_items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {"type": "string", "normalize": "trim"},
                            "total": {"type": "number", "normalize": "minor_units"},
                        },
                    },
                }
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["line_items"][0] == {"description": "A", "total": 100}
        assert result["line_items"][1] == {"description": "B", "total": 200}

    def test_missing_field_skipped(self):
        data = {}
        schema = {"fields": {"vendor": {"type": "string", "normalize": "trim"}}}
        result, _ = normalize_extracted(data, schema)
        assert result == {}

    def test_no_schema_passthrough(self):
        data = {"x": 1}
        result, report = normalize_extracted(data, {})
        assert result == data
        assert report.applied == []

    def test_non_dict_input_passthrough(self):
        result, _ = normalize_extracted(None, {"fields": {}})  # type: ignore[arg-type]
        assert result is None


# ── Post-processing directives ────────────────────────────────────────


class TestMapDirective:
    def test_exact_match(self):
        data = {"doc_type": "Invoice"}
        schema = {"fields": {"doc_type": {"type": "string", "map": {"Invoice": "INV", "Credit Note": "CN"}}}}
        result, report = normalize_extracted(data, schema)
        assert result["doc_type"] == "INV"
        assert any("map" in t for _, t in report.applied)

    def test_case_insensitive_fallback(self):
        data = {"doc_type": "invoice"}
        schema = {"fields": {"doc_type": {"type": "string", "map": {"Invoice": "INV"}}}}
        result, _ = normalize_extracted(data, schema)
        assert result["doc_type"] == "INV"

    def test_no_match_passes_through(self):
        data = {"doc_type": "Receipt"}
        schema = {"fields": {"doc_type": {"type": "string", "map": {"Invoice": "INV"}}}}
        result, report = normalize_extracted(data, schema)
        assert result["doc_type"] == "Receipt"
        assert not any("map" in t for _, t in report.applied)

    def test_non_string_value_skipped(self):
        data = {"count": 42}
        schema = {"fields": {"count": {"type": "number", "map": {"42": "forty-two"}}}}
        result, _ = normalize_extracted(data, schema)
        assert result["count"] == 42


class TestDefaultDirective:
    def test_fills_none(self):
        data = {"currency": None}
        schema = {"fields": {"currency": {"type": "string", "default": "USD"}}}
        result, report = normalize_extracted(data, schema)
        assert result["currency"] == "USD"
        assert any("default" in t for _, t in report.applied)

    def test_fills_empty_string(self):
        data = {"currency": ""}
        schema = {"fields": {"currency": {"type": "string", "default": "USD"}}}
        result, _ = normalize_extracted(data, schema)
        assert result["currency"] == "USD"

    def test_fills_whitespace_only(self):
        data = {"currency": "   "}
        schema = {"fields": {"currency": {"type": "string", "default": "USD"}}}
        result, _ = normalize_extracted(data, schema)
        assert result["currency"] == "USD"

    def test_does_not_overwrite_value(self):
        data = {"currency": "EUR"}
        schema = {"fields": {"currency": {"type": "string", "default": "USD"}}}
        result, _ = normalize_extracted(data, schema)
        assert result["currency"] == "EUR"

    def test_numeric_default(self):
        data = {"quantity": None}
        schema = {"fields": {"quantity": {"type": "number", "default": 1}}}
        result, _ = normalize_extracted(data, schema)
        assert result["quantity"] == 1


class TestConcatDirective:
    def test_basic_concat(self):
        data = {"street": "123 Main St", "city": "Austin", "state": "TX", "full_address": None}
        schema = {
            "fields": {
                "street": {"type": "string"},
                "city": {"type": "string"},
                "state": {"type": "string"},
                "full_address": {
                    "type": "string",
                    "concat": {"fields": ["street", "city", "state"], "separator": ", "},
                },
            }
        }
        result, report = normalize_extracted(data, schema)
        assert result["full_address"] == "123 Main St, Austin, TX"
        assert any("concat" in t for _, t in report.applied)

    def test_skips_null_sources(self):
        data = {"first": "John", "middle": None, "last": "Doe", "full_name": None}
        schema = {
            "fields": {
                "first": {"type": "string"},
                "middle": {"type": "string"},
                "last": {"type": "string"},
                "full_name": {"type": "string", "concat": {"fields": ["first", "middle", "last"]}},
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["full_name"] == "John Doe"

    def test_does_not_overwrite_existing(self):
        data = {"first": "John", "last": "Doe", "full_name": "Already Set"}
        schema = {
            "fields": {
                "first": {"type": "string"},
                "last": {"type": "string"},
                "full_name": {"type": "string", "concat": {"fields": ["first", "last"]}},
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["full_name"] == "Already Set"

    def test_default_separator_is_space(self):
        data = {"a": "hello", "b": "world", "c": None}
        schema = {
            "fields": {
                "a": {"type": "string"},
                "b": {"type": "string"},
                "c": {"type": "string", "concat": {"fields": ["a", "b"]}},
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["c"] == "hello world"


class TestComputedDirective:
    def test_basic_template(self):
        data = {"first_name": "John", "last_name": "Doe", "display_name": None}
        schema = {
            "fields": {
                "first_name": {"type": "string"},
                "last_name": {"type": "string"},
                "display_name": {"type": "string", "computed": "{first_name} {last_name}"},
            }
        }
        result, report = normalize_extracted(data, schema)
        assert result["display_name"] == "John Doe"
        assert any("computed" in t for _, t in report.applied)

    def test_missing_placeholder_removed(self):
        data = {"first_name": "John", "middle": None, "display": None}
        schema = {
            "fields": {
                "first_name": {"type": "string"},
                "middle": {"type": "string"},
                "display": {"type": "string", "computed": "{first_name} {middle} {unknown}"},
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["display"] == "John"

    def test_does_not_overwrite_existing(self):
        data = {"a": "x", "b": "y", "c": "already"}
        schema = {
            "fields": {
                "a": {"type": "string"},
                "b": {"type": "string"},
                "c": {"type": "string", "computed": "{a}-{b}"},
            }
        }
        result, _ = normalize_extracted(data, schema)
        assert result["c"] == "already"


class TestRenameDirective:
    def test_basic_rename(self):
        data = {"vendor_name": "Acme Corp"}
        schema = {"fields": {"vendor_name": {"type": "string", "rename": "supplier_name"}}}
        result, report = normalize_extracted(data, schema)
        assert "supplier_name" in result
        assert "vendor_name" not in result
        assert result["supplier_name"] == "Acme Corp"
        assert any("rename" in t for _, t in report.applied)

    def test_does_not_overwrite_existing_key(self):
        data = {"old_key": "value1", "new_key": "value2"}
        schema = {"fields": {"old_key": {"type": "string", "rename": "new_key"}, "new_key": {"type": "string"}}}
        result, _ = normalize_extracted(data, schema)
        # Should NOT overwrite new_key since it already exists
        assert result["old_key"] == "value1"
        assert result["new_key"] == "value2"

    def test_rename_with_other_transforms(self):
        data = {"vendor": "  acme  "}
        schema = {"fields": {"vendor": {"type": "string", "normalize": ["trim", "uppercase"], "rename": "supplier"}}}
        result, _ = normalize_extracted(data, schema)
        assert "supplier" in result
        assert "vendor" not in result
        assert result["supplier"] == "ACME"
