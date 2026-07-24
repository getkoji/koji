/**
 * Release regression gate (oss-464).
 *
 * Promoting a tuned classifier candidate to live can quietly cost a class you
 * weren't looking at: widening one class's keywords to lift its recall also
 * makes those keywords match a *different* class's documents, dropping the
 * other class's recall and leaking cross-class false positives. Per-class
 * metrics (oss-452) make that visible; this makes it BLOCKING.
 *
 * Pure and unit-tested — no DB. The promote route supplies the candidate run's
 * scored result, the current release's result (the baseline "before"), and the
 * caller's gate spec; a non-empty `blocks` array refuses the promotion.
 */
import type { ClassifierValidateResult, PerClassMetrics } from "./classify-scoring";

/** What the caller asked the gate to enforce. All fields optional/additive. */
export interface ReleaseGateSpec {
  /** Every class's recall AND precision must not drop vs. the baseline. */
  requireNoRegressions?: boolean;
  /** These named classes must not drop vs. the baseline (recall or precision). */
  mustNotRegress?: string[];
  /** Absolute recall floor per class (0..1) — independent of the baseline. */
  minRecall?: Record<string, number>;
  /** Absolute precision floor per class (0..1). */
  minPrecision?: Record<string, number>;
}

/** One reason a promotion is refused, with the numbers to explain it. */
export interface GateBlock {
  class: string;
  metric: "recall" | "precision";
  /** Why: a drop vs. the baseline, or a value under an absolute floor. */
  kind: "regression" | "floor";
  /** Baseline value (the release being replaced), 0..1. Null for a floor block. */
  before: number | null;
  /** Candidate value, 0..1. Null when the class is absent from the candidate run. */
  after: number | null;
  /** The floor that was violated (0..1), for a floor block. */
  floor?: number;
}

export interface GateResult {
  ok: boolean;
  blocks: GateBlock[];
}

/** Float slack so a metric that is numerically identical doesn't read as a drop. */
const EPS = 1e-9;

function byLabel(result: ClassifierValidateResult | null): Map<string, PerClassMetrics> {
  const m = new Map<string, PerClassMetrics>();
  for (const cl of result?.byClass ?? []) m.set(cl.label, cl);
  return m;
}

/**
 * Evaluate a promotion against its gate. Returns every reason it is refused
 * (empty ⇒ allowed). A regression is a candidate metric strictly below the
 * baseline's; a floor violation is a candidate metric below an absolute
 * threshold. A class the baseline never measured (a brand-new class, or the
 * first-ever release with no baseline) can't regress — only a floor can catch
 * it. A metric that is null on both sides is not a regression (nothing to
 * compare); null on the candidate side with a real baseline value IS a drop.
 */
export function evaluateReleaseGate(
  candidate: ClassifierValidateResult | null,
  baseline: ClassifierValidateResult | null,
  spec: ReleaseGateSpec,
): GateResult {
  const blocks: GateBlock[] = [];
  const cand = byLabel(candidate);
  const base = byLabel(baseline);

  // ── Regression checks ────────────────────────────────────────
  // Scope: named classes (mustNotRegress) plus, when requireNoRegressions is
  // set, every class the baseline measured (that's what "no regressions" means
  // — you can only regress against something you had before).
  const regressionClasses = new Set<string>(spec.mustNotRegress ?? []);
  if (spec.requireNoRegressions) for (const label of base.keys()) regressionClasses.add(label);

  for (const label of regressionClasses) {
    const b = base.get(label);
    const c = cand.get(label);
    for (const metric of ["recall", "precision"] as const) {
      const before = b ? b[metric] : null;
      const after = c ? c[metric] : null;
      // No baseline value → nothing to regress from (a floor check handles it).
      if (before === null || before === undefined) continue;
      // A real baseline value that the candidate no longer reports, or reports
      // lower, is a regression.
      if (after === null || after === undefined || after < before - EPS) {
        blocks.push({ class: label, metric, kind: "regression", before, after: after ?? null });
      }
    }
  }

  // ── Absolute floor checks ────────────────────────────────────
  for (const [metric, floors] of [
    ["recall", spec.minRecall],
    ["precision", spec.minPrecision],
  ] as const) {
    for (const [label, floor] of Object.entries(floors ?? {})) {
      const c = cand.get(label);
      const value = c ? c[metric] : null;
      // A class absent from the candidate run (or with no measurable metric)
      // fails a floor it was asked to clear — you can't prove it met the bar.
      if (value === null || value === undefined || value < floor - EPS) {
        blocks.push({ class: label, metric, kind: "floor", before: null, after: value ?? null, floor });
      }
    }
  }

  return { ok: blocks.length === 0, blocks };
}

/** True when the spec asks for anything at all (so the route knows to gate). */
export function gateRequested(spec: ReleaseGateSpec): boolean {
  return Boolean(
    spec.requireNoRegressions ||
      (spec.mustNotRegress && spec.mustNotRegress.length > 0) ||
      (spec.minRecall && Object.keys(spec.minRecall).length > 0) ||
      (spec.minPrecision && Object.keys(spec.minPrecision).length > 0),
  );
}

/** Human-readable one-liner for a block — reused by the API error + the CLI. */
export function describeBlock(b: GateBlock): string {
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
  if (b.kind === "floor") {
    return `${b.class} ${b.metric} ${pct(b.after)} is below the required floor ${pct(b.floor ?? null)}`;
  }
  return `${b.class} ${b.metric} regressed ${pct(b.before)} → ${pct(b.after)}`;
}
