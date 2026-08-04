import { describe, it, expect, beforeEach } from "vitest";

import { initBilling, recordDeliveryBillableEvent } from "./process";
import { NoOpBillingAdapter } from "../billing/noop";
import type { BillableEventInput, BillingAdapter } from "../billing/adapter";

/**
 * Guards the billing contract shared by the two ingestion entrypoints.
 *
 * The DAG runner used to terminate documents without recording anything, so
 * every document finishing under a router pipeline was invisible to metering.
 * Both entrypoints now route through `recordDeliveryBillableEvent`; these tests
 * pin the mapping it applies.
 */

class RecordingBillingAdapter extends NoOpBillingAdapter implements BillingAdapter {
  events: Array<{ tenantId: string; event: BillableEventInput }> = [];

  async recordBillableEvent(tenantId: string, event: BillableEventInput): Promise<void> {
    this.events.push({ tenantId, event });
  }
}

class ExplodingBillingAdapter extends NoOpBillingAdapter implements BillingAdapter {
  async recordBillableEvent(): Promise<void> {
    throw new Error("billing table unreachable");
  }
}

describe("recordDeliveryBillableEvent", () => {
  let billing: RecordingBillingAdapter;

  beforeEach(() => {
    billing = new RecordingBillingAdapter();
    initBilling(billing);
  });

  it("bills a delivered document as terminal state 'delivered'", async () => {
    await recordDeliveryBillableEvent("tenant-1", {
      documentId: "doc-1",
      jobId: "job-1",
      pipelineId: "pipe-1",
      routeToReview: false,
    });

    expect(billing.events).toHaveLength(1);
    expect(billing.events[0]!.tenantId).toBe("tenant-1");
    expect(billing.events[0]!.event).toMatchObject({
      kind: "document_processed",
      documentId: "doc-1",
      jobId: "job-1",
      pipelineId: "pipe-1",
      disposition: "billable",
      terminalState: "delivered",
    });
  });

  it("bills a review-routed document — review is a successful terminal state", async () => {
    await recordDeliveryBillableEvent("tenant-1", {
      documentId: "doc-2",
      jobId: "job-1",
      routeToReview: true,
    });

    expect(billing.events).toHaveLength(1);
    expect(billing.events[0]!.event).toMatchObject({
      disposition: "billable",
      terminalState: "review",
    });
  });

  it("passes the schema version through when the caller resolved one", async () => {
    await recordDeliveryBillableEvent("tenant-1", {
      documentId: "doc-3",
      jobId: "job-1",
      schemaVersionId: "ver-9",
      routeToReview: false,
    });

    expect(billing.events[0]!.event.schemaVersionId).toBe("ver-9");
  });

  it("tolerates the DAG path having no schema version id", async () => {
    await recordDeliveryBillableEvent("tenant-1", {
      documentId: "doc-4",
      jobId: "job-1",
      routeToReview: false,
    });

    expect(billing.events).toHaveLength(1);
    expect(billing.events[0]!.event.schemaVersionId).toBeUndefined();
  });

  it("swallows billing failures — a delivered document must not be un-done", async () => {
    initBilling(new ExplodingBillingAdapter());

    await expect(
      recordDeliveryBillableEvent("tenant-1", {
        documentId: "doc-5",
        jobId: "job-1",
        routeToReview: false,
      }),
    ).resolves.toBeUndefined();
  });
});
