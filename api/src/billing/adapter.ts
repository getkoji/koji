/**
 * Billing adapter interface.
 *
 * Every billing provider (no-op for self-hosted, Stripe for hosted) implements
 * this interface. Route middleware calls `canUse()` / `checkQuantityGate()` /
 * `checkDocumentCap()` — it never knows which provider is behind it.
 *
 * Shapes follow `docs/specs/billing.md` §5.
 */

export type FeatureKey =
  | "max_schemas"
  | "max_pipelines"
  | "max_webhooks"
  | "max_sources"
  | "hitl_review"
  | "benchmarks"
  | "sso"
  | "audit_log_retention_days"
  | "byo_required";

export type PlanId = "free" | "scale" | "enterprise";

export interface PlanGateResult {
  allowed: boolean;
  currentPlan: PlanId;
  requiredPlan?: PlanId;
  /** For quantity gates: the plan limit. */
  limit?: number;
  /** For quantity gates: the current count. */
  current?: number;
}

export interface UsageSummary {
  /** Documents processed in the current billing period. */
  documentsThisPeriod: number;
  /** Included docs for this plan (null = unlimited). */
  includedDocuments: number | null;
  /** Hard cap (free tier only; null = no hard cap). */
  hardCap: number | null;
  /** Documents over the included amount. */
  overageCount: number;
  /** Credits issued this period (our bugs, not customer's). */
  creditedCount: number;
  /** Billing period start (first of the month). */
  periodStart: string;
  /** Billing period end (last day of the month). */
  periodEnd: string;
}

export interface BillableEventInput {
  kind: "document_processed" | "credit";
  quantity?: number;
  documentId?: string;
  jobId?: string;
  pipelineId?: string;
  schemaVersionId?: string;
  disposition: "billable" | "credited" | "disputable";
  creditReason?: string;
  creditEventId?: string;
  terminalState?: string;
  errorCause?: string;
}

export interface BillingAdapter {
  /**
   * Check whether a tenant's plan includes a boolean feature.
   * Used for features like benchmarks, SSO, HITL review.
   */
  canUse(tenantId: string, feature: FeatureKey): Promise<PlanGateResult>;

  /**
   * Check whether a tenant has capacity to create another resource.
   * Used for quantity-gated features (max_schemas, max_webhooks, etc).
   */
  checkQuantityGate(
    tenantId: string,
    feature: FeatureKey,
    currentCount: number,
  ): Promise<PlanGateResult>;

  /**
   * Check whether a tenant can process another document this period.
   * Free tier: hard cap (reject). Paid: always allowed (overage billed).
   */
  checkDocumentCap(tenantId: string): Promise<{ allowed: boolean; usage: UsageSummary }>;

  /**
   * Get the current usage summary for a tenant.
   */
  getUsageSummary(tenantId: string): Promise<UsageSummary>;

  /**
   * Record a billable event (document processed, credit, etc).
   * No-op in self-hosted; writes to billable_events in hosted.
   */
  recordBillableEvent(tenantId: string, event: BillableEventInput): Promise<void>;
}
