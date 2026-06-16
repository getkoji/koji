import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type {
  BillingAdapter,
  FeatureKey,
  PlanGateResult,
  UsageSummary,
} from "./adapter";
import { requireConcurrencySlot } from "./concurrency";
import type { Env } from "../env";

/**
 * Stub adapter that lets each test pin the gate result the middleware
 * sees. We don't talk to a real DB here — the integration tests in
 * `api/tests/integration/` cover the running-jobs count query end to
 * end. These cases focus on the middleware's branching: tenant id
 * present/absent, limit null vs numeric, and the fact that the limit
 * value flows through unchanged from `checkQuantityGate`.
 */
class StubBillingAdapter implements BillingAdapter {
  constructor(
    private readonly gate: (feature: FeatureKey) => PlanGateResult = () => ({
      allowed: true,
      currentPlan: "free",
    }),
  ) {}
  async canUse(_tenantId: string, feature: FeatureKey) {
    return this.gate(feature);
  }
  async checkQuantityGate(_tenantId: string, feature: FeatureKey) {
    return this.gate(feature);
  }
  async checkDocumentCap() {
    return { allowed: true, usage: {} as UsageSummary };
  }
  async getUsageSummary() {
    return {} as UsageSummary;
  }
  async recordBillableEvent() {}
}

describe("requireConcurrencySlot", () => {
  it("passes through when no tenantId is set", async () => {
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("billing", new StubBillingAdapter());
      await next();
    });
    app.post("/run", requireConcurrencySlot(), (c) => c.json({ ok: true }));

    const res = await app.request("/run", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("passes through when the effective limit is null (unlimited)", async () => {
    // Enterprise default, or any tier with override pinning to null.
    // The middleware MUST short-circuit before the DB count query —
    // otherwise unlimited concurrency would still pay for the SELECT.
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("tenantId", "tenant-1");
      c.set(
        "billing",
        new StubBillingAdapter(() => ({
          allowed: true,
          currentPlan: "enterprise",
          // limit absent === unlimited
        })),
      );
      await next();
    });
    app.post("/run", requireConcurrencySlot(), (c) => c.json({ ok: true }));

    const res = await app.request("/run", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("requests max_concurrent_jobs from the adapter (override path)", async () => {
    // Pins the contract that the middleware reads `max_concurrent_jobs`
    // specifically. If someone retypes "max_jobs" or copies the old
    // hard-coded path, this assertion catches it.
    let askedFor: FeatureKey | null = null;
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("tenantId", "tenant-1");
      c.set(
        "billing",
        new StubBillingAdapter((feature) => {
          askedFor = feature;
          return {
            allowed: true,
            currentPlan: "enterprise",
          };
        }),
      );
      await next();
    });
    app.post("/run", requireConcurrencySlot(), (c) => c.json({ ok: true }));

    await app.request("/run", { method: "POST" });
    expect(askedFor).toBe("max_concurrent_jobs");
  });

  // Numeric-limit cases (running >= limit → 429) need a real jobs table
  // because the middleware queries it via withRLS. Those live in the
  // integration suite — left as a comment marker so it's clear what's
  // intentionally not unit-covered.
});
