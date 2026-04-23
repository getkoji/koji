/**
 * Billing middleware — plan-based feature gates and quantity limits.
 *
 * Mirrors the `requires()` pattern from auth/middleware.ts. Each factory
 * returns a Hono middleware handler that reads the BillingAdapter from
 * context and returns 402 on gate failure.
 *
 * Usage:
 *   schemas.post("/", requires("schema:write"), requireQuantityGate("max_schemas", countFn), handler)
 *   runs.post("/", requires("run:write"), requireFeature("benchmarks"), handler)
 */

import type { Context, Next } from "hono";
import type { FeatureKey } from "./adapter";
import { featureLabel, getRequiredPlan, PLANS } from "./plans";
import type { Env } from "../env";

/**
 * Gate a route behind a boolean plan feature.
 * Returns 402 with plan_gate error if the tenant's plan doesn't include the feature.
 */
export function requireFeature(feature: FeatureKey) {
  return async (c: Context<Env>, next: Next) => {
    const billing = c.get("billing");
    const tenantId = c.get("tenantId");

    if (!tenantId) {
      // No tenant context — skip billing check (handled by auth middleware)
      await next();
      return;
    }

    const result = await billing.canUse(tenantId, feature);

    if (!result.allowed) {
      const requiredPlan = result.requiredPlan ?? getRequiredPlan(feature);
      const label = featureLabel(feature);
      const planNames = getPlanNamesAtOrAbove(requiredPlan);

      return c.json(
        {
          error: {
            code: "plan_gate",
            message: `${capitalize(label)} ${planNames.length === 1 ? "is" : "are"} available on ${planNames.join(" and ")} plans.`,
            required_plan: requiredPlan,
            current_plan: result.currentPlan,
          },
        },
        402,
      );
    }

    await next();
  };
}

/**
 * Gate a route behind a quantity limit (max_schemas, max_webhooks, etc).
 * The `countFn` callback returns the current count of the resource for this tenant.
 */
export function requireQuantityGate(
  feature: FeatureKey,
  countFn: (c: Context<Env>) => Promise<number>,
) {
  return async (c: Context<Env>, next: Next) => {
    const billing = c.get("billing");
    const tenantId = c.get("tenantId");

    if (!tenantId) {
      await next();
      return;
    }

    const currentCount = await countFn(c);
    const result = await billing.checkQuantityGate(tenantId, feature, currentCount);

    if (!result.allowed) {
      const label = featureLabel(feature);
      const limit = result.limit ?? 0;

      return c.json(
        {
          error: {
            code: "plan_gate",
            message: `You've reached the limit of ${limit} ${label} on your ${result.currentPlan} plan. Upgrade to add more.`,
            required_plan: result.requiredPlan ?? "scale",
            current_plan: result.currentPlan,
            limit,
            current: result.current ?? currentCount,
          },
        },
        402,
      );
    }

    await next();
  };
}

/**
 * Gate document processing behind the monthly document cap.
 * Free tier: hard cap (reject at limit). Paid tiers: always allowed.
 */
export function requireDocumentCap() {
  return async (c: Context<Env>, next: Next) => {
    const billing = c.get("billing");
    const tenantId = c.get("tenantId");

    if (!tenantId) {
      await next();
      return;
    }

    const { allowed, usage } = await billing.checkDocumentCap(tenantId);

    if (!allowed) {
      return c.json(
        {
          error: {
            code: "plan_gate",
            message: `You've reached your monthly limit of ${usage.hardCap} documents on the free plan. Upgrade to process more.`,
            required_plan: "scale",
            current_plan: "free",
            usage: {
              documents_this_period: usage.documentsThisPeriod,
              included_documents: usage.includedDocuments,
              hard_cap: usage.hardCap,
            },
          },
        },
        402,
      );
    }

    await next();
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getPlanNamesAtOrAbove(planId: string): string[] {
  const order = ["free", "scale", "enterprise"] as const;
  const idx = order.indexOf(planId as (typeof order)[number]);
  if (idx === -1) return ["Scale", "Enterprise"];
  return order.slice(idx).map((id) => PLANS[id].name);
}
