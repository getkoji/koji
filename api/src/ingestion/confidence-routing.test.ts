/**
 * Integration tests for the confidence-gate routing logic in
 * `ingestion/process.ts`.
 *
 * We don't spin up the full ingestion handler (DB + queue + storage + parse
 * + extract are a lot of plumbing) — we test the three composable helpers
 * the gate uses end-to-end so the routing decision can be reproduced
 * deterministically from a schema + extracted-values pair.
 *
 * This is the "any field below threshold => review" contract documented
 * in process.ts and the bug fix at the heart of oss-172: the LLM's
 * conservatively-calibrated self-confidence was flagging correct
 * extractions, particularly unambiguous enum picks.
 */

import { describe, it, expect } from "vitest";
import {
  computeFieldConfidences,
  aggregateDocConfidence,
  findLowestField,
} from "../extract/field-confidence";
import type { ProvenanceSpan } from "../extract/provenance";

const FOUND: ProvenanceSpan = { offset: 10, length: 5 };

/**
 * Replicate the routing decision from `process.ts` so tests can verify
 * the full chain (schema sweep → min aggregation → low-field detection
 * → routeToReview boolean).
 */
function decideRouting(
  schemaDef: Record<string, unknown>,
  extracted: Record<string, unknown>,
  threshold: number,
  provenance?: Record<string, ProvenanceSpan | null>,
): {
  fieldScores: Record<string, number>;
  docConfidence: number | null;
  lowField: { name: string; confidence: number } | null;
  routeToReview: boolean;
} {
  const fieldScores = computeFieldConfidences(schemaDef, extracted, provenance);
  const docConfidence = aggregateDocConfidence(fieldScores);
  const lowField = Number.isFinite(threshold)
    ? findLowestField(fieldScores, threshold)
    : null;
  const routeToReview = lowField !== null;
  return { fieldScores, docConfidence, lowField, routeToReview };
}

describe("confidence-gate routing (regression for oss-172)", () => {
  it("does NOT route an unambiguous enum pick to review at the default threshold", () => {
    // This is the original bug: LLM emits __confidence=0.7 on a perfectly
    // correct enum pick ("BOP" out of 12 options) and the 0.85 threshold
    // flags it. With deterministic scoring the score is 1.0.
    const schemaDef = {
      fields: {
        policy_type: {
          type: "enum",
          options: ["BOP", "GL", "Workers Compensation", "Auto"],
        },
      },
    };
    const { routeToReview, fieldScores } = decideRouting(
      schemaDef,
      { policy_type: "BOP" },
      0.85,
      { policy_type: FOUND },
    );
    expect(fieldScores.policy_type).toBe(1.0);
    expect(routeToReview).toBe(false);
  });

  it("routes when a single field falls below threshold (strict min aggregation)", () => {
    // One bad field is enough to flag the doc. The average-aggregation
    // logic this replaced would have hidden a 0.3 field under three 1.0
    // fields (avg=0.825) and routed to review only via the per-field path.
    // The new logic catches it directly via min.
    const schemaDef = {
      fields: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        bad: { type: "enum", options: ["X", "Y"] },
      },
    };
    const { routeToReview, lowField, docConfidence } = decideRouting(
      schemaDef,
      { a: "Acme", b: "Beta", c: "Charlie", bad: "Z" /* not in options */ },
      0.85,
      { a: FOUND, b: FOUND, c: FOUND, bad: FOUND },
    );
    expect(lowField).toEqual({ name: "bad", confidence: 0.0 });
    expect(docConfidence).toBe(0.0);
    expect(routeToReview).toBe(true);
  });

  it("does NOT route when all fields meet the threshold", () => {
    const schemaDef = {
      fields: {
        name: { type: "string" },
        amount: { type: "number", min: 0, max: 1_000_000 },
        date: { type: "date" },
        status: { type: "enum", options: ["active", "inactive"] },
      },
    };
    const { routeToReview } = decideRouting(
      schemaDef,
      {
        name: "Acme",
        amount: 1500,
        date: "2025-01-15",
        status: "active",
      },
      0.85,
      { name: FOUND, amount: FOUND, date: FOUND, status: FOUND },
    );
    expect(routeToReview).toBe(false);
  });

  it("does NOT route when optional fields are legitimately null", () => {
    // The original bug: optional-and-absent fields scored 0.0 from
    // LLM-self-confidence and dragged the doc average down. Our scorer
    // credits them at 1.0 when the schema allows null.
    const schemaDef = {
      fields: {
        primary: { type: "string", required: true },
        workers_comp_carrier: { type: "string" }, // optional, often null
        wc_policy_number: { type: "string" }, // optional, often null
      },
    };
    const { routeToReview, fieldScores } = decideRouting(
      schemaDef,
      {
        primary: "Acme",
        workers_comp_carrier: null,
        wc_policy_number: null,
      },
      0.85,
      { primary: FOUND },
    );
    expect(fieldScores.workers_comp_carrier).toBe(1.0);
    expect(fieldScores.wc_policy_number).toBe(1.0);
    expect(routeToReview).toBe(false);
  });

  it("routes when a required field is null", () => {
    const schemaDef = {
      fields: {
        primary: { type: "string", required: true },
      },
    };
    const { routeToReview, lowField } = decideRouting(
      schemaDef,
      { primary: null },
      0.85,
    );
    expect(lowField).toEqual({ name: "primary", confidence: 0.0 });
    expect(routeToReview).toBe(true);
  });

  it("routes free-text strings missing from source down to 0.7 (still below default)", () => {
    // A free-text string the resolver couldn't find in source: scored 0.7.
    // At the default 0.85 threshold this routes to review — the correct
    // behavior for fields whose value we can't verify against the document.
    const schemaDef = { fields: { vendor: { type: "string" } } };
    const { routeToReview, fieldScores } = decideRouting(
      schemaDef,
      { vendor: "Acme Corp" },
      0.85,
      { vendor: null },
    );
    expect(fieldScores.vendor).toBe(0.7);
    expect(routeToReview).toBe(true);
  });

  it("does not flag free-text strings missing from source when the threshold is relaxed", () => {
    const schemaDef = { fields: { vendor: { type: "string" } } };
    const { routeToReview } = decideRouting(
      schemaDef,
      { vendor: "Acme Corp" },
      0.65,
      { vendor: null },
    );
    expect(routeToReview).toBe(false);
  });

  it("handles a schema with no fields gracefully (no routing, no crash)", () => {
    const { routeToReview, docConfidence } = decideRouting({ fields: {} }, {}, 0.85);
    expect(routeToReview).toBe(false);
    expect(docConfidence).toBeNull();
  });

  it("date-format mismatch routes to review at default threshold (0.5 < 0.85)", () => {
    const schemaDef = {
      fields: { effective_date: { type: "date" } },
    };
    const { routeToReview, fieldScores } = decideRouting(
      schemaDef,
      { effective_date: "12/04/2025" }, // valid date, wrong format
      0.85,
    );
    expect(fieldScores.effective_date).toBe(0.5);
    expect(routeToReview).toBe(true);
  });

  it("number-out-of-range routes to review", () => {
    const schemaDef = {
      fields: { age: { type: "integer", min: 0, max: 150 } },
    };
    const { routeToReview, fieldScores } = decideRouting(
      schemaDef,
      { age: 500 },
      0.85,
    );
    expect(fieldScores.age).toBe(0.0);
    expect(routeToReview).toBe(true);
  });
});
