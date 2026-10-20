/**
 * @koji/score — the single implementation of Koji's extraction scorer.
 *
 * Everything that compares an expected value against an extracted one goes
 * through `compareValues`. It is deliberately dependency-free and side-effect
 * free so it can run in the API, in the CLI via the `koji-score` bin, and in
 * external benchmark harnesses that install this package, without any of them
 * reimplementing comparison semantics.
 *
 * `metrics.ts` turns per-field comparisons into the four reported numbers
 * (presence recall, value accuracy, fabrication rate, null agreement), and
 * `version.ts` carries the stamp that makes two runs comparable — or refuses.
 */

export {
  compareValues,
  formatValue,
  matchPolicy,
  type ArrayDiff,
  type ArrayElemDiff,
  type CompareResult,
  type CompareSpec,
  type MatchMode,
  type MatchPolicy,
  type ObjectDiff,
  type ObjectFieldDiff,
  type ScalarDiff,
  type ValueDiff,
} from "./compare.js";

export {
  emptyCounts,
  fieldOutcome,
  hasValue,
  metricsFromCounts,
  summarizeFields,
  summarizeOutcomes,
  tally,
  type FieldBucket,
  type FieldOutcome,
  type MetricCounts,
  type ScoreMetrics,
} from "./metrics.js";

export {
  assertComparableScorerVersion,
  scorerVersionMismatch,
  scorerVersionsComparable,
  SCORER_NAME,
  SCORER_VERSION,
} from "./version.js";
