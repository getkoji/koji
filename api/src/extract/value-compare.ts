/**
 * Re-export shim — the scorer now lives in `@koji/score`.
 *
 * It was moved out of the API so that the CLI (`koji score`), CI benchmark
 * harnesses, and external consumers can reach the SAME implementation instead
 * of reimplementing comparison semantics. Four divergent scorers is what
 * prompted the move; this shim keeps existing imports working so the move
 * carries no behaviour change of its own.
 *
 * New code should import from `@koji/score` directly.
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
} from "@koji/score";
