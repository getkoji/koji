import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { BillingAdapter, FeatureKey, PlanGateResult, UsageSummary, BillableEventInput } from "./adapter";
import { requireUploadRateLimit } from "./rate-limits";
import type { Env } from "../env";

class StubBillingAdapter implements BillingAdapter {
  plan: string = "free";
  async canUse() { return { allowed: true, currentPlan: this.plan } as PlanGateResult; }
  async checkQuantityGate() { return { allowed: true, currentPlan: this.plan } as PlanGateResult; }
  async checkDocumentCap() { return { allowed: true, usage: {} as UsageSummary }; }
  async getUsageSummary() { return {} as UsageSummary; }
  async recordBillableEvent() {}
}

function makeApp(stub: StubBillingAdapter) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("billing", stub);
    c.set("tenantId", "test-tenant");
    await next();
  });
  app.post("/upload", requireUploadRateLimit(), (c) => c.json({ ok: true }));
  return app;
}

describe("requireUploadRateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests under the limit", async () => {
    const stub = new StubBillingAdapter();
    stub.plan = "free"; // 10/min
    const app = makeApp(stub);

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/upload", { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit exceeded", async () => {
    const stub = new StubBillingAdapter();
    stub.plan = "free"; // 10/min
    const app = makeApp(stub);

    for (let i = 0; i < 10; i++) {
      await app.request("/upload", { method: "POST" });
    }

    const res = await app.request("/upload", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");

    const body = await res.json() as any;
    expect(body.error.code).toBe("rate_limited");
  });

  it("resets after window expires", async () => {
    const stub = new StubBillingAdapter();
    stub.plan = "free";
    const app = makeApp(stub);

    for (let i = 0; i < 10; i++) {
      await app.request("/upload", { method: "POST" });
    }

    // Blocked
    let res = await app.request("/upload", { method: "POST" });
    expect(res.status).toBe(429);

    // Advance past window
    vi.advanceTimersByTime(61_000);

    res = await app.request("/upload", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("scale plan gets higher limit", async () => {
    const stub = new StubBillingAdapter();
    stub.plan = "scale"; // 60/min
    const app = new Hono<Env>();
    app.use("*", async (c, next) => {
      c.set("billing", stub);
      c.set("tenantId", "scale-tenant");
      await next();
    });
    app.post("/upload", requireUploadRateLimit(), (c) => c.json({ ok: true }));

    for (let i = 0; i < 60; i++) {
      const res = await app.request("/upload", { method: "POST" });
      expect(res.status).toBe(200);
    }

    const res = await app.request("/upload", { method: "POST" });
    expect(res.status).toBe(429);
  });
});
