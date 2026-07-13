/**
 * Autonomous schema-tuning loop (oss-451, increment 2).
 *
 * Drives {@link runTuneIteration} repeatedly on one labeled exemplar:
 * extract → score → propose → APPLY the proposal → re-run, until the schema
 * passes or the loop stalls. This is the automation of the by-hand loop that
 * took a real invoice 83% → 100% in two steps.
 *
 * It returns the best-scoring schema found plus the full trace, and applies
 * nothing durable — snapshotting a candidate + whole-corpus validation + promote
 * is the human-gated increment 3. Each applied proposal is recorded (best-effort)
 * via the `onEdit` hook so there's an audit trail.
 */

import { compileSchema } from "./compiler";
import { runTuneIteration, type TuneIterationArgs } from "./tune";

export interface TuneLoopIteration {
  n: number;
  /** Accuracy of the schema scored THIS iteration (before its proposal). */
  accuracy: number;
  failing: string[];
  /** Whether the model proposed an edit this iteration. */
  proposed: boolean;
  explanation: string;
}

export type TuneLoopStopReason =
  | "passed"
  | "stuck_no_proposal"
  | "stuck_no_improvement"
  | "max_iterations"
  | "compile_error";

export interface TuneLoopResult {
  iterations: TuneLoopIteration[];
  /** The highest-scoring schema tried (may be the input if nothing beat it). */
  finalYaml: string;
  finalAccuracy: number;
  stopReason: TuneLoopStopReason;
}

/** Per-iteration deps — everything runTuneIteration needs except the yaml/schema. */
type LoopDeps = Omit<TuneIterationArgs, "yaml" | "schemaDef">;

export interface RunTuneLoopArgs extends LoopDeps {
  startYaml: string;
  /** Hard cap on iterations (default 5). */
  maxIterations?: number;
  /** Called after each iteration completes (for SSE progress). */
  onIteration?: (it: TuneLoopIteration & { proposedYaml: string | null }) => Promise<void> | void;
  /** Called when a proposal is applied, for audit persistence (best-effort). */
  onEdit?: (n: number, yaml: string, explanation: string) => Promise<void> | void;
}

/** How many consecutive non-improving iterations count as "stuck". */
const NO_IMPROVEMENT_LIMIT = 2;

export async function runTuneLoop(args: RunTuneLoopArgs): Promise<TuneLoopResult> {
  const max = Math.max(1, Math.min(args.maxIterations ?? 5, 10));
  const { startYaml, onIteration, onEdit, ...deps } = args;

  let currentYaml = startYaml;
  let bestYaml = startYaml;
  let bestAccuracy = -1;
  let prevAccuracy = -1;
  let noImprovement = 0;
  const iterations: TuneLoopIteration[] = [];
  let stopReason: TuneLoopStopReason = "max_iterations";

  for (let n = 1; n <= max; n++) {
    // The proposal from the previous iteration was already compile-validated,
    // so this should always succeed; guard anyway.
    const compiled = compileSchema(currentYaml);
    if (!compiled.ok) {
      stopReason = "compile_error";
      break;
    }

    const r = await runTuneIteration({
      ...deps,
      yaml: currentYaml,
      schemaDef: compiled.parsed as Record<string, unknown>,
    });

    const it: TuneLoopIteration = {
      n,
      accuracy: r.before.accuracy,
      failing: r.before.failing.map((f) => f.name),
      proposed: r.proposedYaml != null,
      explanation: r.explanation,
    };
    iterations.push(it);
    await onIteration?.({ ...it, proposedYaml: r.proposedYaml });

    if (r.before.accuracy > bestAccuracy) {
      bestAccuracy = r.before.accuracy;
      bestYaml = currentYaml;
    }

    if (r.before.passed) {
      stopReason = "passed";
      break;
    }
    if (!r.proposedYaml) {
      stopReason = "stuck_no_proposal";
      break;
    }
    // No-improvement detection: if applying the last proposal didn't raise the
    // score, count it; a run of these means the loop is spinning.
    if (n > 1 && r.before.accuracy <= prevAccuracy) noImprovement++;
    else noImprovement = 0;
    prevAccuracy = r.before.accuracy;
    if (noImprovement >= NO_IMPROVEMENT_LIMIT) {
      stopReason = "stuck_no_improvement";
      break;
    }

    await onEdit?.(n, r.proposedYaml, r.explanation);
    currentYaml = r.proposedYaml;
  }

  return { iterations, finalYaml: bestYaml, finalAccuracy: bestAccuracy, stopReason };
}
