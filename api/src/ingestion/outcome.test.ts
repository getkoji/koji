/**
 * Tests for the shared post-extraction outcome decision (oss-359).
 *
 * `decideDocumentOutcome` is the ONE routing decision every pipeline
 * entrypoint (simple ingestion, DAG runner) must agree on. These tests pin
 * the contract that used to live inline in process.ts — and that the DAG
 * runner used to skip entirely (it delivered everything unconditionally).
 */
import { describe, it, expect } from "vitest";
import { decideDocumentOutcome } from "./outcome";
import type { ProvenanceSpan } from "../extract/provenance";

const FOUND: ProvenanceSpan = { offset: 10, length: 5 };

const SCHEMA = {
  fields: {
    name: { type: "string", required: true },
    items: { type: "array" },
    notes: { type: "string" }, // optional
  },
} as Record<string, unknown>;

describe("decideDocumentOutcome", () => {
  it("does not route when every field clears the threshold (array at high engine confidence)", () => {
    const o = decideDocumentOutcome({
      schemaDef: SCHEMA,
      extractResult: {
        extracted: { name: "Acme", items: [{ a: 1 }], notes: "x" },
        confidence_scores: { name: 0.95, items: 0.92, notes: 0.91 },
        provenance: { name: FOUND, items: FOUND, notes: FOUND },
      },
      reviewThreshold: "0.9",
    });
    expect(o.routeToReview).toBe(false);
    expect(o.lowField).toBeNull();
    expect(o.docConfidence).toBeCloseTo(0.91, 5); // min of field scores
  });

  it("routes on the lowest field below threshold, proposing that field's value", () => {
    const o = decideDocumentOutcome({
      schemaDef: SCHEMA,
      extractResult: {
        extracted: { name: "Acme", items: [{ a: 1 }, { a: 2 }], notes: "x" },
        confidence_scores: { name: 0.95, items: 0.4, notes: 0.91 },
        provenance: { name: FOUND, items: FOUND, notes: FOUND },
      },
      reviewThreshold: 0.9,
    });
    expect(o.routeToReview).toBe(true);
    expect(o.reviewField).toBe("items");
    expect(o.reviewConfidence).toBeCloseTo(0.4, 5);
    expect(o.proposedValue).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("re-credits optional nulls but keeps required nulls routing (oss-356 semantics)", () => {
    const optionalNull = decideDocumentOutcome({
      schemaDef: SCHEMA,
      extractResult: {
        extracted: { name: "Acme", items: [{ a: 1 }], notes: null },
        confidence_scores: { name: 0.95, items: 0.95, notes: 0 },
        provenance: { name: FOUND, items: FOUND, notes: null },
      },
      reviewThreshold: 0.9,
    });
    expect(optionalNull.routeToReview).toBe(false);

    const requiredNull = decideDocumentOutcome({
      schemaDef: SCHEMA,
      extractResult: {
        extracted: { name: null, items: [{ a: 1 }], notes: "x" },
        confidence_scores: { name: 0, items: 0.95, notes: 0.95 },
        provenance: { name: null, items: FOUND, notes: FOUND },
      },
      reviewThreshold: 0.9,
    });
    expect(requiredNull.routeToReview).toBe(true);
    expect(requiredNull.reviewField).toBe("name");
    expect(requiredNull.proposedValue).toBeNull();
  });

  it("skips routing entirely when the threshold isn't a number", () => {
    const o = decideDocumentOutcome({
      schemaDef: SCHEMA,
      extractResult: {
        extracted: { name: "Acme" },
        confidence_scores: { name: 0.1 },
        provenance: { name: FOUND },
      },
      reviewThreshold: null,
    });
    expect(o.routeToReview).toBe(false);
  });

  it("falls back to doc-level review shape with no field scores", () => {
    const o = decideDocumentOutcome({
      schemaDef: undefined,
      extractResult: { extracted: {}, confidence_scores: {} },
      reviewThreshold: 0.9,
    });
    expect(o.routeToReview).toBe(false); // nothing scored → nothing to flag
    expect(o.reviewField).toBe("document");
    expect(o.docConfidence).toBeNull();
  });
});
