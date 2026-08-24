/**
 * Tests for the validate-run assembly step — the pure function that sorts
 * per-doc progress rows into scored results vs surfaced failures before the
 * finalizer computes the ValidateResult (oss-348).
 *
 * The contract under test: every progress row lands in EXACTLY one bucket,
 * failures keep their recorded error, and a doc whose extraction row is
 * missing fails honestly instead of scoring as an empty extraction.
 */
import { describe, it, expect } from "vitest";
import { assembleValidateInputs, type FinalizeDocRow } from "./validate-run";
import { checkRunSanity, computeValidateResult } from "./validate-scoring";

function okRow(entryId: string, routingPlan: unknown = null): FinalizeDocRow {
  return { corpusEntryId: entryId, status: "ok", errorMessage: null, routingPlanJson: routingPlan };
}

const entries = new Map([
  ["e1", { filename: "a.pdf", groundTruthJson: { policy: "X-1" } }],
  ["e2", { filename: "b.pdf", groundTruthJson: { policy: "Y-2" } }],
]);

const extractions = new Map([
  ["e1", { extractedJson: { policy: "X-1" }, confidenceScoresJson: { policy: 0.9 } }],
  ["e2", { extractedJson: { policy: "Y-2" }, confidenceScoresJson: null }],
]);

describe("assembleValidateInputs", () => {
  it("scores ok docs and carries ground truth, extraction, and routing plan through", () => {
    const plan = { policy: { source: "hint", chunks: [{ index: 0, title: "Decs" }], text: "X-1" } };
    const { results, parseFailures } = assembleValidateInputs(
      [okRow("e1", plan), okRow("e2")],
      entries,
      extractions,
    );
    expect(parseFailures).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      entryId: "e1",
      filename: "a.pdf",
      groundTruth: { policy: "X-1" },
      extracted: { policy: "X-1" },
      confidenceScores: { policy: 0.9 },
      routingPlan: plan,
    });
    // Null confidence column degrades to {} — never undefined access downstream.
    expect(results[1]!.confidenceScores).toEqual({});
    expect(results[1]!.routingPlan).toBeUndefined();
  });

  it("puts failed docs in parseFailures with their recorded error", () => {
    const { results, parseFailures } = assembleValidateInputs(
      [
        okRow("e1"),
        { corpusEntryId: "e2", status: "failed", errorMessage: "parse returned empty markdown", routingPlanJson: null },
      ],
      entries,
      extractions,
    );
    expect(results.map((r) => r.entryId)).toEqual(["e1"]);
    expect(parseFailures).toEqual([
      { entryId: "e2", filename: "b.pdf", error: "parse returned empty markdown" },
    ]);
  });

  it("fails a doc whose extraction row is missing instead of scoring it empty", () => {
    const { results, parseFailures } = assembleValidateInputs(
      [okRow("e1"), okRow("e2")],
      entries,
      new Map([["e1", extractions.get("e1")!]]), // e2's insert never landed
    );
    expect(results.map((r) => r.entryId)).toEqual(["e1"]);
    expect(parseFailures).toEqual([
      { entryId: "e2", filename: "b.pdf", error: "extraction result missing" },
    ]);
  });

  it("falls back to the entry id as filename when the corpus entry is gone", () => {
    const { results, parseFailures } = assembleValidateInputs(
      [okRow("e3")],
      entries,
      extractions,
    );
    expect(results).toEqual([]);
    expect(parseFailures).toEqual([
      { entryId: "e3", filename: "e3", error: "extraction result missing" },
    ]);
  });

  it("every row lands in exactly one bucket", () => {
    const rows: FinalizeDocRow[] = [
      okRow("e1"),
      { corpusEntryId: "e2", status: "failed", errorMessage: "boom", routingPlanJson: null },
      okRow("e3"),
    ];
    const { results, parseFailures } = assembleValidateInputs(rows, entries, extractions);
    expect(results.length + parseFailures.length).toBe(rows.length);
  });
});

// ---------------------------------------------------------------------------
// Run sanity gate (oss-500)
// ---------------------------------------------------------------------------

describe("checkRunSanity", () => {
  it("passes an ordinary result", () => {
    expect(checkRunSanity({ overallAccuracy: 81.4, scoredCount: 250, docsTotal: 50 })).toBeNull();
  });

  it("passes a genuinely poor result that still measured something", () => {
    expect(checkRunSanity({ overallAccuracy: 4.2, scoredCount: 250, docsTotal: 50 })).toBeNull();
  });

  it("fails a run that scored nothing, however many documents it saw", () => {
    // The silent case: `overallAccuracy` is reported as 100 when no comparison
    // is made, so this run would have recorded a perfect score for measuring
    // nothing at all.
    const reason = checkRunSanity({ overallAccuracy: 100, scoredCount: 0, docsTotal: 50 });
    expect(reason).toContain("Nothing was scored");
    expect(checkRunSanity({ overallAccuracy: 100, scoredCount: 0, docsTotal: 1 })).not.toBeNull();
  });

  it("fails a clean 0% over a corpus large enough to make it implausible", () => {
    // The observed production case: 50 documents, accuracy exactly 0.0000,
    // recorded as a successful run after several minutes of work.
    const reason = checkRunSanity({ overallAccuracy: 0, scoredCount: 400, docsTotal: 50 });
    expect(reason).toContain("Scored 0.0%");
  });

  it("allows a 0% on a corpus small enough for it to be a real verdict", () => {
    // One or two documents against a badly-matched schema really can be 0%.
    expect(checkRunSanity({ overallAccuracy: 0, scoredCount: 3, docsTotal: 1 })).toBeNull();
    expect(checkRunSanity({ overallAccuracy: 0, scoredCount: 8, docsTotal: 4 })).toBeNull();
  });

  it("catches the empty-ground-truth run end to end", () => {
    // Ground truth present but with no keys: nothing to compare, so scoring
    // reports 100% over zero comparisons. The gate is what stops that from
    // being published as a perfect schema.
    const result = computeValidateResult(
      [
        { entryId: "e1", filename: "a.pdf", groundTruth: {}, extracted: { policy: "X-1" }, confidence: {} },
        { entryId: "e2", filename: "b.pdf", groundTruth: {}, extracted: { policy: "Y-2" }, confidence: {} },
      ],
      new Map(),
      1,
      Date.now(),
    );
    expect(result.overallAccuracy).toBe(100);
    expect(result.scoredCount).toBe(0);
    expect(checkRunSanity(result)).toContain("Nothing was scored");
  });
});
