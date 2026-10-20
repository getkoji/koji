import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  assertComparableScorerVersion,
  scorerVersionMismatch,
  scorerVersionsComparable,
  SCORER_VERSION,
} from "./version.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

describe("SCORER_VERSION", () => {
  it("matches package.json", () => {
    // The literal exists because esbuild bundling makes a runtime read of
    // package.json unreliable; this test is what keeps the two in sync.
    expect(SCORER_VERSION).toBe(pkg.version);
  });
});

describe("scorerVersionsComparable", () => {
  it("accepts identical versions", () => {
    expect(scorerVersionsComparable("0.2.0", "0.2.0")).toBe(true);
  });

  it("rejects different versions, including a patch apart", () => {
    // Patch-level changes move numbers (a date-parsing fix is a patch), so
    // "patches are comparable" is exactly the wrong rule.
    expect(scorerVersionsComparable("0.2.0", "0.2.1")).toBe(false);
    expect(scorerVersionsComparable("0.1.0", "0.2.0")).toBe(false);
  });

  it("rejects an unrecorded version", () => {
    expect(scorerVersionsComparable(undefined, "0.2.0")).toBe(false);
    expect(scorerVersionsComparable(null, "0.2.0")).toBe(false);
    expect(scorerVersionsComparable("", "0.2.0")).toBe(false);
  });
});

describe("assertComparableScorerVersion", () => {
  it("passes for this scorer's version", () => {
    expect(() => assertComparableScorerVersion(SCORER_VERSION)).not.toThrow();
  });

  it("refuses a comparison across versions and names both", () => {
    expect(() => assertComparableScorerVersion("0.1.0", "baseline run")).toThrow(/0\.1\.0/);
    expect(() => assertComparableScorerVersion("0.1.0", "baseline run")).toThrow(/baseline run/);
    expect(() => assertComparableScorerVersion("0.1.0", "baseline run")).toThrow(/not comparable/);
  });

  it("refuses an artifact with no stamp at all", () => {
    expect(() => assertComparableScorerVersion(undefined)).toThrow(/unrecorded scorer version/);
  });
});

describe("scorerVersionMismatch", () => {
  it("is null when the versions match", () => {
    expect(scorerVersionMismatch(SCORER_VERSION)).toBeNull();
  });

  it("returns a message instead of throwing, for read paths", () => {
    const message = scorerVersionMismatch("0.0.9", "stored run");
    expect(message).toContain("0.0.9");
    expect(message).toContain(SCORER_VERSION);
  });
});
