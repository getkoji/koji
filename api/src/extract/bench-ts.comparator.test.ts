/**
 * Guard: the TS bench must not grow its own comparator again.
 *
 * `bench-ts.ts` carried one until oss-562, and it was wrong in two ways that
 * both inflated the benchmark:
 *
 *   - its "fuzzy" branch compared character MULTISETS rather than edit
 *     distance, so any anagram matched at the default 0.85 threshold —
 *     including "12/31/2026" vs "13/21/2026", which is a different date.
 *   - an array field scored correct whenever extraction returned ANY non-empty
 *     array, whatever it contained, so line items and coverages went unscored.
 *
 * A benchmark that grades itself is worse than no benchmark, so this file fails
 * if comparison logic reappears instead of delegating to `@koji/score`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "bench-ts.ts"), "utf8");

describe("bench-ts delegates comparison", () => {
  it("imports the shared scorer", () => {
    expect(SOURCE).toMatch(/from "@koji\/score"/);
    expect(SOURCE).toMatch(/compareValues\(/);
  });

  it("defines no comparator of its own", () => {
    const banned = [
      "function fuzzyMatch",
      "function levenshtein",
      "function stringSimilarity",
      "function normalizeDate",
      "function toNumber",
    ];
    expect(banned.filter((name) => SOURCE.includes(name))).toEqual([]);
  });

  it("does not score an array by its length alone", () => {
    // The old branch was:
    //   match: Array.isArray(actualValue) && actualValue.length > 0
    expect(SOURCE).not.toMatch(/Array\.isArray\([a-zA-Z]+\)\s*&&\s*[a-zA-Z]+\.length\s*>\s*0/);
  });

  it("does not reintroduce a global fuzzy threshold", () => {
    // Equivalence is declared per field with `match:`, not by one number for a
    // whole schema. The legacy key is warned about, never applied.
    expect(SOURCE).not.toMatch(/fuzzyThreshold/);
  });
});
