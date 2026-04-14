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
