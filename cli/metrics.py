"""The four reported metrics, and the scorer stamp that makes runs comparable.

A single accuracy number folded four different things into one average, and one
of them was "correctly absent" — a field the ground truth says has no value,
which the extraction also left empty. Counting that as a pass gives a document
that extracts **nothing at all** a floor of whatever fraction of its fields are
legitimately empty. On the reference corpus run (1,100 docs / 7,121 fields)
that floor is 19.2% — 1,365 of the 5,978 "passed" fields are correctly-absent
ones — so an extractor that returns ``{}`` for every document reports 19.2%
accuracy. The number is at once too kind to a broken run and too harsh on a
working one, and nothing about it says which.

So four are reported, over two disjoint populations of fields:

    ground truth HAS a value
        presence recall   did we produce a value at all?
        value accuracy    of the ones we produced, how many were right

    ground truth has NO value
        fabrication rate  how often did we invent one?
        null agreement    how often did we correctly decline?

``null_agreement`` is reported and **never** folded into a headline number —
folding it in is exactly what produced the floor.

This module does no comparison. Comparison lives in ONE place, ``@koji/score``
(see ``cli/score.py``); all this does is bucket already-compared field results
by whether each side carried a value, and divide. ``has_value`` mirrors
``hasValue`` in ``packages/score/src/metrics.ts`` exactly — if the two drift,
the CLI's artifact metrics and the server's disagree about the same extraction.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Any

# The scorer whose semantics these metrics are computed under. Read from the
# package rather than duplicated, so bumping @koji/score bumps the stamp.
SCORER_NAME = "@koji/score"


def scorer_version() -> str:
    """The version of `@koji/score` in this checkout.

    Read from the package's `package.json` so there is exactly one place the
    version lives. Falls back to ``"unknown"`` outside a checkout — an
    unrecorded version is never comparable to anything, which is the safe
    answer rather than a confident wrong one.
    """
    import json
    from pathlib import Path

    here = Path(__file__).resolve()
    for candidate in here.parents:
        pkg = candidate / "packages" / "score" / "package.json"
        if pkg.is_file():
            try:
                return str(json.loads(pkg.read_text())["version"])
            except (OSError, ValueError, KeyError):
                return "unknown"
    return "unknown"


def scorer_stamp() -> dict[str, str]:
    """The `{scorer, scorer_version}` pair every run artifact carries."""
    return {"scorer": SCORER_NAME, "scorer_version": scorer_version()}


def versions_comparable(a: str | None, b: str | None) -> bool:
    """Are two scorer versions comparable? Only when they are the same string.

    Deliberately not semver-aware. "Patch releases are comparable" sounds
    reasonable and is false — a bug fix in date parsing moves numbers, which is
    precisely the case a guard exists to catch. An unrecorded version
    (``None``, or ``"unknown"``) is never comparable to anything.
    """
    if not a or not b or a == "unknown" or b == "unknown":
        return False
    return a == b


def require_comparable_scorer(found: str | None, label: str = "artifact") -> None:
    """Raise unless `found` is the scorer version running here.

    For callers whose whole operation IS a comparison — a regression gate, a
    baseline diff, a benchmark delta. The difference between two runs scored by
    different versions includes whatever the scorer changed, and the two cannot
    be separated after the fact, so the comparison is refused rather than
    reported with a caveat nobody reads.
    """
    current = scorer_version()
    if versions_comparable(found, current):
        return
    which = f"scorer {found}" if found else "an unrecorded scorer version"
    raise ValueError(
        f"{label} was scored by {which}, but this is {SCORER_NAME} {current}. "
        f"Numbers from different scorer versions are not comparable — the difference "
        f"between them includes whatever the scorer changed, which cannot be separated "
        f"from the extraction afterwards. Re-score the {label} with this version before "
        f"comparing."
    )


def has_value(value: Any) -> bool:
    """Does this value carry data?

    ``None``, a whitespace-only string, an empty list and an empty dict all mean
    "no value" — extraction emits ``[]`` or ``""`` where ground truth simply
    omits the key, and both mean the same thing. Keys prefixed ``__`` are
    provenance metadata the model attaches inline (``__source_text``), so a dict
    carrying nothing but those is still empty; counting it as a value would turn
    every correctly-declined object field into a fabrication.

    ``0`` and ``False`` are answers, not absences.

    Mirrors ``hasValue`` in ``packages/score/src/metrics.ts``.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, dict):
        return any(not str(k).startswith("__") for k in value)
    if isinstance(value, (list, tuple, set)):
        return len(value) > 0
    return True


# Which population a scored field belongs to, and what happened to it.
#   found       ground truth has a value and we produced one (right or wrong)
#   missed      ground truth has a value and we produced nothing
#   fabricated  ground truth has no value and we invented one
#   agreed      ground truth has no value and neither did we
BUCKETS = ("found", "missed", "fabricated", "agreed")


def bucket_of(expected: Any, actual: Any) -> str:
    """Classify one (expected, actual) pair into one of `BUCKETS`."""
    if has_value(expected):
        return "found" if has_value(actual) else "missed"
    return "fabricated" if has_value(actual) else "agreed"


@dataclass
class MetricCounts:
    """Raw counts the four metrics divide. Additive, so slices aggregate."""

    #: Fields where ground truth carries a value. The presence denominator.
    present: int = 0
    #: ...of which we produced some value.
    found: int = 0
    #: ...of which we produced nothing. ``present - found``.
    missed: int = 0
    #: Fields where ground truth carries no value. The fabrication denominator.
    absent: int = 0
    #: ...of which we invented a value.
    fabricated: int = 0
    #: ...of which we also left empty. ``absent - fabricated``.
    agreed: int = 0
    #: Summed partial credit over ``found`` fields. The value-accuracy numerator.
    credit: float = 0.0
    #: ``found`` fields that matched exactly, alongside the partial credit.
    exact: int = 0

    def add(self, expected: Any, actual: Any, score: float, passed: bool) -> None:
        """Fold one already-compared field into the tally.

        ``score`` is the field's partial credit in [0,1] (``weighted_score`` on
        a ``FieldResult``) and ``passed`` its strict boolean. Neither is
        recomputed here — comparison belongs to the one scorer.
        """
        bucket = bucket_of(expected, actual)
        if bucket == "found":
            self.present += 1
            self.found += 1
            self.credit += score
            if passed:
                self.exact += 1
        elif bucket == "missed":
            self.present += 1
            self.missed += 1
        elif bucket == "fabricated":
            self.absent += 1
            self.fabricated += 1
        else:
            self.absent += 1
            self.agreed += 1

    def merge(self, other: MetricCounts) -> None:
        """Fold another tally in, so per-document counts roll up to a run."""
        self.present += other.present
        self.found += other.found
        self.missed += other.missed
        self.absent += other.absent
        self.fabricated += other.fabricated
        self.agreed += other.agreed
        self.credit += other.credit
        self.exact += other.exact

    def to_dict(self) -> dict:
        d = asdict(self)
        d["credit"] = round(self.credit, 6)
        return d


def _ratio(num: float, den: int) -> float | None:
    """The metric, or ``None`` when its population is empty.

    ``None`` rather than 0 or 1, deliberately. A run with no absent fields has
    no fabrication rate — reporting 0 would read as "it never fabricates",
    which is a claim the run did not test. That substitution is how the single
    accuracy number came to report 100% for measuring nothing.
    """
    if den <= 0:
        return None
    return round(num / den, 6)


def metrics_from_counts(counts: MetricCounts) -> dict:
    """The four metrics plus their counts, ready for a run artifact."""
    return {
        "presence_recall": _ratio(counts.found, counts.present),
        "value_accuracy": _ratio(counts.credit, counts.found),
        "fabrication_rate": _ratio(counts.fabricated, counts.absent),
        "null_agreement": _ratio(counts.agreed, counts.absent),
        "counts": counts.to_dict(),
    }


def counts_from_field_results(field_results: Iterable[Any]) -> MetricCounts:
    """Tally `FieldResult`-shaped objects (``expected``/``actual``/``passed``).

    Accepts anything with those attributes plus ``weighted_score`` — which is
    every scored field in `cli/test_runner.py`, `cli/bench.py` and
    `cli/pipeline_bench.py`.
    """
    counts = MetricCounts()
    for r in field_results:
        counts.add(r.expected, r.actual, r.weighted_score, r.passed)
    return counts


def metrics_from_field_results(field_results: Iterable[Any]) -> dict:
    """`metrics_from_counts(counts_from_field_results(...))`, the common case."""
    return metrics_from_counts(counts_from_field_results(field_results))
