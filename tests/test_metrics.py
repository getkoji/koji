"""Tests for the four reported metrics and the scorer stamp (oss-523, oss-525).

The metrics replace a single accuracy number that folded "correctly absent"
into itself, which gave a document that extracted nothing a non-zero floor.
These tests pin the floor at zero and pin the Python classification to the
TypeScript scorer's, since the two produce numbers people compare.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from cli.bench import BenchResult, CategoryBenchResult, DocumentBenchResult
from cli.metrics import (
    MetricCounts,
    bucket_of,
    counts_from_field_results,
    has_value,
    metrics_from_counts,
    require_comparable_scorer,
    scorer_stamp,
    scorer_version,
    versions_comparable,
)

# Aliased: pytest would try to collect a class named `Test*` as a test suite.
from cli.test_runner import FieldResult, FixtureResult
from cli.test_runner import TestSuiteResult as SuiteResult

REPO_ROOT = Path(__file__).resolve().parent.parent


def _field(name: str, expected, actual, passed: bool, score: float | None = None) -> FieldResult:
    return FieldResult(field_name=name, passed=passed, expected=expected, actual=actual, score=score)


# ── The presence predicate ────────────────────────────────────────────


class TestHasValue:
    @pytest.mark.parametrize("value", [None, "", "   ", "\n", [], {}, ()])
    def test_every_shape_of_no_data_is_absent(self, value):
        assert has_value(value) is False

    def test_a_dict_of_only_provenance_metadata_is_absent(self):
        # The model attaches `__source_text` inline. A field carrying only
        # those was declined, not extracted — reading it as a value would turn
        # every correctly-declined object field into a fabrication.
        assert has_value({"__source_text": "page 2"}) is False
        assert has_value({"__source_text": "page 2", "limit": "1000"}) is True

    def test_falsy_but_real_values_are_present(self):
        # 0 and False are answers. A correct "zero deductible" must not score
        # as a miss.
        assert has_value(0) is True
        assert has_value(False) is True

    @pytest.mark.parametrize("value", ["x", [None], {"a": 1}, 1.5])
    def test_non_empty_values_are_present(self, value):
        assert has_value(value) is True


class TestBucketOf:
    @pytest.mark.parametrize(
        "expected,actual,bucket",
        [
            ("ABC-1", "abc 1", "found"),
            ("PA", "LA", "found"),  # found but wrong — presence and value are separate
            ("ABC-1", None, "missed"),
            ("ABC-1", "", "missed"),
            ([{"a": 1}], [], "missed"),
            (None, "ABC-1", "fabricated"),
            ([], [{"a": 1}], "fabricated"),
            (None, None, "agreed"),
            (None, [], "agreed"),
            ("", "  ", "agreed"),
        ],
    )
    def test_classification(self, expected, actual, bucket):
        assert bucket_of(expected, actual) == bucket


# ── The four metrics ──────────────────────────────────────────────────


class TestMetrics:
    def test_a_document_that_extracts_nothing_scores_zero_presence_recall(self):
        """The all-null floor, gone.

        Seven fields; three legitimately empty in ground truth. The single
        folded number counted those three as passes and reported 3/7 = 42.9%
        for an extraction that produced nothing at all.
        """
        fields = [
            _field("filer_name", "Acme Corp", None, False),
            _field("form_type", "10-K", None, False),
            _field("filing_date", "2026-03-26", None, False),
            _field("total_assets", 1250, None, False),
            _field("auditor", None, None, True),
            _field("restatement", None, None, True),
            _field("subsidiary", None, None, True),
        ]
        m = metrics_from_counts(counts_from_field_results(fields))

        assert m["presence_recall"] == 0.0
        # Nothing was produced, so there is no population to judge accuracy over.
        assert m["value_accuracy"] is None
        assert m["fabrication_rate"] == 0.0
        assert m["null_agreement"] == 1.0
        assert m["counts"]["present"] == 4
        assert m["counts"]["missed"] == 4
        assert m["counts"]["agreed"] == 3

        # And the number it replaces, for contrast: the legacy pass ratio reads
        # 42.9% for the exact same (empty) extraction.
        legacy = sum(1 for f in fields if f.passed) / len(fields)
        assert legacy == pytest.approx(3 / 7)

    def test_adding_correctly_empty_fields_cannot_lift_a_metric(self):
        bare = [_field("a", "x", None, False)]
        padded = bare + [_field(n, None, None, True) for n in "bcdef"]
        assert metrics_from_counts(counts_from_field_results(bare))["presence_recall"] == 0.0
        m = metrics_from_counts(counts_from_field_results(padded))
        assert m["presence_recall"] == 0.0
        assert m["value_accuracy"] is None
        assert m["null_agreement"] == 1.0

    def test_presence_and_value_are_separate_questions(self):
        fields = [
            _field("a", "PA", "LA", False),  # produced, wrong
            _field("b", "NC", "NC", True),  # produced, right
            _field("c", "SC", None, False),  # not produced
        ]
        m = metrics_from_counts(counts_from_field_results(fields))
        assert m["presence_recall"] == pytest.approx(2 / 3)
        assert m["value_accuracy"] == pytest.approx(1 / 2)

    def test_value_accuracy_uses_array_partial_credit(self):
        fields = [_field("rows", [{"k": "a"}, {"k": "b"}], [{"k": "a"}], False, score=0.666667)]
        m = metrics_from_counts(counts_from_field_results(fields))
        assert m["presence_recall"] == 1.0
        assert m["value_accuracy"] == pytest.approx(0.666667)

    def test_fabrication_rate_and_null_agreement_are_complements(self):
        fields = [
            _field("a", None, "invented", False),
            _field("b", None, None, True),
            _field("c", None, None, True),
            _field("d", None, None, True),
            _field("e", "real", "real", True),
        ]
        m = metrics_from_counts(counts_from_field_results(fields))
        assert m["fabrication_rate"] == pytest.approx(0.25)
        assert m["null_agreement"] == pytest.approx(0.75)
        assert m["fabrication_rate"] + m["null_agreement"] == pytest.approx(1.0)
        # Fabrication must not touch the present-field metrics.
        assert m["presence_recall"] == 1.0
        assert m["value_accuracy"] == 1.0

    def test_an_untested_population_reports_none_not_zero(self):
        # Reporting 0 for a fabrication rate nothing measured reads as "it
        # never fabricates" — the substitution that let the old number claim
        # 100% for scoring nothing.
        only_present = metrics_from_counts(counts_from_field_results([_field("a", "x", "x", True)]))
        assert only_present["fabrication_rate"] is None
        assert only_present["null_agreement"] is None

        only_absent = metrics_from_counts(counts_from_field_results([_field("a", None, None, True)]))
        assert only_absent["presence_recall"] is None
        assert only_absent["value_accuracy"] is None

        nothing = metrics_from_counts(MetricCounts())
        assert all(
            nothing[k] is None for k in ("presence_recall", "value_accuracy", "fabrication_rate", "null_agreement")
        )

    def test_counts_partition_every_field_exactly_once(self):
        fields = [
            _field("a", "x", "x", True),
            _field("b", "y", "wrong", False),
            _field("c", "z", None, False),
            _field("d", None, "made up", False),
            _field("e", None, None, True),
        ]
        c = counts_from_field_results(fields)
        assert c.present + c.absent == len(fields)
        assert c.found + c.missed == c.present
        assert c.fabricated + c.agreed == c.absent

    def test_counts_are_additive_so_slices_roll_up(self):
        a = counts_from_field_results([_field("a", "x", "x", True), _field("b", "y", None, False)])
        b = counts_from_field_results([_field("a", None, "z", False)])
        a.merge(b)
        m = metrics_from_counts(a)
        assert m["presence_recall"] == pytest.approx(0.5)
        assert m["value_accuracy"] == 1.0
        assert m["fabrication_rate"] == 1.0


# ── Artifact stamping ─────────────────────────────────────────────────


class TestArtifactStamp:
    def test_scorer_version_comes_from_the_package(self):
        pkg = json.loads((REPO_ROOT / "packages" / "score" / "package.json").read_text())
        assert scorer_version() == pkg["version"]
        assert scorer_stamp() == {"scorer": "@koji/score", "scorer_version": pkg["version"]}

    def test_bench_artifact_carries_the_stamp_and_the_four_metrics(self):
        doc = DocumentBenchResult(
            document_name="filing.md",
            category="filings",
            schema_name="filing_metadata",
            field_results=[
                _field("filer_name", "Acme Corp", None, False),
                _field("form_type", "10-K", "10-K", True),
                _field("auditor", None, None, True),
                _field("restatement", None, "invented", False),
            ],
        )
        result = BenchResult(
            model="openai/gpt-4o-mini",
            corpus_path="/corpus",
            category_results=[CategoryBenchResult(category="filings", document_results=[doc])],
        )
        artifact = result.to_dict()

        assert artifact["scorer"] == "@koji/score"
        assert artifact["scorer_version"] == scorer_version()
        m = artifact["metrics"]
        assert m["presence_recall"] == pytest.approx(0.5)
        assert m["value_accuracy"] == 1.0
        assert m["fabrication_rate"] == pytest.approx(0.5)
        assert m["null_agreement"] == pytest.approx(0.5)
        # And at every level a reader might slice on.
        assert artifact["categories"][0]["metrics"]["presence_recall"] == pytest.approx(0.5)
        assert artifact["categories"][0]["documents_detail"][0]["metrics"]["presence_recall"] == pytest.approx(0.5)

    def test_bench_all_null_extraction_reports_zero_presence_recall(self):
        """End to end through the artifact: nothing extracted ⇒ 0, not a floor."""
        doc = DocumentBenchResult(
            document_name="blank.md",
            category="adversarial",
            schema_name="filing_metadata",
            field_results=[
                _field("a", "Acme Corp", None, False),
                _field("b", "10-K", None, False),
                _field("c", None, None, True),
                _field("d", None, None, True),
            ],
        )
        artifact = BenchResult(
            model="m",
            corpus_path="/corpus",
            category_results=[CategoryBenchResult(category="adversarial", document_results=[doc])],
        ).to_dict()

        assert artifact["metrics"]["presence_recall"] == 0.0
        # The legacy number, retained for continuity, still shows the floor —
        # which is exactly why `metrics` exists next to it.
        assert artifact["accuracy"] == pytest.approx(0.5)

    def test_test_suite_artifact_carries_the_stamp_and_the_four_metrics(self):
        suite = SuiteResult(
            schema_name="filing_metadata",
            fixture_results=[
                FixtureResult(
                    fixture_name="blank",
                    field_results=[
                        _field("a", "Acme Corp", None, False),
                        _field("b", None, None, True),
                    ],
                )
            ],
        )
        artifact = suite.to_dict()
        assert artifact["scorer_version"] == scorer_version()
        assert artifact["metrics"]["presence_recall"] == 0.0
        assert artifact["metrics"]["null_agreement"] == 1.0


# ── Cross-version comparison ──────────────────────────────────────────


class TestVersionGuard:
    def test_identical_versions_are_comparable(self):
        assert versions_comparable("0.2.0", "0.2.0") is True

    def test_a_patch_apart_is_not_comparable(self):
        # A date-parsing bug fix is a patch, and it moves numbers — which is
        # precisely the case the guard exists to catch.
        assert versions_comparable("0.2.0", "0.2.1") is False
        assert versions_comparable("0.1.0", "0.2.0") is False

    @pytest.mark.parametrize("found", [None, "", "unknown"])
    def test_an_unrecorded_version_is_never_comparable(self, found):
        assert versions_comparable(found, "0.2.0") is False

    def test_require_comparable_passes_for_the_current_scorer(self):
        require_comparable_scorer(scorer_version(), "baseline run")

    def test_require_comparable_refuses_across_versions_and_names_both(self):
        with pytest.raises(ValueError) as exc:
            require_comparable_scorer("0.0.1", "baseline artifact")
        assert "0.0.1" in str(exc.value)
        assert "baseline artifact" in str(exc.value)
        assert "not comparable" in str(exc.value)

    def test_require_comparable_refuses_an_unstamped_artifact(self):
        with pytest.raises(ValueError, match="unrecorded scorer version"):
            require_comparable_scorer(None)


# ── Agreement with the TypeScript scorer ──────────────────────────────


def _scorer_argv() -> list[str] | None:
    """The argv that runs `koji-score`, or None when it can't run here."""
    from cli.score import resolve_scorer

    try:
        return resolve_scorer()
    except FileNotFoundError:
        return None


class TestAgreementWithTheScorer:
    """`cli/metrics.py` must bucket fields exactly as `@koji/score` does.

    Both produce numbers that get compared to each other — a benchmark
    artifact against a validate run — so a disagreement about what counts as
    "a value" is a disagreement about the metric. Skipped where node isn't
    available rather than silently unverified.
    """

    CASES = [
        ("found", "ABC-1", "abc 1"),
        ("found", "PA", "LA"),
        ("missed", "ABC-1", None),
        ("missed", "ABC-1", ""),
        ("missed", [{"a": 1}], []),
        ("fabricated", None, "ABC-1"),
        ("fabricated", [], [{"a": 1}]),
        ("fabricated", None, {"a": 1}),
        ("agreed", None, None),
        ("agreed", None, []),
        ("agreed", "", "  "),
        ("agreed", None, {"__source_text": "p2"}),
        ("found", 0, 0),
        ("found", False, False),
    ]

    def test_buckets_agree_field_for_field(self):
        argv = _scorer_argv()
        if argv is None:
            pytest.skip("koji-score is not runnable here (no node / no build)")

        payload = {"fields": {f"f{i}": {"expected": exp, "got": got} for i, (_, exp, got) in enumerate(self.CASES)}}
        env = {**os.environ}
        env.pop("FORCE_COLOR", None)
        proc = subprocess.run(argv, input=json.dumps(payload), capture_output=True, text=True, timeout=120, env=env)
        if proc.returncode != 0:
            pytest.skip(f"koji-score could not run here: {proc.stderr.strip()}")
        out = json.loads(proc.stdout)

        for i, (want, exp, got) in enumerate(self.CASES):
            ts_bucket = out["fields"][f"f{i}"]["bucket"]
            py_bucket = bucket_of(exp, got)
            assert ts_bucket == want, f"scorer bucketed ({exp!r}, {got!r}) as {ts_bucket}, expected {want}"
            assert py_bucket == ts_bucket, f"python bucketed ({exp!r}, {got!r}) as {py_bucket}, scorer said {ts_bucket}"

    def test_metrics_agree_on_an_all_null_extraction(self):
        """The floor case, computed by both implementations."""
        argv = _scorer_argv()
        if argv is None:
            pytest.skip("koji-score is not runnable here (no node / no build)")

        fields = [
            ("filer_name", "Acme Corp", None),
            ("form_type", "10-K", None),
            ("filing_date", "2026-03-26", None),
            ("total_assets", 1250, None),
            ("auditor", None, None),
            ("restatement", None, None),
            ("subsidiary", None, None),
        ]
        payload = {"fields": {n: {"expected": e, "got": g} for n, e, g in fields}}
        proc = subprocess.run(argv, input=json.dumps(payload), capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            pytest.skip(f"koji-score could not run here: {proc.stderr.strip()}")
        ts = json.loads(proc.stdout)["metrics"]

        py = metrics_from_counts(
            counts_from_field_results([_field(n, e, g, bucket_of(e, g) == "agreed") for n, e, g in fields])
        )
        assert ts["presence_recall"] == 0
        for key in ("presence_recall", "value_accuracy", "fabrication_rate", "null_agreement"):
            assert ts[key] == py[key], f"{key}: scorer {ts[key]!r} vs python {py[key]!r}"
