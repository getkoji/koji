import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const billing = new Hono<Env>();

/**
 * GET /api/billing/usage — current usage summary for the tenant.
 *
 * Returns documents processed this period, included limit, hard cap,
 * overage count, credits, period boundaries, and current plan. On
 * self-hosted (NoOp adapter) this returns zeroed-out usage with no cap.
 */
billing.get("/usage", requires("tenant:read"), async (c) => {
  const tenantId = getTenantId(c);
  const billingAdapter = c.get("billing");
  const db = c.get("db");
  const usage = await billingAdapter.getUsageSummary(tenantId);

  const [tenant] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ plan: schema.tenants.plan })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId))
      .limit(1),
  );

  return c.json({
    plan: tenant?.plan ?? "free",
    documents_this_period: usage.documentsThisPeriod,
    included_documents: usage.includedDocuments,
    hard_cap: usage.hardCap,
    overage_count: usage.overageCount,
    credited_count: usage.creditedCount,
    period_start: usage.periodStart,
    period_end: usage.periodEnd,
  });
});
