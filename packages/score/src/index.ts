/**
 * @koji/score — the single implementation of Koji's extraction scorer.
 *
 * Everything that compares an expected value against an extracted one goes
 * through `compareValues`. It is deliberately dependency-free and side-effect
 * free so it can run in the API, in the CLI via the `koji-score` bin, and in
 * external benchmark harnesses that install this package, without any of them
 * reimplementing comparison semantics.
 */

export {
  compareValues,
  formatValue,
  type ArrayDiff,
  type ArrayElemDiff,
  type CompareResult,
  type CompareSpec,
  type ObjectDiff,
  type ObjectFieldDiff,
  type ScalarDiff,
  type ValueDiff,
} from "./compare.js";
