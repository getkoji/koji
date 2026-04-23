/**
 * Concurrency gate — limits concurrent running jobs per tenant based on plan.
 *
 * Checks the jobs table for status='running' and compares against the
 * plan limit. Excess jobs are queued (soft rejection with 429), not rejected.
 */

import type { Context, Next } from "hono";
import { sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { getTenantId } from "../auth/middleware";
import type { PlanId } from "./adapter";

interface PlanConcurrencyLimits {
  maxConcurrentJobs: number | null; // null = unlimited
}

const CONCURRENCY_LIMITS: Record<PlanId, PlanConcurrencyLimits> = {
  free: { maxConcurrentJobs: 1 },
  scale: { maxConcurrentJobs: 5 },
  enterprise: { maxConcurrentJobs: null }, // unlimited (or per-contract)
};

function limitsForPlan(plan: string): PlanConcurrencyLimits {
  return CONCURRENCY_LIMITS[plan as PlanId] ?? CONCURRENCY_LIMITS.free;
}

/**
 * Middleware that checks whether the tenant has a concurrency slot available.
 * Returns 429 if all slots are occupied, suggesting the client retry.
 */
export function requireConcurrencySlot() {
  return async (c: Context<Env>, next: Next) => {
    const tenantId = c.get("tenantId");
    if (!tenantId) {
      await next();
      return;
    }

    const billing = c.get("billing");
    const result = await billing.canUse(tenantId, "max_schemas"); // just to get currentPlan
    const limits = limitsForPlan(result.currentPlan);

    if (limits.maxConcurrentJobs === null) {
      await next();
      return;
    }

    const db = c.get("db");
    const [row] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.jobs)
        .where(sql`status = 'running'`),
    );

    const running = row?.count ?? 0;
    if (running >= limits.maxConcurrentJobs) {
      return c.json(
        {
          error: {
            code: "concurrency_limit",
            message: `All ${limits.maxConcurrentJobs} concurrent job slots are in use on your ${result.currentPlan} plan. Your job will be queued — try again shortly.`,
            running,
            limit: limits.maxConcurrentJobs,
          },
        },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }

    await next();
  };
}
