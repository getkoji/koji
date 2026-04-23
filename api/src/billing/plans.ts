/**
 * Plan definitions and effective-plan resolution.
 *
 * Shapes follow `docs/specs/billing.md` §2.1.
 *
 * These live in koji/ (not platform/) because even the no-op adapter
 * needs plan metadata to return correct gate results.
 */

import type { FeatureKey, PlanId } from "./adapter";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceMonthUsd: number | null;
  includedDocumentsPerMonth: number | null;
  overagePricePerDocumentUsd: number | null;
  /** Hard cap on documents per month (free tier only). null = no hard cap. */
  hardCapPerMonth: number | null;
  features: PlanFeatures;
}

export interface PlanFeatures {
  max_schemas: number | null;
  max_pipelines: number | null;
  max_webhooks: number | null;
  max_sources: number | null;
  hitl_review: boolean;
  benchmarks: boolean;
  sso: boolean;
  audit_log_retention_days: number;
  byo_required: boolean;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthUsd: 0,
    includedDocumentsPerMonth: 500,
    overagePricePerDocumentUsd: null,
    hardCapPerMonth: 500,
    features: {
      max_schemas: 3,
      max_pipelines: 1,
      max_webhooks: 1,
      max_sources: 1,
      hitl_review: false,
      benchmarks: false,
      sso: false,
      audit_log_retention_days: 7,
      byo_required: true,
    },
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceMonthUsd: 499,
    includedDocumentsPerMonth: 5000,
    overagePricePerDocumentUsd: 0.08,
    hardCapPerMonth: null,
    features: {
      max_schemas: null,
      max_pipelines: null,
      max_webhooks: null,
      max_sources: null,
      hitl_review: true,
      benchmarks: true,
      sso: false,
      audit_log_retention_days: 90,
      byo_required: true,
    },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceMonthUsd: null,
    includedDocumentsPerMonth: null,
    overagePricePerDocumentUsd: null,
    hardCapPerMonth: null,
    features: {
      max_schemas: null,
      max_pipelines: null,
      max_webhooks: null,
      max_sources: null,
      hitl_review: true,
      benchmarks: true,
      sso: true,
      audit_log_retention_days: -1, // unlimited
      byo_required: false,
    },
  },
};

export interface TenantPlanOverrides {
  plan: PlanId;
  priceOverrideUsd?: number | null;
  includedDocsOverride?: number | null;
  overagePriceOverrideUsd?: number | null;
  /** Sparse per-tenant feature/limit overrides. Keys present override the
   *  plan default; missing keys fall through. Supports both PlanFeatures
   *  keys (max_schemas, hitl_review, etc.) and PreflightLimits keys
   *  (max_pages, max_size_mb). */
  planOverridesJson?: Partial<PlanFeatures & PreflightOverrides> | null;
}

/** Preflight limits that can be overridden per tenant. */
export interface PreflightOverrides {
  max_pages: number | null;
  max_size_mb: number | null;
}

/**
 * Resolve the effective plan for a tenant by merging base plan
 * definitions with any per-tenant overrides (grandfathering, custom deals).
 *
 * Merge order: base plan → pricing overrides → feature overrides.
 * Feature overrides from `planOverridesJson` are sparse — only keys
 * present are applied, everything else falls through to the plan default.
 */
export function getEffectivePlan(tenant: TenantPlanOverrides): PlanDefinition {
  const base = PLANS[tenant.plan];
  if (!base) {
    return PLANS.free;
  }

  // Start with base plan
  const result = {
    ...base,
    features: { ...base.features },
  };

  // Pricing overrides
  if (tenant.priceOverrideUsd != null) {
    result.priceMonthUsd = tenant.priceOverrideUsd;
  }
  if (tenant.includedDocsOverride != null) {
    result.includedDocumentsPerMonth = tenant.includedDocsOverride;
    if (base.hardCapPerMonth != null) {
      result.hardCapPerMonth = tenant.includedDocsOverride;
    }
  }
  if (tenant.overagePriceOverrideUsd != null) {
    result.overagePricePerDocumentUsd = tenant.overagePriceOverrideUsd;
  }

  // Feature overrides from planOverridesJson (sparse merge)
  if (tenant.planOverridesJson) {
    const overrides = tenant.planOverridesJson;
    for (const key of Object.keys(overrides) as (keyof PlanFeatures)[]) {
      if (key in result.features && overrides[key] !== undefined) {
        (result.features as Record<string, unknown>)[key] = overrides[key];
      }
    }
  }

  return result;
}

/**
 * Resolve effective preflight limits for a tenant. Merges base plan
 * limits with per-tenant overrides from `planOverridesJson`.
 */
export function getEffectivePreflightLimits(
  tenant: TenantPlanOverrides,
  baseLimits: PreflightOverrides,
): PreflightOverrides {
  if (!tenant.planOverridesJson) return baseLimits;

  const o = tenant.planOverridesJson;
  return {
    max_pages: "max_pages" in o ? o.max_pages! : baseLimits.max_pages,
    max_size_mb: "max_size_mb" in o ? o.max_size_mb! : baseLimits.max_size_mb,
  };
}

/**
 * Get the minimum plan required for a boolean feature.
 * Used in error messages: "X is available on Scale and Enterprise plans."
 */
export function getRequiredPlan(feature: FeatureKey): PlanId {
  // Check from lowest tier up
  if (PLANS.free.features[feature as keyof PlanFeatures]) return "free";
  if (PLANS.scale.features[feature as keyof PlanFeatures]) return "scale";
  return "enterprise";
}

/**
 * Human-readable label for a feature key.
 */
export function featureLabel(feature: FeatureKey): string {
  const labels: Record<FeatureKey, string> = {
    max_schemas: "schemas",
    max_pipelines: "pipelines",
    max_webhooks: "webhooks",
    max_sources: "sources",
    hitl_review: "HITL review",
    benchmarks: "benchmarks",
    sso: "SSO",
    audit_log_retention_days: "audit log retention",
    byo_required: "managed model endpoints",
  };
  return labels[feature] ?? feature;
}
