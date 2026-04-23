import { describe, it, expect } from "vitest";
import { NoOpBillingAdapter } from "./noop";

describe("NoOpBillingAdapter", () => {
  const adapter = new NoOpBillingAdapter();

  it("canUse always returns allowed with scale plan", async () => {
    const result = await adapter.canUse("tenant-1", "hitl_review");
    expect(result.allowed).toBe(true);
    expect(result.currentPlan).toBe("scale");
  });

  it("checkQuantityGate always returns allowed", async () => {
    const result = await adapter.checkQuantityGate("tenant-1", "max_schemas", 999);
    expect(result.allowed).toBe(true);
  });

  it("checkDocumentCap always returns allowed with no hard cap", async () => {
    const { allowed, usage } = await adapter.checkDocumentCap("tenant-1");
    expect(allowed).toBe(true);
    expect(usage.hardCap).toBeNull();
    expect(usage.includedDocuments).toBeNull();
  });

  it("getUsageSummary returns zeroed usage", async () => {
    const usage = await adapter.getUsageSummary("tenant-1");
    expect(usage.documentsThisPeriod).toBe(0);
    expect(usage.overageCount).toBe(0);
    expect(usage.creditedCount).toBe(0);
  });

  it("recordBillableEvent is a no-op", async () => {
    // Should not throw
    await adapter.recordBillableEvent("tenant-1", {
      kind: "document_processed",
      disposition: "billable",
      terminalState: "delivered",
    });
  });
});
