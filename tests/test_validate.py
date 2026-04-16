"""Tests for services/extract/validate.py — schema-declared post-extract rules."""

from __future__ import annotations

from services.extract.validate import validate_extracted


def _run(data: dict, rules: list) -> dict:
    return validate_extracted(data, {"validation": rules}).to_dict()


# ── required ────────────────────────────────────────────────────────


class TestRequired:
    def test_all_present(self):
        report = _run({"a": 1, "b": "x"}, [{"required": ["a", "b"]}])
        assert report["ok"] is True
        assert report["issues"] == []

    def test_null_field_fails(self):
        report = _run({"a": None, "b": "x"}, [{"required": ["a", "b"]}])
        assert report["ok"] is False
        assert report["issues"][0]["rule"] == "required"
        assert report["issues"][0]["field"] == "a"

    def test_empty_string_fails(self):
        report = _run({"a": "   "}, [{"required": ["a"]}])
        assert report["ok"] is False

    def test_empty_list_fails(self):
        report = _run({"items": []}, [{"required": ["items"]}])
        assert report["ok"] is False


# ── not_empty ───────────────────────────────────────────────────────


class TestNotEmpty:
    def test_non_empty_list_passes(self):
        report = _run({"items": [1]}, [{"not_empty": ["items"]}])
        assert report["ok"] is True

    def test_empty_list_fails(self):
        report = _run({"items": []}, [{"not_empty": ["items"]}])
        assert report["ok"] is False


# ── enum_in ─────────────────────────────────────────────────────────


class TestEnumIn:
    def test_value_in_set(self):
        report = _run(
            {"currency": "USD"},
            [{"enum_in": {"field": "currency", "allowed": ["USD", "EUR"]}}],
        )
        assert report["ok"] is True

    def test_value_not_in_set(self):
        report = _run(
            {"currency": "XYZ"},
            [{"enum_in": {"field": "currency", "allowed": ["USD", "EUR"]}}],
        )
        assert report["ok"] is False
        assert "not in allowed set" in report["issues"][0]["message"]

    def test_null_value_skipped(self):
        report = _run(
            {"currency": None},
            [{"enum_in": {"field": "currency", "allowed": ["USD"]}}],
        )
        assert report["ok"] is True


# ── date_order ──────────────────────────────────────────────────────


class TestDateOrder:
    def test_ascending_passes(self):
        report = _run(
            {"start": "2026-01-01", "end": "2026-12-31"},
            [{"date_order": ["start", "end"]}],
        )
        assert report["ok"] is True

    def test_reversed_fails(self):
        report = _run(
            {"start": "2026-12-31", "end": "2026-01-01"},
            [{"date_order": ["start", "end"]}],
        )
        assert report["ok"] is False
        assert report["issues"][0]["field"] == "end"

    def test_missing_date_silent(self):
        report = _run({"start": "2026-01-01"}, [{"date_order": ["start", "end"]}])
        assert report["ok"] is True


# ── sum_equals ──────────────────────────────────────────────────────


class TestSumEquals:
    def test_exact_match_passes(self):
        report = _run(
            {
                "total": 30,
                "line_items": [{"amount": 10}, {"amount": 20}],
            },
            [{"sum_equals": {"field": "total", "sum_of": "line_items.amount"}}],
        )
        assert report["ok"] is True

    def test_within_tolerance_passes(self):
        report = _run(
            {
                "total": 30.00,
                "line_items": [{"amount": 10.00}, {"amount": 19.995}],
            },
            [{"sum_equals": {"field": "total", "sum_of": "line_items.amount", "tolerance": 0.01}}],
        )
        assert report["ok"] is True

    def test_mismatch_fails(self):
        report = _run(
            {
                "total": 100,
                "line_items": [{"amount": 10}, {"amount": 20}],
            },
            [{"sum_equals": {"field": "total", "sum_of": "line_items.amount"}}],
        )
        assert report["ok"] is False
        assert "sum of" in report["issues"][0]["message"]

    def test_string_currency_values(self):
        report = _run(
            {
                "total": "$30.00",
                "line_items": [{"amount": "$10.00"}, {"amount": "$20.00"}],
            },
            [{"sum_equals": {"field": "total", "sum_of": "line_items.amount"}}],
        )
        assert report["ok"] is True


# ── field_sum ──────────────────────────────────────────────────────


class TestFieldSum:
    def test_consistent_passes(self):
        report = _run(
            {"total_amount": 110, "subtotal": 100, "tax": 10},
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"]}}],
        )
        assert report["ok"] is True

    def test_inconsistent_fails(self):
        report = _run(
            {"total_amount": 1100, "subtotal": 100, "tax": 10},
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"]}}],
        )
        assert report["ok"] is False
        assert "field_sum" in report["issues"][0]["rule"]

    def test_auto_correct_replaces_value(self):
        data = {"total_amount": 1100, "subtotal": 100, "tax": 10}
        report = _run(
            data,
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"], "auto_correct": True}}],
        )
        assert report["ok"] is False  # still reported as an issue
        assert "corrected" in report["issues"][0]["message"]
        assert data["total_amount"] == 110.0

    def test_auto_correct_no_op_when_consistent(self):
        data = {"total_amount": 110, "subtotal": 100, "tax": 10}
        report = _run(
            data,
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"], "auto_correct": True}}],
        )
        assert report["ok"] is True
        assert data["total_amount"] == 110

    def test_tolerance_applies(self):
        report = _run(
            {"total_amount": 110.005, "subtotal": 100, "tax": 10},
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"], "tolerance": 0.01}}],
        )
        assert report["ok"] is True

    def test_missing_addend_skips(self):
        report = _run(
            {"total_amount": 100, "subtotal": 100},
            [{"field_sum": {"field": "total_amount", "addends": ["subtotal", "tax"]}}],
        )
        assert report["ok"] is True  # can't validate without all addends


# ── regex ───────────────────────────────────────────────────────────


class TestRegex:
    def test_match_passes(self):
        report = _run(
            {"invoice": "INV-0001"},
            [{"regex": {"field": "invoice", "pattern": r"^INV-\d+$"}}],
        )
        assert report["ok"] is True

    def test_no_match_fails(self):
        report = _run(
            {"invoice": "xyz"},
            [{"regex": {"field": "invoice", "pattern": r"^INV-\d+$"}}],
        )
        assert report["ok"] is False

    def test_invalid_pattern_fails_loudly(self):
        report = _run(
            {"invoice": "abc"},
            [{"regex": {"field": "invoice", "pattern": "["}}],
        )
        assert report["ok"] is False
        assert "invalid pattern" in report["issues"][0]["message"]


# ── Meta / edge cases ───────────────────────────────────────────────


class TestValidationMeta:
    def test_no_rules_is_ok(self):
        report = validate_extracted({"a": 1}, {}).to_dict()
        assert report["ok"] is True
        assert report["issues"] == []

    def test_unknown_rule_name(self):
        report = _run({}, [{"does_not_exist": []}])
        assert report["ok"] is False
        assert report["issues"][0]["rule"] == "unknown"

    def test_malformed_rule_entry(self):
        report = _run({}, [{"required": ["a"], "extra": "bad"}])
        assert report["ok"] is False
        assert report["issues"][0]["rule"] == "malformed"

    def test_multiple_failures_collected(self):
        report = _run(
            {"a": None, "b": None},
            [{"required": ["a", "b"]}],
        )
        assert report["ok"] is False
        assert len(report["issues"]) == 2
