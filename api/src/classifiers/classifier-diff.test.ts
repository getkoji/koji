/**
 * Unit tests for classifier bump-derivation — the output-contract diff over the
 * set of class labels a classifier can emit. Mirrors ../schemas/schema-diff's
 * philosophy (removed = major, added = minor, tuning = patch).
 */
import { describe, it, expect } from "vitest";
import { deriveClassifierBump } from "./classifier-diff";

const cfg = (...ids: string[]) => ({ classes: ids.map((id) => ({ id })) });

describe("deriveClassifierBump", () => {
  it("returns patch when there is no active release (first version)", () => {
    expect(deriveClassifierBump(null, cfg("invoice"))).toBe("patch");
    expect(deriveClassifierBump(undefined, cfg("invoice"))).toBe("patch");
  });

  it("returns major when an existing class label is removed", () => {
    expect(deriveClassifierBump(cfg("invoice", "receipt"), cfg("invoice"))).toBe("major");
  });

  it("returns minor when a new class label is added", () => {
    expect(deriveClassifierBump(cfg("invoice"), cfg("invoice", "receipt"))).toBe("minor");
  });

  it("returns patch when the label set is unchanged (only tuning differs)", () => {
    const active = { classes: [{ id: "invoice", keywords: ["inv"] }] };
    const candidate = { classes: [{ id: "invoice", keywords: ["inv", "bill"], window: 5 }] };
    expect(deriveClassifierBump(active, candidate)).toBe("patch");
  });

  it("prefers major when a label is both added and removed (removal dominates)", () => {
    expect(deriveClassifierBump(cfg("a", "b"), cfg("a", "c"))).toBe("major");
  });

  it("a present-but-empty active config (no classes) makes any class an added label → minor", () => {
    expect(deriveClassifierBump({}, cfg("a"))).toBe("minor");
    expect(deriveClassifierBump({ classes: [] }, cfg("a"))).toBe("minor");
  });
});
