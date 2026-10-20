/**
 * Unit tests for the shared invariant gate.
 *
 * The parity suite proves every implementation goes through this gate. These
 * tests prove the gate itself does the right thing — including the cases no
 * implementation currently produces, because the point of a single gate is
 * that the next implementation is covered before it is written.
 */

import { describe, expect, it } from "vitest";
import {
  clamp01,
  distributionConfidence,
  finalizeSelect,
  normalizeDistribution,
  synthesizeDistribution,
  validateSelectRequest,
} from "./invariants";
import { ABSTAIN, SelectContractError, SelectRequestError, type SelectCandidate } from "./types";

const A: SelectCandidate = { value: "a", raw: "A.", offset: 3, page: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } };
const B: SelectCandidate = { value: "b", offset: 11 };
const C: SelectCandidate = { value: "c", offset: 20 };
const OPTIONS = [A, B, C];

describe("validateSelectRequest", () => {
  it("indexes the candidates by value", () => {
    const byValue = validateSelectRequest("p", OPTIONS, 10);
    expect([...byValue.keys()]).toEqual(["a", "b", "c"]);
    expect(byValue.get("a")).toBe(A);
  });

  it("rejects an empty set", () => {
    expect(() => validateSelectRequest("p", [], 10)).toThrow(SelectRequestError);
  });

  it("rejects more options than the provider allows, rather than truncating", () => {
    expect(() => validateSelectRequest("p", OPTIONS, 2)).toThrow(/exceeds this provider's limit/);
  });

  it("rejects a duplicate value", () => {
    expect(() => validateSelectRequest("p", [A, { ...A }], 10)).toThrow(/duplicate candidate/);
  });

  it("rejects a candidate impersonating the abstain sentinel", () => {
    expect(() => validateSelectRequest("p", [{ value: ABSTAIN }], 10)).toThrow(/reserved/);
  });

  it("rejects an empty or non-string value", () => {
    expect(() => validateSelectRequest("p", [{ value: "" }], 10)).toThrow(/non-empty string/);
    expect(() =>
      validateSelectRequest("p", [{ value: 7 as unknown as string }], 10),
    ).toThrow(/non-empty string/);
  });
});

describe("clamp01", () => {
  it("clamps and sanitizes", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(7)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("distributionConfidence", () => {
  it("is 1 for a point mass and 0 for a uniform distribution", () => {
    expect(distributionConfidence([1, 0, 0])).toBeCloseTo(1, 10);
    expect(distributionConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0, 10);
  });

  it("is 1 for a single-option distribution, where entropy is undefined", () => {
    expect(distributionConfidence([1])).toBe(1);
  });

  it("falls as the distribution spreads", () => {
    const sharp = distributionConfidence([0.9, 0.05, 0.05]);
    const flat = distributionConfidence([0.4, 0.35, 0.25]);
    expect(sharp).toBeGreaterThan(flat);
  });
});

describe("normalizeDistribution", () => {
  it("drops keys the caller never supplied", () => {
    const out = normalizeDistribution({ a: 0.5, zzz: 0.5 }, ["a", "b"], "a");
    expect(Object.keys(out)).toEqual(["a"]);
    expect(out.a).toBeCloseTo(1, 10);
  });

  it("drops non-finite and non-positive mass", () => {
    const out = normalizeDistribution(
      { a: Number.NaN, b: -1, c: 0, d: 2 } as Record<string, number>,
      ["a", "b", "c", "d"],
      "d",
    );
    expect(out).toEqual({ d: 1 });
  });

  it("falls back to a point mass when nothing usable remains", () => {
    expect(normalizeDistribution({ zzz: 1 }, ["a"], "a")).toEqual({ a: 1 });
  });

  it("gives the named answer a zero entry rather than omitting it", () => {
    const out = normalizeDistribution({ b: 1 }, ["a", "b"], "a");
    expect(out.a).toBe(0);
    expect(out.b).toBeCloseTo(1, 10);
  });
});

describe("synthesizeDistribution", () => {
  it("spreads the remaining mass uniformly over the other keys", () => {
    const out = synthesizeDistribution(["a", "b", "c"], "a", 0.6);
    expect(out.a).toBeCloseTo(0.6, 10);
    expect(out.b).toBeCloseTo(0.2, 10);
    expect(out.c).toBeCloseTo(0.2, 10);
  });

  it("is a point mass when there is nowhere else to put the remainder", () => {
    expect(synthesizeDistribution(["a"], "a", 0.3)).toEqual({ a: 1 });
  });
});

describe("finalizeSelect", () => {
  const byValue = validateSelectRequest("p", OPTIONS, 10);

  it("returns the caller's candidate object, so provenance round-trips", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: true,
      choice: "a",
      probabilities: { a: 0.8, b: 0.2 },
      calibrated: true,
    });
    expect(result.selected).toBe(A);
    expect(result.selected!.bbox).toEqual(A.bbox);
    expect(result.abstained).toBe(false);
  });

  it("rejects a choice outside the candidate set", () => {
    expect(() =>
      finalizeSelect({
        provider: "p",
        byValue,
        allowAbstain: true,
        choice: "not-a-candidate",
        calibrated: false,
      }),
    ).toThrow(SelectContractError);
  });

  it("rejects an abstention on a request that did not offer one", () => {
    expect(() =>
      finalizeSelect({
        provider: "p",
        byValue,
        allowAbstain: false,
        choice: ABSTAIN,
        calibrated: false,
      }),
    ).toThrow(/did not offer abstention/);
  });

  it("rejects an empty choice", () => {
    expect(() =>
      finalizeSelect({ provider: "p", byValue, allowAbstain: true, choice: "", calibrated: false }),
    ).toThrow(/empty choice/);
  });

  it("prefers a provider's own confidence over the derived one", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: true,
      choice: "a",
      probabilities: { a: 0.5, b: 0.5 },
      reportedConfidence: 0.42,
      calibrated: true,
    });
    expect(result.confidence).toBeCloseTo(0.42, 10);
    expect(result.answerConfidence).toBeCloseTo(0.5, 10);
  });

  it("clamps a provider's out-of-range confidence", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: true,
      choice: "a",
      reportedConfidence: 11,
      calibrated: true,
    });
    expect(result.confidence).toBe(1);
  });

  it("synthesizes a distribution from a self-report when none was given", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: true,
      choice: "a",
      selfReportedConfidence: 0.4,
      calibrated: false,
    });
    expect(result.probabilities.a).toBeCloseTo(0.4, 10);
    expect(Object.values(result.probabilities).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 10);
    expect(result.calibrated).toBe(false);
  });

  it("nulls `selected` on an abstention", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: true,
      choice: ABSTAIN,
      selfReportedConfidence: 0,
      calibrated: false,
    });
    expect(result.selected).toBeNull();
    expect(result.abstained).toBe(true);
  });

  it("never emits a probability key the caller did not supply", () => {
    const result = finalizeSelect({
      provider: "p",
      byValue,
      allowAbstain: false,
      choice: "a",
      probabilities: { a: 0.6, b: 0.3, [ABSTAIN]: 0.1, invented: 9 },
      calibrated: true,
    });
    expect(Object.keys(result.probabilities).sort()).toEqual(["a", "b"]);
  });
});
