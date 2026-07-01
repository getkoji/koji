import { describe, it, expect } from "vitest";
import { compareValues, formatValue, type ArrayDiff, type ObjectDiff } from "./value-compare";

describe("formatValue", () => {
  it("renders scalars plainly", () => {
    expect(formatValue("hello")).toBe("hello");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
  });

  it("renders objects compactly instead of [object Object]", () => {
    expect(formatValue({ type: "flood", limit: 25000 })).toBe("{ type: flood, limit: 25000 }");
  });

  it("renders arrays compactly with truncation", () => {
    expect(formatValue([1, 2, 3])).toBe("[1, 2, 3]");
    expect(formatValue([1, 2, 3, 4, 5])).toBe("[1, 2, 3, …+2]");
  });

  it("never produces [object Object]", () => {
    const s = formatValue([{ a: 1 }, { b: 2 }]);
    expect(s).not.toContain("[object Object]");
  });
});

describe("compareValues — scalars", () => {
  it("matches identical strings case/space-insensitively", () => {
    expect(compareValues("Commercial_Property", " commercial_property ").match).toBe(true);
  });

  it("matches numbers with currency tolerance", () => {
    expect(compareValues("$1,000.00", 1000).match).toBe(true);
  });

  it("does not match different scalars", () => {
    const r = compareValues("gl", "commercial_property");
    expect(r.match).toBe(false);
    expect(r.score).toBe(0);
    expect(r.diff.kind).toBe("scalar");
  });

  it("does not numeric-match strings that merely start with a number", () => {
    expect(compareValues("3 cats", "3 dogs").match).toBe(false);
  });

  it("treats null vs value as a mismatch with em-dash display", () => {
    const r = compareValues("commercial_property", null);
    expect(r.match).toBe(false);
    expect((r.diff as { got: string }).got).toBe("—");
  });

  it("treats both-empty as a full match", () => {
    expect(compareValues(null, undefined).match).toBe(true);
    expect(compareValues(null, "").match).toBe(true);
  });
});

describe("compareValues — arrays", () => {
  const a = { type: "flood", limit: 25000 };
  const b = { type: "wind", limit: 50000 };
  const c = { type: "fire", limit: 100000 };

  it("matches identical arrays of objects fully", () => {
    const r = compareValues([a, b], [a, b]);
    expect(r.match).toBe(true);
    expect(r.score).toBe(1);
  });

  it("is order-insensitive", () => {
    const r = compareValues([a, b], [b, a]);
    expect(r.match).toBe(true);
    expect(r.score).toBe(1);
  });

  it("gives partial credit for missing elements (4 of 6)", () => {
    const expected = [a, b, c, a, b, c];
    const got = [a, b, c, a]; // 4 present
    const r = compareValues(expected, got);
    expect(r.score).toBeCloseTo(4 / 6, 5);
    const diff = r.diff as ArrayDiff;
    expect(diff.expectedCount).toBe(6);
    expect(diff.gotCount).toBe(4);
    expect(diff.elements.filter((e) => e.status === "missing")).toHaveLength(2);
  });

  it("does NOT match two equal-length arrays of different objects (the old bug)", () => {
    const r = compareValues([a, b], [c, c]);
    expect(r.match).toBe(false);
    expect(r.score).toBe(0);
  });

  it("penalizes extra elements and surfaces them in the diff", () => {
    const r = compareValues([a], [a, b]);
    expect(r.score).toBeCloseTo(1 / 2, 5);
    const diff = r.diff as ArrayDiff;
    expect(diff.elements.some((e) => e.status === "extra")).toBe(true);
  });

  it("marks a near-matching object element as changed with a nested diff", () => {
    const r = compareValues([{ type: "flood", limit: 25000 }], [{ type: "flood", limit: 30000 }]);
    expect(r.match).toBe(false);
    const diff = r.diff as ArrayDiff;
    const changed = diff.elements.find((e) => e.status === "changed");
    expect(changed).toBeDefined();
  });
});

describe("compareValues — nested objects", () => {
  it("scores the mean of keys and lists only mismatched keys", () => {
    const expected = { insured: "Acme", limit: 1000, deductible: 500 };
    const got = { insured: "Acme", limit: 1000, deductible: 999 };
    const r = compareValues(expected, got);
    expect(r.match).toBe(false);
    expect(r.score).toBeCloseTo(2 / 3, 5);
    const diff = r.diff as ObjectDiff;
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0]!.key).toBe("deductible");
  });

  it("matches identical nested objects", () => {
    const o = { a: 1, b: { c: 2 } };
    expect(compareValues(o, { a: 1, b: { c: 2 } }).match).toBe(true);
  });
});

describe("compareValues — provenance keys are not scored", () => {
  it("ignores `__source_text`/`__source_context` on an object (5/5, not 5/7)", () => {
    const expected = { coverage: "A", each: 1000, agg: 2000, ded: 500, per: "occ" };
    // Model emits the same 5 correct values plus 2 inline provenance keys.
    const got = {
      coverage: "A",
      each: 1000,
      agg: 2000,
      ded: 500,
      per: "occ",
      __source_text: "Each Occurrence $1,000",
      __source_context: "Limits of Insurance — Each Occurrence $1,000",
    };
    const r = compareValues(expected, got);
    expect(r.match).toBe(true);
    expect(r.score).toBe(1);
  });

  it("ignores provenance keys on nested array items (coverages[].limits[])", () => {
    const limit = { name: "Each Occurrence", amount: 1000 };
    const expected = [{ coverage: "GL", limits: [limit, { name: "Aggregate", amount: 2000 }] }];
    const got = [
      {
        coverage: "GL",
        __source_text: "COMMERCIAL GENERAL LIABILITY",
        limits: [
          { ...limit, __source_text: "Each Occurrence $1,000" },
          { name: "Aggregate", amount: 2000, __source_text: "Aggregate $2,000" },
        ],
      },
    ];
    const r = compareValues(expected, got);
    expect(r.match).toBe(true);
    expect(r.score).toBe(1);
  });
});
