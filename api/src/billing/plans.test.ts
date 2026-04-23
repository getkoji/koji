import { describe, it, expect } from "vitest";
import {
  PLANS,
  getEffectivePlan,
  getRequiredPlan,
  getEffectivePreflightLimits,
  featureLabel,
} from "./plans";

describe("PLANS", () => {
  it("defines free, scale, and enterprise tiers", () => {
    expect(Object.keys(PLANS)).toEqual(["free", "scale", "enterprise"]);
  });

  it("free tier has hard cap equal to included docs", () => {
    expect(PLANS.free.hardCapPerMonth).toBe(500);
    expect(PLANS.free.includedDocumentsPerMonth).toBe(500);
  });

  it("scale tier has no hard cap", () => {
    expect(PLANS.scale.hardCapPerMonth).toBeNull();
    expect(PLANS.scale.includedDocumentsPerMonth).toBe(5000);
  });

  it("enterprise has unlimited everything", () => {
    expect(PLANS.enterprise.features.max_schemas).toBeNull();
    expect(PLANS.enterprise.features.sso).toBe(true);
    expect(PLANS.enterprise.hardCapPerMonth).toBeNull();
  });

  it("free tier gates HITL, benchmarks, and SSO", () => {
    expect(PLANS.free.features.hitl_review).toBe(false);
    expect(PLANS.free.features.benchmarks).toBe(false);
    expect(PLANS.free.features.sso).toBe(false);
  });

  it("free tier has quantity limits", () => {
    expect(PLANS.free.features.max_schemas).toBe(3);
    expect(PLANS.free.features.max_pipelines).toBe(1);
    expect(PLANS.free.features.max_webhooks).toBe(1);
    expect(PLANS.free.features.max_sources).toBe(1);
  });

  it("scale tier unlocks HITL and benchmarks but not SSO", () => {
    expect(PLANS.scale.features.hitl_review).toBe(true);
    expect(PLANS.scale.features.benchmarks).toBe(true);
    expect(PLANS.scale.features.sso).toBe(false);
  });
});

describe("getEffectivePlan", () => {
  it("returns base plan when no overrides", () => {
    const plan = getEffectivePlan({ plan: "free" });
    expect(plan.id).toBe("free");
    expect(plan.features.max_schemas).toBe(3);
  });

  it("falls back to free for unknown plan", () => {
    const plan = getEffectivePlan({ plan: "nonexistent" as any });
    expect(plan.id).toBe("free");
  });

  it("applies pricing overrides", () => {
    const plan = getEffectivePlan({
      plan: "scale",
      priceOverrideUsd: 399,
      overagePriceOverrideUsd: 0.05,
    });
    expect(plan.priceMonthUsd).toBe(399);
    expect(plan.overagePricePerDocumentUsd).toBe(0.05);
    expect(plan.features.hitl_review).toBe(true); // unchanged
  });

  it("applies included docs override and updates hard cap for free tier", () => {
    const plan = getEffectivePlan({
      plan: "free",
      includedDocsOverride: 1000,
    });
    expect(plan.includedDocumentsPerMonth).toBe(1000);
    expect(plan.hardCapPerMonth).toBe(1000);
  });

  it("does not add hard cap to scale tier on docs override", () => {
    const plan = getEffectivePlan({
      plan: "scale",
      includedDocsOverride: 10000,
    });
    expect(plan.includedDocumentsPerMonth).toBe(10000);
    expect(plan.hardCapPerMonth).toBeNull();
  });

  it("applies feature overrides from planOverridesJson", () => {
    const plan = getEffectivePlan({
      plan: "free",
      planOverridesJson: { max_schemas: 10, hitl_review: true },
    });
    expect(plan.features.max_schemas).toBe(10);
    expect(plan.features.hitl_review).toBe(true);
    // Non-overridden features stay at free defaults
    expect(plan.features.max_pipelines).toBe(1);
    expect(plan.features.benchmarks).toBe(false);
  });

  it("allows setting features to null (unlimited) via overrides", () => {
    const plan = getEffectivePlan({
      plan: "free",
      planOverridesJson: { max_schemas: null },
    });
    expect(plan.features.max_schemas).toBeNull();
  });

  it("ignores unknown keys in planOverridesJson", () => {
    const plan = getEffectivePlan({
      plan: "free",
      planOverridesJson: { bogus_key: 42 } as any,
    });
    expect(plan.features.max_schemas).toBe(3); // unchanged
  });
});

describe("getRequiredPlan", () => {
  it("returns free for features available on free", () => {
    expect(getRequiredPlan("byo_required")).toBe("free");
  });

  it("returns scale for features first available on scale", () => {
    expect(getRequiredPlan("hitl_review")).toBe("scale");
    expect(getRequiredPlan("benchmarks")).toBe("scale");
  });

  it("returns enterprise for SSO", () => {
    expect(getRequiredPlan("sso")).toBe("enterprise");
  });
});

describe("getEffectivePreflightLimits", () => {
  it("returns base limits when no overrides", () => {
    const limits = getEffectivePreflightLimits(
      { plan: "free" },
      { max_pages: 25, max_size_mb: 10 },
    );
    expect(limits.max_pages).toBe(25);
    expect(limits.max_size_mb).toBe(10);
  });

  it("applies overrides from planOverridesJson", () => {
    const limits = getEffectivePreflightLimits(
      { plan: "free", planOverridesJson: { max_pages: 200 } },
      { max_pages: 25, max_size_mb: 10 },
    );
    expect(limits.max_pages).toBe(200);
    expect(limits.max_size_mb).toBe(10); // unchanged
  });

  it("allows setting limits to null (unlimited)", () => {
    const limits = getEffectivePreflightLimits(
      { plan: "scale", planOverridesJson: { max_pages: null, max_size_mb: null } },
      { max_pages: 500, max_size_mb: 100 },
    );
    expect(limits.max_pages).toBeNull();
    expect(limits.max_size_mb).toBeNull();
  });
});

describe("featureLabel", () => {
  it("returns human-readable labels", () => {
    expect(featureLabel("hitl_review")).toBe("HITL review");
    expect(featureLabel("max_schemas")).toBe("schemas");
    expect(featureLabel("sso")).toBe("SSO");
  });
});
