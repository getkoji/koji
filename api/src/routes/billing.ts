import { Hono } from "hono";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const billing = new Hono<Env>();

/**
 * GET /api/billing/usage — current usage summary for the tenant.
 *
 * Returns documents processed this period, included limit, hard cap,
 * overage count, credits, and period boundaries. On self-hosted (NoOp
 * adapter) this returns zeroed-out usage with no cap.
 */
billing.get("/usage", requires("tenant:read"), async (c) => {
  const tenantId = getTenantId(c);
  const billing = c.get("billing");
  const usage = await billing.getUsageSummary(tenantId);

  return c.json({
    documents_this_period: usage.documentsThisPeriod,
    included_documents: usage.includedDocuments,
    hard_cap: usage.hardCap,
    overage_count: usage.overageCount,
    credited_count: usage.creditedCount,
    period_start: usage.periodStart,
    period_end: usage.periodEnd,
  });
});
