import { describe, it, expect } from "vitest";
import { evaluateReleaseGate, gateRequested, describeBlock, type ReleaseGateSpec } from "./release-gate";
import type { ClassifierValidateResult, PerClassMetrics } from "./classify-scoring";

function cls(label: string, recall: number | null, precision: number | null): PerClassMetrics {
  return { label, support: 10, predicted: 10, tp: 8, fp: 0, fn: 0, recall, precision, f1: null };
}

function result(byClass: PerClassMetrics[]): ClassifierValidateResult {
  return {
    docsTotal: 20,
    docsCorrect: 18,
    docsFailed: 0,
    accuracy: 90,
    byClass,
    confusion: [],
    tierHistogram: {},
    escalationRate: null,
    flips: { fixed: 0, regressed: 0, churned: 0, items: [] },
    costUsd: null,
  };
}

describe("gateRequested", () => {
  it("is false for an empty spec (no gate → promote proceeds ungated)", () => {
    expect(gateRequested({})).toBe(false);
  });
  it("is true when any gate field is set", () => {
    expect(gateRequested({ requireNoRegressions: true })).toBe(true);
    expect(gateRequested({ mustNotRegress: ["coi"] })).toBe(true);
    expect(gateRequested({ mustNotRegress: [] })).toBe(false);
    expect(gateRequested({ minRecall: { coi: 0.9 } })).toBe(true);
    expect(gateRequested({ minRecall: {} })).toBe(false);
  });
});

describe("evaluateReleaseGate — requireNoRegressions", () => {
  it("allows when every class holds or improves vs baseline", () => {
    const base = result([cls("coi", 1.0, 1.0), cls("policy", 0.9, 0.9)]);
    const cand = result([cls("coi", 1.0, 1.0), cls("policy", 0.95, 0.9)]);
    expect(evaluateReleaseGate(cand, base, { requireNoRegressions: true }).ok).toBe(true);
  });

  it("blocks the field-reported failure: lifting one class silently drops another", () => {
    // policy gains, but coi recall drops 100%→91% and its precision leaks 100%→80%.
    const base = result([cls("coi", 1.0, 1.0), cls("policy", 0.5, 0.9)]);
    const cand = result([cls("coi", 0.91, 0.8), cls("policy", 0.87, 0.9)]);
    const r = evaluateReleaseGate(cand, base, { requireNoRegressions: true });
    expect(r.ok).toBe(false);
    const coiBlocks = r.blocks.filter((b) => b.class === "coi");
    expect(coiBlocks.map((b) => b.metric).sort()).toEqual(["precision", "recall"]);
    const recall = coiBlocks.find((b) => b.metric === "recall")!;
    expect(recall.kind).toBe("regression");
    expect(recall.before).toBe(1.0);
    expect(recall.after).toBe(0.91);
  });

  it("does not flag a numerically identical metric as a drop (float slack)", () => {
    const base = result([cls("coi", 0.3333333333, 1.0)]);
    const cand = result([cls("coi", 0.3333333333, 1.0)]);
    expect(evaluateReleaseGate(cand, base, { requireNoRegressions: true }).ok).toBe(true);
  });

  it("treats a class the candidate dropped entirely as a regression", () => {
    const base = result([cls("coi", 1.0, 1.0)]);
    const cand = result([]); // coi no longer measured
    const r = evaluateReleaseGate(cand, base, { requireNoRegressions: true });
    expect(r.ok).toBe(false);
    expect(r.blocks.some((b) => b.class === "coi" && b.after === null)).toBe(true);
  });

  it("cannot regress with no baseline (first-ever release)", () => {
    const cand = result([cls("coi", 0.5, 0.5)]);
    expect(evaluateReleaseGate(cand, null, { requireNoRegressions: true }).ok).toBe(true);
  });
});

describe("evaluateReleaseGate — named classes only", () => {
  it("ignores a drop in an unnamed class", () => {
    const base = result([cls("coi", 1.0, 1.0), cls("policy", 1.0, 1.0)]);
    const cand = result([cls("coi", 1.0, 1.0), cls("policy", 0.5, 0.5)]);
    // Only guard coi — policy's drop is allowed.
    expect(evaluateReleaseGate(cand, base, { mustNotRegress: ["coi"] }).ok).toBe(true);
  });

  it("blocks a drop in a named class", () => {
    const base = result([cls("coi", 1.0, 1.0), cls("policy", 1.0, 1.0)]);
    const cand = result([cls("coi", 1.0, 1.0), cls("policy", 0.5, 1.0)]);
    const r = evaluateReleaseGate(cand, base, { mustNotRegress: ["policy"] });
    expect(r.ok).toBe(false);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatchObject({ class: "policy", metric: "recall", before: 1.0, after: 0.5 });
  });
});

describe("evaluateReleaseGate — absolute floors", () => {
  it("blocks a class under the recall floor even with no regression", () => {
    const cand = result([cls("coi", 0.8, 1.0)]);
    const r = evaluateReleaseGate(cand, cand, { minRecall: { coi: 0.9 } });
    expect(r.ok).toBe(false);
    expect(r.blocks[0]).toMatchObject({ class: "coi", metric: "recall", kind: "floor", floor: 0.9, after: 0.8 });
  });

  it("passes a class that clears the floor", () => {
    const cand = result([cls("coi", 0.95, 1.0)]);
    expect(evaluateReleaseGate(cand, cand, { minRecall: { coi: 0.9 } }).ok).toBe(true);
  });

  it("blocks a floor on a class absent from the candidate run", () => {
    const cand = result([cls("coi", 1.0, 1.0)]);
    const r = evaluateReleaseGate(cand, cand, { minPrecision: { policy: 0.8 } });
    expect(r.ok).toBe(false);
    expect(r.blocks[0]).toMatchObject({ class: "policy", metric: "precision", kind: "floor", after: null });
  });
});

describe("describeBlock", () => {
  it("renders a regression with before → after", () => {
    expect(describeBlock({ class: "coi", metric: "recall", kind: "regression", before: 1.0, after: 0.91 })).toBe(
      "coi recall regressed 100% → 91%",
    );
  });
  it("renders a floor violation", () => {
    expect(describeBlock({ class: "coi", metric: "recall", kind: "floor", before: null, after: 0.8, floor: 0.9 })).toBe(
      "coi recall 80% is below the required floor 90%",
    );
  });
});
