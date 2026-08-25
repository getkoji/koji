/**
 * Tests for the per-version run summary (oss-508).
 *
 * The contract: a version's accuracy is the MEDIAN of its own completed runs,
 * never a single draw, and never mixed with another version's runs. The figure
 * carries `n` and the observed spread so it can be read with the uncertainty it
 * actually has.
 */
import { describe, it, expect } from "vitest";
import { summarizeRuns, type RunAccuracy } from "./run-summary";

function run(accuracy: string | null, regressionsCount = 0, day = 1): RunAccuracy {
  return { accuracy, regressionsCount, createdAt: new Date(`2026-08-${String(day).padStart(2, "0")}`) };
}

describe("summarizeRuns", () => {
  it("returns nulls and n=0 for a version that was never validated", () => {
    expect(summarizeRuns([])).toEqual({
      accuracy: null,
      accuracyRuns: 0,
      accuracyMin: null,
      accuracyMax: null,
      regressions: null,
    });
  });

  it("takes the median, not the latest run", () => {
    // The most recent run is the outlier. Under the old rule it WAS the
    // reported accuracy; the median ignores it.
    const s = summarizeRuns([
      run("0.8100", 0, 1),
      run("0.8200", 0, 2),
      run("0.8000", 0, 3),
      run("0.8150", 0, 4),
      run("0.1000", 0, 5), // latest, and wild
    ]);
    expect(s.accuracy).toBe("0.8100");
    expect(s.accuracyRuns).toBe(5);
  });

  it("reports the spread the median hides", () => {
    const s = summarizeRuns([run("0.8000"), run("0.8500"), run("0.9000")]);
    expect(s.accuracy).toBe("0.8500");
    expect(s.accuracyMin).toBe("0.8000");
    expect(s.accuracyMax).toBe("0.9000");
  });

  it("takes an actual run for the even case, so regressions describe one run", () => {
    // Averaging the two middles would produce a number no run ever scored, and
    // there would be no run to take the regression count from.
    const s = summarizeRuns([
      run("0.7000", 3),
      run("0.8000", 1),
      run("0.9000", 0),
      run("0.9500", 0),
    ]);
    expect(s.accuracy).toBe("0.8000");
    expect(s.regressions).toBe(1); // the same run the accuracy came from
  });

  it("carries a single run through unchanged", () => {
    const s = summarizeRuns([run("0.6780", 2)]);
    expect(s).toEqual({
      accuracy: "0.6780",
      accuracyRuns: 1,
      accuracyMin: "0.6780",
      accuracyMax: "0.6780",
      regressions: 2,
    });
  });

  it("ignores runs with no accuracy recorded", () => {
    const s = summarizeRuns([run(null), run("0.5000"), run(null)]);
    expect(s.accuracyRuns).toBe(1);
    expect(s.accuracy).toBe("0.5000");
  });

  it("survives a non-numeric accuracy without reporting it", () => {
    const s = summarizeRuns([run("not a number"), run("0.5000")]);
    expect(s.accuracyRuns).toBe(1);
    expect(s.accuracy).toBe("0.5000");
  });
});
