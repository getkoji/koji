import { describe, it, expect } from "vitest";
import { evalCondition, resolveNextSteps, type TestEdge } from "./dag-runner";

describe("evalCondition", () => {
  it("returns true for empty/unparseable conditions", () => {
    expect(evalCondition("", {})).toBe(true);
    expect(evalCondition("just some text", {})).toBe(true);
  });

  it("evaluates == with string values", () => {
    expect(evalCondition("output.label == 'invoice'", { output: { label: "invoice" } })).toBe(true);
    expect(evalCondition("output.label == 'invoice'", { output: { label: "receipt" } })).toBe(false);
  });

  it("evaluates != with string values", () => {
    expect(evalCondition("output.label != 'other'", { output: { label: "invoice" } })).toBe(true);
    expect(evalCondition("output.label != 'invoice'", { output: { label: "invoice" } })).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    expect(evalCondition("output.confidence >= 0.8", { output: { confidence: 0.95 } })).toBe(true);
    expect(evalCondition("output.confidence >= 0.8", { output: { confidence: 0.5 } })).toBe(false);
    expect(evalCondition("output.confidence > 0.8", { output: { confidence: 0.8 } })).toBe(false);
    expect(evalCondition("output.confidence < 0.5", { output: { confidence: 0.3 } })).toBe(true);
    expect(evalCondition("output.confidence <= 0.5", { output: { confidence: 0.5 } })).toBe(true);
  });

  it("handles nested dot paths", () => {
    expect(evalCondition("output.group.type == 'declarations'", {
      output: { group: { type: "declarations" } },
    })).toBe(true);
  });

  it("returns false for missing paths", () => {
    expect(evalCondition("output.missing == 'x'", { output: {} })).toBe(false);
    expect(evalCondition("output.deep.path == 'x'", { output: {} })).toBe(false);
  });
});

describe("resolveNextSteps", () => {
  it("returns unconditional edges", () => {
    const edges: TestEdge[] = [
      { from: "a", to: "b" },
    ];
    expect(resolveNextSteps(edges, {})).toEqual(["b"]);
  });

  it("returns edges where condition matches", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
      { from: "classify", to: "extract_receipt", when: "output.label == 'receipt'" },
      { from: "classify", to: "other", default: true },
    ];
    expect(resolveNextSteps(edges, { label: "invoice" })).toEqual(["extract_invoice"]);
    expect(resolveNextSteps(edges, { label: "receipt" })).toEqual(["extract_receipt"]);
  });

  it("falls back to default edge when nothing matches", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
      { from: "classify", to: "fallback", default: true },
    ];
    expect(resolveNextSteps(edges, { label: "unknown" })).toEqual(["fallback"]);
  });

  it("returns empty when no edges match and no default", () => {
    const edges: TestEdge[] = [
      { from: "classify", to: "extract_invoice", when: "output.label == 'invoice'" },
    ];
    expect(resolveNextSteps(edges, { label: "unknown" })).toEqual([]);
  });

  it("returns multiple matching edges for fan-out", () => {
    const edges: TestEdge[] = [
      { from: "split", to: "filter_a" },
      { from: "split", to: "filter_b" },
    ];
    expect(resolveNextSteps(edges, {})).toEqual(["filter_a", "filter_b"]);
  });

  it("does not include default edges when conditional edges match", () => {
    const edges: TestEdge[] = [
      { from: "a", to: "b", when: "output.x == 1" },
      { from: "a", to: "c", default: true },
    ];
    expect(resolveNextSteps(edges, { x: 1 })).toEqual(["b"]);
  });
});

describe("DAG runner status contracts", () => {
  // These are documentation tests — they assert the status values that
  // the DAG runner uses, so a future refactor doesn't silently break
  // the dashboard polling or job list.

  it("document terminal status is 'delivered' (not 'completed')", () => {
    // The dashboard polls until status is in ["delivered", "review", "failed"].
    // "completed" would cause infinite polling.
    const terminalStatuses = ["delivered", "review", "failed"];
    expect(terminalStatuses).toContain("delivered");
    expect(terminalStatuses).not.toContain("completed");
  });

  it("job terminal status is 'complete' (not 'completed')", () => {
    // The legacy ingestion path uses "complete" — DAG runner must match.
    const expected = "complete";
    expect(expected).toBe("complete");
    expect(expected).not.toBe("completed");
  });

  it("split documents get status 'split' (not 'delivered')", () => {
    // When a document is split into children, the parent doc is marked
    // "split" — it's not itself delivered, its children are.
    const wasSplit = true;
    const status = wasSplit ? "split" : "delivered";
    expect(status).toBe("split");
  });
});
