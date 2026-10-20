"""Extraction regression test runner — fixture discovery, scoring, reporting.

Scoring is NOT implemented here. There is ONE scorer, and it lives in
`@koji/score` (TypeScript); this module shapes a payload for it, calls it
through `cli.score.run_scorer`, and renders the result for `koji test`,
`koji bench`, and `koji pipeline-bench`.

Until 0.120.0 this file carried a second, independent comparison engine — its
own Levenshtein string similarity, date parser, number coercion, emptiness
rule, and array-of-dicts structural similarity. It disagreed with the scorer
the server uses *by construction*: it decided pass/fail with fuzzy string
similarity where the scorer scores a continuous [0,1] with F1-weighted arrays
and `element_key` element matching. Two different numbers for the same run on
the same corpus is the divergence `@koji/score` exists to end, so the engine is
gone and this module delegates.

Consequences worth knowing:

- Tolerance is **declared, not guessed**. The scorer reads a per-field `match:`
  policy (`exact | normalized | contains | numeric | date | enum`) from the
  schema; `normalized` is the default and is what every field gets unless the
  schema says otherwise. A schema's legacy `compare: fuzzy_threshold` block is
  ignored, and saying so out loud is the job of `warn_legacy_compare` below.
- Every field carries a fractional `score`, not just arrays. Objects score the
  mean of their scored keys; scalars are still 1.0 / 0.0.
- Scoring needs `node` and the built scorer (or `npx`). `koji test` and
  `koji bench` surface a missing scorer as a per-fixture / per-document error
  with a fixable message rather than crashing mid-run.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .metrics import MetricCounts, counts_from_field_results, metrics_from_counts, scorer_stamp
from .score import run_scorer

# Keys of the pre-0.120.0 `compare:` block that the unified scorer has no
# equivalent for. Declaring one used to move the numbers; now it does nothing,
# so it earns a one-line notice rather than silent indifference.
_LEGACY_COMPARE_KEYS = ("fuzzy_threshold",)

#: Schemas already warned about, so a 1000-document bench prints one line per
#: schema instead of one per document.
_warned_schemas: set[str] = set()


@dataclass
class FieldResult:
    """Result of comparing a single field."""

    field_name: str
    passed: bool
    expected: Any = None
    actual: Any = None
    detail: str = ""
    # Partial credit in [0,1] from the scorer. None means "derive from
    # `passed`" (1.0/0.0) — the case for hand-built results and for fields that
    # never reached the scorer. Consumers that want partial credit read
    # `weighted_score`; `passed` stays a strict boolean so exact-match counts
    # and displays are unchanged.
    score: float | None = None

    @property
    def weighted_score(self) -> float:
        """Partial-credit score in [0,1]: the explicit `score` if set, else the
        boolean `passed` as 1.0/0.0."""
        if self.score is not None:
            return self.score
        return 1.0 if self.passed else 0.0


@dataclass
class FixtureResult:
    """Result of running one fixture."""

    fixture_name: str
    field_results: list[FieldResult] = field(default_factory=list)
    error: str | None = None

    @property
    def passed(self) -> int:
        return sum(1 for r in self.field_results if r.passed)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.field_results if not r.passed)


@dataclass
class TestSuiteResult:
    """Result of running all fixtures for a schema."""

    schema_name: str
    fixture_results: list[FixtureResult] = field(default_factory=list)

    @property
    def total_fixtures(self) -> int:
        return len(self.fixture_results)

    @property
    def total_fields(self) -> int:
        return sum(len(f.field_results) for f in self.fixture_results)

    @property
    def total_passed(self) -> int:
        return sum(f.passed for f in self.fixture_results)

    @property
    def total_failed(self) -> int:
        return sum(f.failed for f in self.fixture_results)

    @property
    def all_passed(self) -> bool:
        return self.total_failed == 0 and all(f.error is None for f in self.fixture_results)

    @property
    def metric_counts(self) -> MetricCounts:
        """Presence / fabrication counts across every fixture (oss-523)."""
        total = MetricCounts()
        for fr in self.fixture_results:
            total.merge(counts_from_field_results(fr.field_results))
        return total

    def to_dict(self) -> dict:
        """Machine-readable JSON output.

        `passed` counts a correctly-absent field as a pass, so `passed /
        fields_checked` has an all-null floor — a schema whose fixtures are
        mostly "this field must NOT be extracted" scores well for extracting
        nothing. `metrics` splits that into the four numbers that don't
        (oss-523); `scorer_version` says which scorer produced them (oss-525).
        """
        return {
            "schema": self.schema_name,
            **scorer_stamp(),
            "fixtures": self.total_fixtures,
            "fields_checked": self.total_fields,
            "passed": self.total_passed,
            "regressions": self.total_failed,
            "metrics": metrics_from_counts(self.metric_counts),
            "results": [
                {
                    "fixture": fr.fixture_name,
                    "error": fr.error,
                    "fields": [
                        {
                            "field": r.field_name,
                            "passed": r.passed,
                            # Fractional credit from the scorer. A 4-of-5 array
                            # is not the same result as an empty one, and only
                            # this number says so.
                            "score": round(r.weighted_score, 4),
                            "expected": r.expected,
                            "actual": r.actual,
                            "detail": r.detail,
                        }
                        for r in fr.field_results
                    ],
                }
                for fr in self.fixture_results
            ],
        }


# ── Legacy config notices ─────────────────────────────────────────────


def warn_legacy_compare(schema_def: dict | None, stream: Any = None) -> list[str]:
    """Report (once per schema) any legacy `compare:` keys that are now ignored.

    Returns the keys found, so callers can assert on it. Writes to stderr, not
    stdout, so `--json` output stays machine-readable.
    """
    if not isinstance(schema_def, dict):
        return []
    compare = schema_def.get("compare")
    if not isinstance(compare, dict):
        return []
    stale = sorted(k for k in _LEGACY_COMPARE_KEYS if k in compare)
    if not stale:
        return []

    name = str(schema_def.get("name") or "<unnamed schema>")
    memo = f"{name}:{','.join(stale)}"
    if memo not in _warned_schemas:
        _warned_schemas.add(memo)
        keys = ", ".join(f"compare.{k}" for k in stale)
        print(
            f"warning: schema {name!r} declares {keys}, which the scorer ignores. "
            "Fuzzy string similarity is gone — declare per-field tolerance with "
            "`match:` instead (see docs/schema-guide.md, 'Scoring equivalence').",
            file=stream or sys.stderr,
        )
    return stale


# ── Rendering the scorer's verdict ────────────────────────────────────


def _absent(value: Any) -> bool:
    """Is this value 'no data' in the shapes ground truth and extraction use?

    Presentation only — it picks the *wording* of a detail line ("correctly
    absent" / "hallucinated" / "missing from actual"). The verdict itself
    always comes from the scorer, never from here.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def _pct(value: Any) -> str:
    try:
        return f"{float(value):.0%}"
    except (TypeError, ValueError):
        return "?"


def _detail(expected: Any, actual: Any, scored: dict) -> str:
    """Human-readable explanation of one scored field, from the scorer's diff."""
    match = bool(scored.get("match"))
    raw_diff = scored.get("diff")
    diff = raw_diff if isinstance(raw_diff, dict) else {}
    kind = diff.get("kind")

    if match:
        # The adversarial-corpus case: the fixture says the field is not in the
        # document and extraction agreed. Worth naming, so a passing run shows
        # *why* it passed.
        if _absent(expected) and _absent(actual):
            return "correctly absent"
        return ""

    # Which side was empty decides the wording before the value's shape does.
    # "hallucinated" and "missing" are the two failure modes a trap corpus is
    # built to measure, and they read the same whether the field is a scalar,
    # an array or an object — an `[]` expected against a populated array is
    # still a fabrication, not an interesting F1.
    if _absent(expected) and not _absent(actual):
        return f"hallucinated: expected null, got {actual!r}"
    if _absent(actual) and not _absent(expected):
        return "missing from actual"

    if kind == "array":
        shape = f"{_pct(diff.get('score'))} element F1, P {_pct(diff.get('precision'))} / R {_pct(diff.get('recall'))}"
        exp_n, got_n = diff.get("expectedCount"), diff.get("gotCount")
        if exp_n != got_n:
            return f"array length: expected {exp_n}, got {got_n} ({shape})"
        return f"array items differ ({shape})"

    if kind == "object":
        keys = [f.get("key") for f in (diff.get("fields") or []) if isinstance(f, dict)]
        named = ", ".join(str(k) for k in keys if k)
        where = f" on {named}" if named else ""
        return f"object differs{where} ({_pct(diff.get('score'))} of keys matched)"

    return f"expected {expected!r}, got {actual!r}"


# ── Scoring ───────────────────────────────────────────────────────────


def compare_results(
    expected: dict,
    actual: dict,
    schema_def: dict | None = None,
) -> list[FieldResult]:
    """Score expected fields against actual extraction output, via `@koji/score`.

    Only fields present in *expected* are scored (partial expectations); fields
    in *actual* but not in *expected* are ignored. One scorer invocation covers
    the whole document.

    When ``schema_def`` is provided, each field's spec is forwarded so the
    scorer can apply the declared `match:` policy, match array elements by
    `hints.element_key`, and skip sub-fields marked `hints.informational`.

    Raises:
        FileNotFoundError: the scorer could not be located (the message says
            how to fix it).
        RuntimeError: the scorer ran but failed, or answered with something
            other than a result for every field.
    """
    warn_legacy_compare(schema_def)

    if not expected:
        return []

    fields_spec = (schema_def or {}).get("fields")
    if not isinstance(fields_spec, dict):
        fields_spec = {}

    names = list(expected)
    payload = {
        "fields": {name: {"expected": expected[name], "got": actual.get(name)} for name in names},
        "specs": {name: fields_spec[name] for name in names if isinstance(fields_spec.get(name), dict)},
    }

    result = run_scorer(payload)
    raw_fields = result.get("fields")
    scored_fields = raw_fields if isinstance(raw_fields, dict) else {}

    field_results: list[FieldResult] = []
    for name in names:
        scored = scored_fields.get(name)
        if not isinstance(scored, dict):
            raise RuntimeError(f"scorer returned no result for field {name!r}")
        exp_value = expected[name]
        act_value = actual.get(name)
        field_results.append(
            FieldResult(
                field_name=name,
                passed=bool(scored.get("match")),
                expected=exp_value,
                actual=act_value,
                detail=_detail(exp_value, act_value, scored),
                score=float(scored.get("score") or 0.0),
            )
        )
    return field_results


def compare_field(
    field_name: str,
    expected: Any,
    actual: Any,
    schema_def: dict | None = None,
) -> FieldResult:
    """Score one field. A thin convenience wrapper over `compare_results`."""
    return compare_results({field_name: expected}, {field_name: actual}, schema_def)[0]


# ── Fixture discovery ─────────────────────────────────────────────────


def discover_fixtures(schema_path: Path) -> list[tuple[Path, Path | None]]:
    """Find fixture files for a schema.

    Returns list of (markdown_path, expected_json_path_or_None).
    """
    fixtures_dir = schema_path.parent / (schema_path.stem + ".fixtures")
    if not fixtures_dir.is_dir():
        return []

    pairs: list[tuple[Path, Path | None]] = []
    for md_file in sorted(fixtures_dir.glob("*.md")):
        expected_path = fixtures_dir / (md_file.stem + ".expected.json")
        pairs.append((md_file, expected_path if expected_path.exists() else None))

    return pairs
