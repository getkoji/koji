/**
 * Plan gate error — thrown when a tenant's plan doesn't include
 * a required feature or exceeds a quantity limit.
 *
 * Serializes to HTTP 402 with:
 * ```json
 * {
 *   "error": {
 *     "code": "plan_gate",
 *     "message": "Benchmarks are available on Scale and Enterprise plans.",
 *     "required_plan": "scale",
 *     "current_plan": "free"
 *   }
 * }
 * ```
 */

import type { PlanId } from "./adapter";

export class PlanGateError extends Error {
  readonly code = "plan_gate" as const;
  readonly status = 402 as const;
  readonly requiredPlan: PlanId;
  readonly currentPlan: PlanId;

  constructor(message: string, requiredPlan: PlanId, currentPlan: PlanId) {
    super(message);
    this.name = "PlanGateError";
    this.requiredPlan = requiredPlan;
    this.currentPlan = currentPlan;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        required_plan: this.requiredPlan,
        current_plan: this.currentPlan,
      },
    };
  }
}
