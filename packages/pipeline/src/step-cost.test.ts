import { describe, it, expect } from "vitest";
import { STEP_TYPES, STEP_COSTS, stepCost } from "./types";

describe("stepCost", () => {
  // The defect this guards (oss-518): the DAG runner and the pipeline test
  // endpoint each kept a private Record<string, number> copy of this table, and
  // all three drifted. Production was missing every step from `redact` down, so
  // a pipeline containing one was estimated at one price and reported another.
  it("prices every declared step type", () => {
    const unpriced = STEP_TYPES.filter(t => STEP_COSTS[t] === undefined);
    expect(unpriced).toEqual([]);
  });

  it("has no price for a type that isn't a declared step", () => {
    const stray = Object.keys(STEP_COSTS).filter(k => !(STEP_TYPES as readonly string[]).includes(k));
    expect(stray).toEqual([]);
  });

  it("agrees with the table for every declared type", () => {
    for (const t of STEP_TYPES) expect(stepCost(t)).toBe(STEP_COSTS[t]);
  });

  it("returns 0 for an unknown step type rather than undefined", () => {
    // Step types come from user YAML, so a build can meet one it doesn't know.
    // NaN or undefined here would poison a run's summed cost.
    expect(stepCost("not_a_step")).toBe(0);
    expect(stepCost("")).toBe(0);
  });

  it("does not resolve inherited Object properties as prices", () => {
    // `STEP_COSTS["constructor"]` is a function on a bare object literal, which
    // would sum into a cost total as NaN.
    expect(stepCost("constructor")).toBe(0);
    expect(stepCost("toString")).toBe(0);
  });

  it("prices are finite non-negative numbers", () => {
    for (const t of STEP_TYPES) {
      expect(Number.isFinite(STEP_COSTS[t])).toBe(true);
      expect(STEP_COSTS[t]).toBeGreaterThanOrEqual(0);
    }
  });
});
