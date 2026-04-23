import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { BillingAdapter, FeatureKey, PlanGateResult, UsageSummary, BillableEventInput } from "./adapter";
import { requireFeature, requireQuantityGate, requireDocumentCap } from "./middleware";
import type { Env } from "../env";

/** Stub billing adapter where canUse / checkQuantityGate / checkDocumentCap
 *  return whatever the test wires up via the `nextResult` field. */
class StubBillingAdapter implements BillingAdapter {
  nextCanUse: PlanGateResult = { allowed: true, currentPlan: "scale" };
  nextQuantityGate: PlanGateResult = { allowed: true, currentPlan: "scale" };
  nextDocCap: { allowed: boolean; usage: UsageSummary } = {
    allowed: true,
    usage: {
      documentsThisPeriod: 0,
      includedDocuments: null,
      hardCap: null,
      overageCount: 0,
      creditedCount: 0,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
    },
  };

  async canUse(_t: string, _f: FeatureKey) { return this.nextCanUse; }
  async checkQuantityGate(_t: string, _f: FeatureKey, _c: number) { return this.nextQuantityGate; }
  async checkDocumentCap(_t: string) { return this.nextDocCap; }
  async getUsageSummary(_t: string) { return this.nextDocCap.usage; }
  async recordBillableEvent(_t: string, _e: BillableEventInput) {}
}

function makeApp(stub: StubBillingAdapter) {
  const app = new Hono<Env>();

  // Simulate the context injection that createApp does
  app.use("*", async (c, next) => {
    c.set("billing", stub);
    c.set("tenantId", "test-tenant-id");
    c.set("grants", new Set(["schema:write", "review:act"]));
    await next();
  });

  app.post("/gated-feature", requireFeature("benchmarks"), (c) =>
    c.json({ ok: true }),
  );

  app.post(
    "/gated-quantity",
    requireQuantityGate("max_schemas", async () => 3),
    (c) => c.json({ ok: true }),
  );

  app.post("/gated-doc-cap", requireDocumentCap(), (c) =>
    c.json({ ok: true }),
  );

  return app;
}

describe("requireFeature", () => {
  it("passes through when feature is allowed", async () => {
    const stub = new StubBillingAdapter();
    const app = makeApp(stub);

    const res = await app.request("/gated-feature", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 402 with plan_gate error when feature is denied", async () => {
    const stub = new StubBillingAdapter();
    stub.nextCanUse = { allowed: false, currentPlan: "free", requiredPlan: "scale" };
    const app = makeApp(stub);

    const res = await app.request("/gated-feature", { method: "POST" });
    expect(res.status).toBe(402);

    const body = await res.json() as any;
    expect(body.error.code).toBe("plan_gate");
    expect(body.error.current_plan).toBe("free");
    expect(body.error.required_plan).toBe("scale");
  });
});

describe("requireQuantityGate", () => {
  it("passes through when under limit", async () => {
    const stub = new StubBillingAdapter();
    const app = makeApp(stub);

    const res = await app.request("/gated-quantity", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("returns 402 when at limit", async () => {
    const stub = new StubBillingAdapter();
    stub.nextQuantityGate = {
      allowed: false,
      currentPlan: "free",
      requiredPlan: "scale",
      limit: 3,
      current: 3,
    };
    const app = makeApp(stub);

    const res = await app.request("/gated-quantity", { method: "POST" });
    expect(res.status).toBe(402);

    const body = await res.json() as any;
    expect(body.error.code).toBe("plan_gate");
    expect(body.error.limit).toBe(3);
    expect(body.error.current).toBe(3);
  });
});

describe("requireDocumentCap", () => {
  it("passes through when under cap", async () => {
    const stub = new StubBillingAdapter();
    const app = makeApp(stub);

    const res = await app.request("/gated-doc-cap", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("returns 402 when free tier hard cap reached", async () => {
    const stub = new StubBillingAdapter();
    stub.nextDocCap = {
      allowed: false,
      usage: {
        documentsThisPeriod: 500,
        includedDocuments: 500,
        hardCap: 500,
        overageCount: 0,
        creditedCount: 0,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      },
    };
    const app = makeApp(stub);

    const res = await app.request("/gated-doc-cap", { method: "POST" });
    expect(res.status).toBe(402);

    const body = await res.json() as any;
    expect(body.error.code).toBe("plan_gate");
    expect(body.error.usage.hard_cap).toBe(500);
    expect(body.error.usage.documents_this_period).toBe(500);
  });
});
