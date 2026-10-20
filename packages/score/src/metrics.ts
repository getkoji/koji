/**
 * The four metrics that replace "accuracy".
 *
 * A single accuracy number folded four different things into one average, and
 * one of them was "correctly absent" — a field the ground truth says has no
 * value, which the extraction also left empty. Counting that as a pass means a
 * document that extracts **nothing at all** scores whatever fraction of its
 * fields are legitimately empty. On the reference corpus run
 * (`ablation_step0_baseline_gpt4o`, 1,100 docs / 7,121 fields) that floor is
 * 19.2% — 1,365 of the 5,978 "passed" fields are correctly-absent ones — so an
 * extractor that returns `{}` for every document reports 19.2% accuracy, and a
 * real extractor at 60% looks like it is doing 3x better than nothing when it
 * is doing far more than that. The number is simultaneously too kind to a
 * broken run and too harsh on a good one, and nothing about it says which.
 *
 * Worse, the four things move in opposite directions. Tighten a prompt so the
 * model declines more often and "accuracy" can rise while the extraction gets
 * less useful. There is no way to read that off one number.
 *
 * So they are reported separately, over two disjoint populations of fields:
 *
 *   ground truth HAS a value (`present`)
 *     presence recall   did we produce a value at all?       found / present
 *     value accuracy    of the ones we produced, right?      credit / found
 *
 *   ground truth has NO value (`absent`)
 *     fabrication rate  how often did we invent one?      fabricated / absent
 *     null agreement    how often did we correctly decline?  agreed / absent
 *
 * `nullAgreement` is reported and never folded into a headline. It is the
 * complement of `fabricationRate` by construction (they sum to 1), so it adds
 * no information to the pair — it is kept because "declined correctly 94% of
 * the time" is the sentence an operator wants, and because removing it would
 * invite someone to re-derive it by averaging it back into accuracy.
 *
 * Everything here is computed from the per-field output of `compareValues`, so
 * an external harness that reads the `koji-score` JSON gets the same four
 * numbers without reimplementing anything.
 *
 * Fully generic — no field names, document types, or domain knowledge.
 */

import { compareValues, type CompareResult, type CompareSpec } from "./compare.js";

/**
 * Does this value carry data?
 *
 * `null`, a whitespace-only string, an empty array and an empty object all mean
 * "no value" — extraction emits `[]` or `""` where ground truth simply omits
 * the key, and both mean the same thing. Keys prefixed `__` are provenance
 * metadata the model attaches inline (`__source_text`), so an object carrying
 * nothing but those is still empty; counting it as a value would turn every
 * declined object field into a fabrication.
 *
 * Mirrored exactly by `_is_empty` / `has_value` in `cli/metrics.py`. The two
 * must agree or the CLI's artifact metrics and the server's disagree on the
 * same extraction.
 */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") {
    return Object.keys(v as Record<string, unknown>).some((k) => !k.startsWith("__"));
  }
  return true;
}

/** Which population a scored field belongs to, and what happened to it. */
export type FieldBucket =
  /** Ground truth has a value and we produced one (right or wrong). */
  | "found"
  /** Ground truth has a value and we produced nothing. The recall loss. */
  | "missed"
  /** Ground truth has no value and we invented one. The fabrication. */
  | "fabricated"
  /** Ground truth has no value and neither did we. Correctly absent. */
  | "agreed";

/** One scored field, classified and scored. */
export interface FieldOutcome {
  bucket: FieldBucket;
  /** Ground truth carries a value for this field. */
  expectedPresent: boolean;
  /** The extraction produced a value for this field. */
  gotPresent: boolean;
  /**
   * Partial credit in [0,1] from `compareValues`. Only meaningful for `found`
   * fields — the other three buckets are counts, not qualities.
   */
  score: number;
  /** `score === 1`. */
  match: boolean;
}

/** Classify and score one field. */
export function fieldOutcome(
  expected: unknown,
  got: unknown,
  spec?: CompareSpec,
): FieldOutcome & { result: CompareResult } {
  const expectedPresent = hasValue(expected);
  const gotPresent = hasValue(got);
  const result = compareValues(expected, got, spec);
  const bucket: FieldBucket = expectedPresent
    ? gotPresent
      ? "found"
      : "missed"
    : gotPresent
      ? "fabricated"
      : "agreed";
  return { bucket, expectedPresent, gotPresent, score: result.score, match: result.match, result };
}

/** Raw counts the four metrics are derived from. Additive, so they aggregate. */
export interface MetricCounts {
  /** Fields where ground truth carries a value. The presence denominator. */
  present: number;
  /** …of which we produced some value. */
  found: number;
  /** …of which we produced nothing. `present - found`. */
  missed: number;
  /** Fields where ground truth carries no value. The fabrication denominator. */
  absent: number;
  /** …of which we invented a value. */
  fabricated: number;
  /** …of which we also left empty. `absent - fabricated`. */
  agreed: number;
  /** Summed partial credit over `found` fields. The value-accuracy numerator. */
  credit: number;
  /** `found` fields that matched exactly — for a strict count alongside credit. */
  exact: number;
}

export function emptyCounts(): MetricCounts {
  return { present: 0, found: 0, missed: 0, absent: 0, fabricated: 0, agreed: 0, credit: 0, exact: 0 };
}

/** Fold one outcome into a running tally. */
export function tally(into: MetricCounts, outcome: FieldOutcome): void {
  if (outcome.expectedPresent) {
    into.present += 1;
    if (outcome.gotPresent) {
      into.found += 1;
      into.credit += outcome.score;
      if (outcome.match) into.exact += 1;
    } else {
      into.missed += 1;
    }
  } else {
    into.absent += 1;
    if (outcome.gotPresent) into.fabricated += 1;
    else into.agreed += 1;
  }
}

/**
 * The four metrics, each in [0,1], each `null` when its population is empty.
 *
 * `null` rather than 1 or 0 on an empty population, deliberately. A run with no
 * absent fields has no fabrication rate — reporting 0 would read as "it never
 * fabricates", which is a claim the run did not test. That substitution is how
 * the single accuracy number got to report 100% for measuring nothing.
 */
export interface ScoreMetrics {
  /** Of the fields ground truth has a value for, how many we produced one for. */
  presenceRecall: number | null;
  /** Of the ones we produced, how much credit they earned. Partial credit. */
  valueAccuracy: number | null;
  /** Of the fields ground truth leaves empty, how many we invented a value for. */
  fabricationRate: number | null;
  /**
   * Of the fields ground truth leaves empty, how many we also left empty.
   * Reported separately and NEVER folded into a headline accuracy number —
   * folding it in is what produced the all-null floor this split removes.
   */
  nullAgreement: number | null;
  counts: MetricCounts;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function metricsFromCounts(counts: MetricCounts): ScoreMetrics {
  return {
    presenceRecall: ratio(counts.found, counts.present),
    valueAccuracy: ratio(counts.credit, counts.found),
    fabricationRate: ratio(counts.fabricated, counts.absent),
    nullAgreement: ratio(counts.agreed, counts.absent),
    counts,
  };
}

/** Aggregate a stream of outcomes into the four metrics. */
export function summarizeOutcomes(outcomes: Iterable<FieldOutcome>): ScoreMetrics {
  const counts = emptyCounts();
  for (const o of outcomes) tally(counts, o);
  return metricsFromCounts(counts);
}

/** Score a whole field map and return both per-field outcomes and the metrics. */
export function summarizeFields(
  fields: Record<string, { expected?: unknown; got?: unknown }>,
  specs: Record<string, CompareSpec> = {},
): { outcomes: Record<string, FieldOutcome & { result: CompareResult }>; metrics: ScoreMetrics } {
  const outcomes: Record<string, FieldOutcome & { result: CompareResult }> = {};
  const counts = emptyCounts();
  for (const [name, field] of Object.entries(fields)) {
    const outcome = fieldOutcome(field?.expected, field?.got, specs[name]);
    outcomes[name] = outcome;
    tally(counts, outcome);
  }
  return { outcomes, metrics: metricsFromCounts(counts) };
}
