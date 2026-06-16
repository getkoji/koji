/**
 * Concurrency gate — limits concurrent running jobs per tenant based on plan.
 *
 * Checks the jobs table for status='running' and compares against the
 * tenant's effective `max_concurrent_jobs` (plan default merged with
 * planOverridesJson). Excess jobs are queued (soft rejection with 429),
 * not rejected — the client is expected to retry.
 *
 * The limit lives in `PlanFeatures` (see `plans.ts`), so it goes through
 * the same `getEffectivePlan` path as every other tier-gated value. The
 * admin UI's per-tenant overrides apply here too: a Scale tenant with
 * `{ "max_concurrent_jobs": 25 }` in `plan_overrides_json` gets 25
 * concurrent slots, not the Scale default of 5. Setting the override to
 * `null` removes the cap entirely.
 */

import type { Context, Next } from "hono";
import { sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";

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

    // We pass currentCount=0 because the real count comes from the
    // jobs table below — checkQuantityGate just resolves the effective
    // limit for us via getEffectivePlan(tenant) + override merge.
    const billing = c.get("billing");
    const gate = await billing.checkQuantityGate(
      tenantId,
      "max_concurrent_jobs",
      0,
    );

    // null/undefined limit = unlimited (enterprise default, or any tier
    // with the override pinned to null). Skip the DB count entirely.
    if (gate.limit == null) {
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
    if (running >= gate.limit) {
      return c.json(
        {
          error: {
            code: "concurrency_limit",
            message: `All ${gate.limit} concurrent job slots are in use on your ${gate.currentPlan} plan. Your job will be queued — try again shortly.`,
            running,
            limit: gate.limit,
          },
        },
        { status: 429, headers: { "Retry-After": "30" } },
      );
    }

    await next();
  };
}
