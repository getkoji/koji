/**
 * The offline-only guard for `adjudicate`.
 *
 * Why a guard at all
 * ------------------
 * Adjudication settles whether a scorer disagreement is a real miss or a
 * string-form variant — "Delaware" against "State of Delaware". A third of the
 * corpus scorer's apparent errors are variants of that kind, so the capability
 * is load-bearing for measurement. It is also a model call, and a model call
 * on the request path would:
 *
 *   - put a second inference in front of every extracted field, doubling
 *     latency and cost for an answer nobody reads at runtime;
 *   - make a hosted dependency load-bearing for an OSS install, which is
 *     exactly the open-core line this architecture exists to avoid;
 *   - let a judge quietly rewrite an extraction result, so what shipped to the
 *     customer and what the corpus recorded would differ with no trace.
 *
 * So adjudication belongs to the scorer and the corpus queue: CI, the CLI, and
 * offline analysis. Never a route handler, never a job worker on the document
 * path.
 *
 * How it is enforced
 * ------------------
 * Two layers, because a comment is not enforcement:
 *
 *   1. **Call time.** Every `AdjudicateProvider` calls
 *      `assertAdjudicationAllowed` first. It throws unless the process
 *      explicitly armed adjudication — which the offline entry points do and
 *      the server does not.
 *   2. **Source tree.** `offline-only.test.ts` asserts no file under the
 *      request-path directories references these symbols at all, so the guard
 *      cannot be armed by a well-meaning import three refactors from now.
 */

import type { AdjudicateProvider } from "./types";

/** Set once by an offline entry point. Null means "not armed". */
let armedReason: string | null = null;

/**
 * Thrown when adjudication is attempted without being armed. The message names
 * the rule rather than the fix, because in the request path there is no fix —
 * the call should not be there.
 */
export class AdjudicationNotEnabledError extends Error {
  constructor(provider: string) {
    super(
      `${provider}: adjudication is offline-only and has not been enabled in this process. ` +
        "It belongs to scoring, CI and corpus maintenance — never the extraction request path. " +
        "An offline caller arms it with enableAdjudication(reason) or KOJI_ADJUDICATE=1.",
    );
    this.name = "AdjudicationNotEnabledError";
  }
}

/**
 * Arm adjudication for this process. Call it from a CLI entry point, a CI
 * script, or a test — somewhere a human chose to run a judge.
 *
 * `reason` is recorded and surfaced by `adjudicationContext()` so a run
 * artifact can say why a judge was in the loop.
 */
export function enableAdjudication(reason: string): void {
  armedReason = reason && reason.trim().length > 0 ? reason.trim() : "unspecified";
}

/** Disarm. Mainly so a test can prove the guard actually bites. */
export function disableAdjudication(): void {
  armedReason = null;
}

/**
 * `KOJI_ADJUDICATE=1` arms adjudication for a whole process without a code
 * change — how a CI job or a corpus script turns it on. The API server's
 * environment never sets it.
 */
export function adjudicationEnabled(): boolean {
  return armedReason !== null || process.env.KOJI_ADJUDICATE === "1";
}

/** Why adjudication is armed, for the run artifact. Null when it isn't. */
export function adjudicationContext(): string | null {
  if (armedReason !== null) return armedReason;
  if (process.env.KOJI_ADJUDICATE === "1") return "KOJI_ADJUDICATE=1";
  return null;
}

/** Throw unless this process armed adjudication. Called by every implementation. */
export function assertAdjudicationAllowed(provider: string): void {
  if (!adjudicationEnabled()) throw new AdjudicationNotEnabledError(provider);
}

/**
 * The default: no adjudication.
 *
 * A scorer disagreement stands as a disagreement. This is what ships unless an
 * operator configures something, and it is a real implementation rather than a
 * null hole — it answers the contract, it is deterministic, and it costs
 * nothing. `equivalent: false, confidence: 0` says "this judge has no opinion",
 * which is different from "these differ" and is why the confidence is zero.
 */
export class NoAdjudicateProvider implements AdjudicateProvider {
  readonly name = "none";

  async adjudicate(): Promise<{
    equivalent: boolean;
    confidence: number;
    calibrated: boolean;
    reason: string;
    provider: string;
  }> {
    assertAdjudicationAllowed(this.name);
    return {
      equivalent: false,
      confidence: 0,
      calibrated: false,
      reason: "no adjudicator configured — the scorer's verdict stands",
      provider: this.name,
    };
  }
}
