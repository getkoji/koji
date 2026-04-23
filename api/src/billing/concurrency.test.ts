import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { BillingAdapter, FeatureKey, PlanGateResult, UsageSummary, BillableEventInput } from "./adapter";
import { requireConcurrencySlot } from "./concurrency";
import type { Env } from "../env";

class StubBillingAdapter implements BillingAdapter {
  plan: string = "free";
  async canUse() { return { allowed: true, currentPlan: this.plan } as PlanGateResult; }
  async checkQuantityGate() { return { allowed: true, currentPlan: this.plan } as PlanGateResult; }
  async checkDocumentCap() { return { allowed: true, usage: {} as UsageSummary }; }
  async getUsageSummary() { return {} as UsageSummary; }
  async recordBillableEvent() {}
}

describe("requireConcurrencySlot", () => {
  it("passes through when no tenantId is set", async () => {
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("billing", new StubBillingAdapter());
      // deliberately don't set tenantId
      await next();
    });
    app.post("/run", requireConcurrencySlot(), (c) => c.json({ ok: true }));

    const res = await app.request("/run", { method: "POST" });
    expect(res.status).toBe(200);
  });

  // Full concurrency testing requires a real DB (jobs table query),
  // so we test the middleware's skip behavior for no-tenant paths.
  // Integration tests with a test DB cover the actual concurrency check.
});
