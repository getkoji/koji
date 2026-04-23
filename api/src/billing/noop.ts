/**
 * No-op billing adapter for self-hosted / OSS deployments.
 *
 * Per billing.md §12: self-hosted gets the Scale feature set for free.
 * All gates pass, no usage is tracked, no Stripe calls are made.
 */

import type {
  BillingAdapter,
  BillableEventInput,
  FeatureKey,
  PlanGateResult,
  UsageSummary,
} from "./adapter";

const NOOP_USAGE: UsageSummary = {
  documentsThisPeriod: 0,
  includedDocuments: null,
  hardCap: null,
  overageCount: 0,
  creditedCount: 0,
  periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
  periodEnd: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10),
};

const ALLOWED: PlanGateResult = { allowed: true, currentPlan: "scale" };

export class NoOpBillingAdapter implements BillingAdapter {
  async canUse(_tenantId: string, _feature: FeatureKey): Promise<PlanGateResult> {
    return ALLOWED;
  }

  async checkQuantityGate(
    _tenantId: string,
    _feature: FeatureKey,
    _currentCount: number,
  ): Promise<PlanGateResult> {
    return ALLOWED;
  }

  async checkDocumentCap(
    _tenantId: string,
  ): Promise<{ allowed: boolean; usage: UsageSummary }> {
    return { allowed: true, usage: NOOP_USAGE };
  }

  async getUsageSummary(_tenantId: string): Promise<UsageSummary> {
    return NOOP_USAGE;
  }

  async recordBillableEvent(_tenantId: string, _event: BillableEventInput): Promise<void> {
    // No-op: self-hosted deployments don't track billable events
  }
}
