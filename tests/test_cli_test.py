"""Tests for the extraction regression test runner (comparison engine)."""

from __future__ import annotations

from pathlib import Path

from cli.test_runner import (
    FieldResult,
    FixtureResult,
    TestSuiteResult,
    compare_field,
    compare_results,
    discover_fixtures,
)

# ── Number tolerance ──────────────────────────────────────────────────


class TestNumberComparison:
    def test_exact_integers(self):
        r = compare_field("amount", 4250, 4250)
        assert r.passed

    def test_integer_vs_float_within_tolerance(self):
        r = compare_field("amount", 4250, 4250.00)
        assert r.passed

    def test_integer_vs_float_just_within_tolerance(self):
        r = compare_field("amount", 100, 100.01)
        assert r.passed

    def test_integer_vs_float_just_outside_tolerance(self):
        r = compare_field("amount", 100, 100.02)
        assert not r.passed

    def test_float_vs_float(self):
        r = compare_field("rate", 3.14, 3.14)
        assert r.passed

    def test_float_mismatch(self):
        r = compare_field("rate", 3.14, 3.20)
        assert not r.passed

    def test_string_number_vs_int(self):
        """String that looks like a number should be coerced."""
        r = compare_field("amount", "4250", 4250)
        assert r.passed

    def test_dollar_string_vs_number(self):
        r = compare_field("premium", "$4,250.00", 4250)
        assert r.passed

    def test_zero_values(self):
        r = compare_field("amount", 0, 0.0)
        assert r.passed

    def test_negative_numbers(self):
        r = compare_field("amount", -100, -100.005)
        assert r.passed


# ── Date normalization ────────────────────────────────────────────────


class TestDateComparison:
    def test_iso_dates_match(self):
        r = compare_field("date", "2025-03-15", "2025-03-15")
        assert r.passed

    def test_iso_date_padding(self):
        r = compare_field("date", "2025-3-5", "2025-03-05")
        assert r.passed

    def test_us_format_vs_iso(self):
        """MM/DD/YYYY should normalize to match YYYY-MM-DD."""
        r = compare_field("date", "03/15/2025", "2025-03-15")
        assert r.passed

    def test_iso_vs_us_format(self):
        r = compare_field("date", "2025-01-15", "01/15/2025")
        assert r.passed

    def test_date_mismatch(self):
        r = compare_field("date", "2025-03-15", "2025-03-16")
        assert not r.passed

    def test_both_us_format(self):
        r = compare_field("date", "01/15/2025", "01/15/2025")
        assert r.passed


# ── String comparison ─────────────────────────────────────────────────


class TestStringComparison:
    def test_exact_match(self):
        r = compare_field("name", "Acme Corp", "Acme Corp")
        assert r.passed

    def test_mismatch(self):
        r = compare_field("name", "Acme Corp", "Acme Corporation")
        assert not r.passed

    def test_case_insensitive(self):
        """Strings are compared case-insensitively — extracted text often
        preserves the source's casing, which is the same data."""
        r = compare_field("name", "Acme", "acme")
        assert r.passed

    def test_all_caps_matches_title_case(self):
        """Real-world scenario from invoice extraction."""
        r = compare_field("name", "Amazona Parts Supply Co.", "AMAZONA PARTS SUPPLY CO.")
        assert r.passed

    def test_leading_trailing_whitespace_ignored(self):
        r = compare_field("name", "Acme Corp", "  Acme Corp  ")
        assert r.passed

    def test_different_words_still_fail(self):
        r = compare_field("name", "Acme Inc", "Widget Inc")
        assert not r.passed

    def test_empty_string(self):
        r = compare_field("name", "", "")
        assert r.passed


# ── Missing fields ────────────────────────────────────────────────────


class TestMissingFields:
    def test_missing_from_actual(self):
        r = compare_field("invoice_number", "INV-001", None)
        assert not r.passed
        assert "missing" in r.detail

    def test_null_actual(self):
        r = compare_field("field", "expected_value", None)
        assert not r.passed


# ── Array comparison ──────────────────────────────────────────────────


class TestArrayComparison:
    def test_same_arrays(self):
        r = compare_field("items", [1, 2, 3], [1, 2, 3])
        assert r.passed

    def test_different_length(self):
        r = compare_field("items", [1, 2, 3], [1, 2])
        assert not r.passed
        assert "length" in r.detail

    def test_order_insensitive_objects(self):
        """Objects in arrays should match regardless of order."""
        expected = [
            {"name": "A", "value": 1},
            {"name": "B", "value": 2},
        ]
        actual = [
            {"name": "B", "value": 2},
            {"name": "A", "value": 1},
        ]
        r = compare_field("items", expected, actual)
        assert r.passed

    def test_different_object_content(self):
        expected = [{"name": "A", "value": 1}]
        actual = [{"name": "A", "value": 999}]
        r = compare_field("items", expected, actual)
        assert not r.passed

    def test_empty_arrays(self):
        r = compare_field("items", [], [])
        assert r.passed

    def test_string_arrays(self):
        r = compare_field("tags", ["a", "b"], ["b", "a"])
        assert r.passed

    def test_mixed_primitives(self):
        r = compare_field("tags", ["a", "b"], ["a", "c"])
        assert not r.passed

    def test_int_vs_float_in_objects(self):
        """Real bug from invoice corpus: expected 200.0, actual 200 (same value)."""
        expected = [{"name": "Workshop", "quantity": 8, "unit_price": 200.0, "amount": 1600.0}]
        actual = [{"name": "Workshop", "quantity": 8, "unit_price": 200, "amount": 1600}]
        r = compare_field("items", expected, actual)
        assert r.passed

    def test_string_case_in_object_values(self):
        """Case differences in string fields of array objects should pass."""
        expected = [{"name": "Acme Corp", "tier": "gold"}]
        actual = [{"name": "ACME CORP", "tier": "GOLD"}]
        r = compare_field("items", expected, actual)
        assert r.passed

    def test_date_format_in_object_values(self):
        """Different date formats in array object fields should still match."""
        expected = [{"item": "A", "date": "2025-01-15"}]
        actual = [{"item": "A", "date": "01/15/2025"}]
        r = compare_field("items", expected, actual)
        assert r.passed

    def test_number_string_vs_numeric_in_objects(self):
        """'$200.00' and 200 are the same value."""
        expected = [{"price": 200.0}]
        actual = [{"price": "$200.00"}]
        r = compare_field("items", expected, actual)
        assert r.passed


# ── Partial expectations ──────────────────────────────────────────────


class TestPartialExpectations:
    def test_extra_actual_fields_ignored(self):
        expected = {"name": "Acme", "amount": 100}
        actual = {"name": "Acme", "amount": 100, "extra_field": "ignored"}
        results = compare_results(expected, actual)
        assert all(r.passed for r in results)
        assert len(results) == 2  # Only expected fields checked

    def test_missing_expected_field_is_regression(self):
        expected = {"name": "Acme", "amount": 100}
        actual = {"name": "Acme"}
        results = compare_results(expected, actual)
        name_result = next(r for r in results if r.field_name == "name")
        amount_result = next(r for r in results if r.field_name == "amount")
        assert name_result.passed
        assert not amount_result.passed


# ── compare_results integration ───────────────────────────────────────


class TestCompareResults:
    def test_full_comparison(self):
        expected = {
            "invoice_number": "INV-001",
            "date": "2025-03-15",
            "total_amount": 4250,
            "vendor_name": "Acme Corp",
        }
        actual = {
            "invoice_number": "INV-001",
            "date": "2025-03-15",
            "total_amount": 4250.00,
            "vendor_name": "Acme Corp",
        }
        results = compare_results(expected, actual)
        assert all(r.passed for r in results)

    def test_mixed_pass_fail(self):
        expected = {"a": "hello", "b": 100}
        actual = {"a": "world", "b": 100}
        results = compare_results(expected, actual)
        a = next(r for r in results if r.field_name == "a")
        b = next(r for r in results if r.field_name == "b")
        assert not a.passed
        assert b.passed

    def test_empty_expected(self):
        results = compare_results({}, {"a": 1, "b": 2})
        assert results == []


# ── Fixture discovery ─────────────────────────────────────────────────


class TestFixtureDiscovery:
    def test_discovers_fixtures(self, tmp_path: Path):
        schema = tmp_path / "invoice.yaml"
        schema.write_text("name: invoice\nfields: {}")

        fixtures_dir = tmp_path / "invoice.fixtures"
        fixtures_dir.mkdir()
        (fixtures_dir / "sample_1.md").write_text("# Doc")
        (fixtures_dir / "sample_1.expected.json").write_text("{}")
        (fixtures_dir / "sample_2.md").write_text("# Doc 2")

        pairs = discover_fixtures(schema)
        assert len(pairs) == 2

        # sample_1 has an expected file
        assert pairs[0][0].name == "sample_1.md"
        assert pairs[0][1] is not None
        assert pairs[0][1].name == "sample_1.expected.json"

        # sample_2 has no expected file
        assert pairs[1][0].name == "sample_2.md"
        assert pairs[1][1] is None

    def test_no_fixtures_dir(self, tmp_path: Path):
        schema = tmp_path / "invoice.yaml"
        schema.write_text("name: invoice")
        assert discover_fixtures(schema) == []

    def test_empty_fixtures_dir(self, tmp_path: Path):
        schema = tmp_path / "invoice.yaml"
        schema.write_text("name: invoice")
        (tmp_path / "invoice.fixtures").mkdir()
        assert discover_fixtures(schema) == []

    def test_ignores_non_md_files(self, tmp_path: Path):
        schema = tmp_path / "invoice.yaml"
        schema.write_text("name: invoice")
        fixtures_dir = tmp_path / "invoice.fixtures"
        fixtures_dir.mkdir()
        (fixtures_dir / "notes.txt").write_text("not a fixture")
        (fixtures_dir / "sample.md").write_text("# Doc")
        pairs = discover_fixtures(schema)
        assert len(pairs) == 1
        assert pairs[0][0].name == "sample.md"


# ── Data classes ──────────────────────────────────────────────────────


class TestDataClasses:
    def test_fixture_result_counts(self):
        fr = FixtureResult(
            fixture_name="test.md",
            field_results=[
                FieldResult("a", passed=True),
                FieldResult("b", passed=True),
                FieldResult("c", passed=False),
            ],
        )
        assert fr.passed == 2
        assert fr.failed == 1

    def test_suite_result_totals(self):
        fr1 = FixtureResult(
            fixture_name="a.md",
            field_results=[
                FieldResult("x", passed=True),
                FieldResult("y", passed=False),
            ],
        )
        fr2 = FixtureResult(
            fixture_name="b.md",
            field_results=[
                FieldResult("x", passed=True),
            ],
        )
        suite = TestSuiteResult(schema_name="test", fixture_results=[fr1, fr2])
        assert suite.total_fixtures == 2
        assert suite.total_fields == 3
        assert suite.total_passed == 2
        assert suite.total_failed == 1
        assert not suite.all_passed

    def test_suite_all_passed(self):
        fr = FixtureResult(
            fixture_name="a.md",
            field_results=[FieldResult("x", passed=True)],
        )
        suite = TestSuiteResult(schema_name="test", fixture_results=[fr])
        assert suite.all_passed

    def test_suite_with_error_not_passed(self):
        fr = FixtureResult(fixture_name="a.md", error="server down")
        suite = TestSuiteResult(schema_name="test", fixture_results=[fr])
        assert not suite.all_passed

    def test_to_dict(self):
        fr = FixtureResult(
            fixture_name="a.md",
            field_results=[
                FieldResult("x", passed=True, expected="val", actual="val"),
            ],
        )
        suite = TestSuiteResult(schema_name="myschema", fixture_results=[fr])
        d = suite.to_dict()
        assert d["schema"] == "myschema"
        assert d["fixtures"] == 1
        assert d["passed"] == 1
        assert d["regressions"] == 0
        assert d["results"][0]["fixture"] == "a.md"
        assert d["results"][0]["fields"][0]["passed"] is True
