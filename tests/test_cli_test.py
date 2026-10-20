"""Tests for the extraction regression test runner (`koji test`'s engine room).

Comparison semantics are NOT tested here — they live in `@koji/score` and are
covered by `packages/score/src/compare.test.ts`. What lives in Python, and so
what this file covers, is:

* the anti-divergence guard (no comparison helper may creep back in),
* the payload handed to the scorer,
* how a scorer verdict is rendered as a human-readable detail line,
* aggregation over fields and fixtures,
* fixture discovery.

Plus one block (`TestScoringSemanticsEndToEnd`) that runs the **real** scorer to
pin the semantics `koji test` / `koji bench` now report, including the places
they deliberately disagree with the pre-0.120.0 Python engine.
"""

from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import patch

import pytest

from cli.score import _repo_root
from cli.test_runner import (
    FieldResult,
    FixtureResult,
    TestSuiteResult,
    compare_field,
    compare_results,
    discover_fixtures,
    warn_legacy_compare,
)

CLI_DIR = Path(__file__).parent.parent / "cli"


# ── The anti-divergence guard ─────────────────────────────────────────


def test_test_runner_does_not_reimplement_comparison():
    """`cli/test_runner.py` must delegate to `@koji/score`, not compare values.

    This file used to be a full second comparison engine that disagreed with
    the server's scorer by construction. The same guard protects `cli/score.py`
    (see `test_cli_score.py`); any of these names reappearing here means the
    divergence is back.
    """
    source = (CLI_DIR / "test_runner.py").read_text()
    banned = (
        "def _levenshtein",
        "def string_similarity",
        "def _normalize_date",
        "def _to_number",
        "def _is_empty",
        "def _normalize_value_for_compare",
        "def _dict_key_overlap",
        "def _array_of_dicts_similarity",
        "def _array_f1",
        "def _normalize_for_set_compare",
        "def _resolve_mapping",
    )
    offenders = [name for name in banned if name in source]
    assert not offenders, (
        "cli/test_runner.py must delegate to @koji/score, not compare values itself; found: " + ", ".join(offenders)
    )


# ── The payload handed to the scorer ──────────────────────────────────


def _stub_result(fields: dict, version: str = "9.9.9") -> dict:
    return {"scorer": "@koji/score", "scorer_version": version, "fields": fields}


def _match(score: float = 1.0) -> dict:
    return {"score": score, "match": True, "diff": {"kind": "scalar", "expected": "x", "got": "x", "match": True}}


def _miss(score: float = 0.0) -> dict:
    return {"score": score, "match": False, "diff": {"kind": "scalar", "expected": "x", "got": "y", "match": False}}


class TestScorerPayload:
    def test_scores_only_fields_present_in_expected(self):
        """Partial expectations: a key only in `actual` is not scored."""
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({"a": _match(), "b": _match()})
            results = compare_results({"a": 1, "b": 2}, {"a": 1, "b": 2, "ignored": 3})
        payload = run.call_args.args[0]
        assert set(payload["fields"]) == {"a", "b"}
        assert [r.field_name for r in results] == ["a", "b"]

    def test_missing_actual_key_is_sent_as_none(self):
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({"a": _miss()})
            compare_results({"a": "INV-1"}, {})
        assert run.call_args.args[0]["fields"]["a"] == {"expected": "INV-1", "got": None}

    def test_field_specs_are_forwarded_for_declared_fields_only(self):
        """The scorer needs the schema node to honour `match:`, `element_key`
        and informational sub-fields — but only for fields being scored."""
        schema = {
            "fields": {
                "a": {"type": "string", "match": "exact"},
                "unrelated": {"type": "number"},
            }
        }
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({"a": _match(), "b": _match()})
            compare_results({"a": "x", "b": "y"}, {"a": "x", "b": "y"}, schema)
        specs = run.call_args.args[0]["specs"]
        assert specs == {"a": {"type": "string", "match": "exact"}}

    def test_non_dict_fields_block_is_ignored(self):
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({"a": _match()})
            compare_results({"a": "x"}, {"a": "x"}, {"fields": "not a mapping"})
        assert run.call_args.args[0]["specs"] == {}

    def test_one_invocation_per_document(self):
        """A 40-field document costs one subprocess, not 40."""
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({f"f{i}": _match() for i in range(40)})
            compare_results({f"f{i}": i for i in range(40)}, {f"f{i}": i for i in range(40)})
        assert run.call_count == 1

    def test_empty_expected_never_calls_the_scorer(self):
        with patch("cli.test_runner.run_scorer") as run:
            assert compare_results({}, {"a": 1}) == []
        run.assert_not_called()

    def test_a_field_the_scorer_skipped_is_an_error_not_a_silent_pass(self):
        with patch("cli.test_runner.run_scorer") as run:
            run.return_value = _stub_result({"a": _match()})
            with pytest.raises(RuntimeError, match="no result for field 'b'"):
                compare_results({"a": 1, "b": 2}, {"a": 1, "b": 2})

    def test_scorer_failures_propagate(self):
        """Callers decide what to do with a dead scorer — bench records it as a
        per-document error — so this must not be swallowed here."""
        with patch("cli.test_runner.run_scorer", side_effect=FileNotFoundError("no node")):
            with pytest.raises(FileNotFoundError):
                compare_results({"a": 1}, {"a": 1})


# ── Rendering a verdict as a detail line ──────────────────────────────


def _detail_for(expected, actual, scored: dict) -> str:
    with patch("cli.test_runner.run_scorer", return_value=_stub_result({"f": scored})):
        return compare_field("f", expected, actual).detail


class TestDetailRendering:
    def test_a_match_has_no_detail(self):
        assert _detail_for("Acme", "ACME", _match()) == ""

    def test_both_absent_is_named_correctly_absent(self):
        """Adversarial fixtures assert a field should NOT be extracted; a pass
        there deserves to say why."""
        assert _detail_for(None, None, _match()) == "correctly absent"
        assert _detail_for(None, [], _match()) == "correctly absent"
        assert _detail_for("", None, _match()) == "correctly absent"

    def test_expected_absent_but_extracted_is_hallucination(self):
        detail = _detail_for(None, "Made Up Corp", _miss())
        assert "hallucinated" in detail
        assert "Made Up Corp" in detail

    def test_expected_present_but_absent_in_actual_is_missing(self):
        assert _detail_for("INV-001", None, _miss()) == "missing from actual"

    def test_absence_wording_wins_over_the_values_shape(self):
        """An `[]` expected against a populated array is a fabrication, not an
        interesting F1 — and the reverse is a miss. A trap corpus is read for
        exactly these two words, so they must not depend on the field's type."""
        array_diff = {
            "score": 0.0,
            "match": False,
            "diff": {"kind": "array", "expectedCount": 0, "gotCount": 1, "score": 0.0, "precision": 0.0, "recall": 1.0},
        }
        detail = _detail_for([], ["ghost"], array_diff)
        assert detail.startswith("hallucinated")
        assert "ghost" in detail
        assert _detail_for(["real"], [], array_diff) == "missing from actual"

    def test_scalar_mismatch_shows_both_values(self):
        detail = _detail_for("Acme Corp", "Widget Inc", _miss())
        assert "Acme Corp" in detail and "Widget Inc" in detail

    def test_array_length_mismatch_names_the_counts_and_f1(self):
        scored = {
            "score": 0.8,
            "match": False,
            "diff": {
                "kind": "array",
                "expectedCount": 3,
                "gotCount": 2,
                "score": 0.8,
                "precision": 1.0,
                "recall": 0.667,
            },
        }
        detail = _detail_for([1, 2, 3], [1, 2], scored)
        assert "length" in detail
        assert "expected 3, got 2" in detail
        assert "80% element F1" in detail
        assert "P 100% / R 67%" in detail

    def test_equal_length_array_mismatch_says_items_differ(self):
        scored = {
            "score": 0.5,
            "match": False,
            "diff": {"kind": "array", "expectedCount": 2, "gotCount": 2, "score": 0.5, "precision": 0.5, "recall": 0.5},
        }
        detail = _detail_for([1, 2], [1, 9], scored)
        assert "array items differ" in detail
        assert "length" not in detail

    def test_object_mismatch_names_the_offending_keys(self):
        scored = {
            "score": 0.5,
            "match": False,
            "diff": {"kind": "object", "score": 0.5, "fields": [{"key": "street"}]},
        }
        detail = _detail_for({"street": "100 Main"}, {"street": "200 Main"}, scored)
        assert "object differs on street" in detail
        assert "50% of keys matched" in detail

    def test_a_malformed_diff_does_not_crash_rendering(self):
        detail = _detail_for("a", "b", {"score": 0.0, "match": False, "diff": None})
        assert "expected 'a'" in detail


# ── Legacy `compare:` config ──────────────────────────────────────────


class TestLegacyCompareWarning:
    @pytest.fixture(autouse=True)
    def _forget_warned_schemas(self):
        """The notice is memoised per schema name for the life of the process,
        so these tests must not inherit another file's warnings."""
        import cli.test_runner as runner

        before = set(runner._warned_schemas)
        runner._warned_schemas.clear()
        try:
            yield
        finally:
            runner._warned_schemas.clear()
            runner._warned_schemas.update(before)

    def test_fuzzy_threshold_is_reported_as_ignored(self):
        """9 corpus schemas still declare it. Silently ignoring it would move
        their numbers with no explanation."""
        buf = io.StringIO()
        found = warn_legacy_compare({"name": "invoice_basic", "compare": {"fuzzy_threshold": 0.85}}, stream=buf)
        assert found == ["fuzzy_threshold"]
        text = buf.getvalue()
        assert "invoice_basic" in text
        assert "compare.fuzzy_threshold" in text
        assert "match:" in text

    def test_warns_once_per_schema(self):
        schema = {"name": "warn-once-demo", "compare": {"fuzzy_threshold": 0.7}}
        first, second = io.StringIO(), io.StringIO()
        warn_legacy_compare(schema, stream=first)
        warn_legacy_compare(schema, stream=second)
        assert first.getvalue() != ""
        assert second.getvalue() == ""

    def test_schema_without_a_compare_block_is_silent(self):
        buf = io.StringIO()
        assert warn_legacy_compare({"name": "x", "fields": {}}, stream=buf) == []
        assert buf.getvalue() == ""

    def test_tolerates_a_missing_or_malformed_schema(self):
        buf = io.StringIO()
        assert warn_legacy_compare(None, stream=buf) == []
        assert warn_legacy_compare({"compare": "nonsense"}, stream=buf) == []
        assert buf.getvalue() == ""


# ── End-to-end against the real scorer ────────────────────────────────


def _scorer_is_built() -> bool:
    """Is a local `@koji/score` build (or source + tsx) reachable?

    Deliberately does not accept the `npx` fallback — that would reach the
    network mid-test-run.
    """
    root = _repo_root()
    if root is None:
        return False
    return (root / "packages/score/dist/bin.js").is_file() or (root / "node_modules/.bin/koji-score").is_file()


requires_scorer = pytest.mark.skipif(
    not _scorer_is_built(),
    reason="needs a built @koji/score (`pnpm --filter @koji/score build`)",
)


@requires_scorer
class TestScoringSemanticsEndToEnd:
    """What `koji test` and `koji bench` now report, run through the real bin.

    These are the semantics of record. Where a case changed at 0.120.0 the
    docstring says what the old Python engine did, because a reader comparing
    an old run to a new one needs to know which cases moved.
    """

    def test_quantities_and_dates_still_compare_by_value(self):
        results = {
            r.field_name: r
            for r in compare_results(
                {"a": 4250, "b": "$4,250.00", "c": "03/15/2025", "d": "2025-3-5", "e": 100},
                {"a": 4250.00, "b": 4250, "c": "2025-03-15", "d": "2025-03-05", "e": 100.02},
            )
        }
        assert results["a"].passed
        assert results["b"].passed
        assert results["c"].passed
        assert results["d"].passed
        assert not results["e"].passed  # outside the 0.01 default tolerance

    def test_case_whitespace_and_punctuation_are_still_forgiven(self):
        results = {
            r.field_name: r
            for r in compare_results(
                {"a": "Acme", "b": "Acme Corp", "c": "CHARLOTTE, NC", "d": "704-376-9896"},
                {"a": "acme", "b": "  Acme Corp  ", "c": "CHARLOTTE NC", "d": "704.376.9896"},
            )
        }
        assert all(r.passed for r in results.values())

    def test_fuzzy_ocr_typos_now_fail(self):
        """CHANGED at 0.120.0. The Python engine accepted these at
        `compare.fuzzy_threshold: 0.85` via Levenshtein similarity. The scorer
        has no fuzzy mode: a one-character content difference is a difference.
        A schema that wants latitude declares it per field with `match:`."""
        r = compare_field("name", "TEO HENG STATIONERY", "TED HENG STATIONERY")
        assert not r.passed
        assert r.weighted_score == 0.0

    def test_declared_contains_replaces_fuzzy_for_wrapper_text(self):
        strict = compare_field("governing_law", "State of Delaware", "Delaware")
        assert not strict.passed
        loose = compare_field(
            "governing_law",
            "State of Delaware",
            "Delaware",
            {"fields": {"governing_law": {"type": "string", "match": "contains"}}},
        )
        assert loose.passed

    def test_declared_exact_tightens_a_field(self):
        assert compare_field("policy_number", "ABC-1", "abc 1").passed
        r = compare_field(
            "policy_number",
            "ABC-1",
            "abc 1",
            {"fields": {"policy_number": {"type": "string", "match": "exact"}}},
        )
        assert not r.passed

    def test_declared_numeric_fails_an_unparseable_value(self):
        spec = {"fields": {"premium": {"type": "number", "match": {"mode": "numeric", "tolerance": 0.5}}}}
        assert compare_field("premium", 1000, 1000.4, spec).passed
        assert not compare_field("premium", 1000, "n/a", spec).passed

    def test_declared_enum_resolves_mappings(self):
        spec = {
            "fields": {
                "form_type": {
                    "type": "string",
                    "match": "enum",
                    "mappings": {"10-K/A": ["10K/A", "10-KA"]},
                }
            }
        }
        assert compare_field("form_type", "10-K/A", "10-KA", spec).passed
        assert not compare_field("form_type", "10-K/A", "10-Q", spec).passed

    def test_an_unknown_match_mode_fails_the_run(self):
        """A typo must not silently revert to the default."""
        with pytest.raises(RuntimeError, match="unknown match mode"):
            compare_field("f", "a", "a", {"fields": {"f": {"match": "noramlized"}}})

    def test_arrays_earn_partial_credit_and_report_precision_recall(self):
        r = compare_field("tags", ["a", "b", "c"], ["a", "b"])
        assert not r.passed
        assert abs(r.weighted_score - 0.8) < 1e-6  # P 1.0, R 2/3
        r = compare_field("tags", ["a", "b", "c"], ["a", "b", "c", "z"])
        assert abs(r.weighted_score - (2 * 1.0 * 0.75 / 1.75)) < 1e-6

    def test_arrays_are_order_insensitive(self):
        assert compare_field("tags", ["a", "b"], ["b", "a"]).passed
        assert compare_field(
            "items",
            [{"name": "A", "value": 1}, {"name": "B", "value": 2}],
            [{"name": "B", "value": 2}, {"name": "A", "value": 1}],
        ).passed

    def test_array_of_objects_scores_sub_field_credit(self):
        exp = [{"code": c, "limit": 100} for c in "abcd"] + [{"code": "e", "limit": 500}]
        act = [{"code": c, "limit": 100} for c in "abcd"] + [{"code": "e", "limit": 999}]
        r = compare_field("coverages", exp, act)
        assert not r.passed
        assert 0.8 < r.weighted_score < 1.0

    def test_element_key_pins_identity_instead_of_best_overlap(self):
        """Declared `element_key` makes a wrong sub-field a wrong element rather
        than a mispairing — one of the reasons the unified scorer is not
        reproducible by the old Python engine, which had no such concept."""
        spec = {
            "fields": {
                "coverages": {
                    "type": "array",
                    "hints": {"element_key": "code"},
                    "items": {"properties": {"code": {}, "limit": {}}},
                }
            }
        }
        exp = [{"code": "gl", "limit": 100}, {"code": "auto", "limit": 200}]
        act = [{"code": "gl", "limit": 100}, {"code": "umbrella", "limit": 200}]
        r = compare_field("coverages", exp, act, spec)
        assert not r.passed
        assert 0.0 < r.weighted_score < 1.0

    def test_informational_sub_fields_are_excluded(self):
        spec = {
            "fields": {
                "coverages": {
                    "type": "array",
                    "items": {"properties": {"code": {}, "note": {"hints": {"informational": True}}}},
                }
            }
        }
        exp = [{"code": "gl", "note": "see page 3"}]
        act = [{"code": "gl", "note": "whatever"}]
        assert compare_field("coverages", exp, act, spec).passed

    def test_provenance_keys_do_not_penalise_an_element(self):
        exp = [{"coverage": "each_occurrence", "limit": 1000000}]
        act = [
            {
                "coverage": "each_occurrence",
                "limit": 1000000,
                "__source_text": "Each Occurrence $1,000,000",
                "__source_context": "Limits of Insurance",
            }
        ]
        assert compare_field("coverages", exp, act).passed

    def test_empty_and_null_are_the_same_absence(self):
        """`[]` from extraction and `null` in ground truth both mean 'no data'.
        Scoring them as a mismatch would invent a failure out of a
        representation difference and break every adversarial fixture whose
        model correctly declined with an empty array."""
        for expected, actual in ((None, []), ([], None), (None, {}), ({}, None), (None, ""), ([], [])):
            assert compare_field("items", expected, actual).passed, (expected, actual)

    def test_absence_on_one_side_only_still_fails(self):
        assert not compare_field("items", None, [{"name": "ghost"}]).passed
        assert not compare_field("items", [{"name": "real"}], []).passed
        assert not compare_field("items", {}, {"a": 1}).passed

    def test_objects_score_the_mean_of_their_keys(self):
        """CHANGED at 0.120.0: an object-valued field used to be pass/fail.
        Now a half-right address scores 0.5."""
        r = compare_field(
            "address", {"street": "100 Main St", "city": "Charlotte"}, {"street": "200 Main St", "city": "Charlotte"}
        )
        assert not r.passed
        assert abs(r.weighted_score - 0.5) < 1e-6
        assert compare_field(
            "address", {"street": "100 Main St", "city": "Charlotte"}, {"city": "Charlotte", "street": "100 Main St"}
        ).passed

    def test_the_bin_and_the_python_stamp_agree_on_the_version(self):
        """`cli/metrics.scorer_version()` reads package.json; the bin reports
        its own literal. A drift between them would stamp artifacts with a
        version that did not score them."""
        from cli.metrics import scorer_version
        from cli.score import run_scorer

        result = run_scorer({"fields": {"a": {"expected": 1, "got": 1}}})
        assert result["scorer"] == "@koji/score"
        assert result["scorer_version"] == scorer_version()


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

    def test_partial_credit_reaches_the_metrics(self):
        """A 4-of-5 array contributes ~0.8 of credit and 0 exact matches, so
        `value_accuracy` lands between the two readings."""
        fr = FixtureResult(
            fixture_name="a.md",
            field_results=[
                FieldResult("carrier", passed=True, expected="Acme", actual="Acme", score=1.0),
                FieldResult("coverages", passed=False, expected=[1, 2], actual=[1], score=0.8),
            ],
        )
        suite = TestSuiteResult(schema_name="test", fixture_results=[fr])
        counts = suite.metric_counts
        assert suite.total_passed == 1
        assert counts.found == 2
        assert abs(counts.credit - 1.8) < 1e-9
        assert abs(suite.to_dict()["metrics"]["value_accuracy"] - 0.9) < 1e-6

    def test_weighted_score_falls_back_to_the_boolean(self):
        assert FieldResult("x", passed=True).weighted_score == 1.0
        assert FieldResult("x", passed=False).weighted_score == 0.0
        assert FieldResult("x", passed=False, score=0.25).weighted_score == 0.25

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
                FieldResult("x", passed=True, expected="val", actual="val", score=1.0),
                FieldResult("y", passed=False, expected=[1, 2], actual=[1], score=0.67, detail="array length"),
            ],
        )
        suite = TestSuiteResult(schema_name="myschema", fixture_results=[fr])
        d = suite.to_dict()
        assert d["schema"] == "myschema"
        assert d["fixtures"] == 1
        assert d["passed"] == 1
        assert d["regressions"] == 1
        assert d["scorer"] == "@koji/score"
        assert d["scorer_version"]
        assert d["results"][0]["fixture"] == "a.md"
        assert d["results"][0]["fields"][0]["passed"] is True
        # Per-field fractional credit, new in 0.120.0.
        assert d["results"][0]["fields"][1]["score"] == 0.67
