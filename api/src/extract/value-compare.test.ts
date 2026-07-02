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

  it("gives partial credit for missing elements — F1 (4 of 6 recall, full precision)", () => {
    const expected = [a, b, c, a, b, c];
    const got = [a, b, c, a]; // 4 present, all correct
    const r = compareValues(expected, got);
    // precision = 4/4 = 1, recall = 4/6, F1 = 2·1·(4/6)/(1 + 4/6) = 0.8
    expect(r.score).toBeCloseTo(0.8, 5);
    const diff = r.diff as ArrayDiff;
    expect(diff.expectedCount).toBe(6);
    expect(diff.gotCount).toBe(4);
    expect(diff.precision).toBeCloseTo(1, 5);
    expect(diff.recall).toBeCloseTo(4 / 6, 5);
    expect(diff.elements.filter((e) => e.status === "missing")).toHaveLength(2);
  });

  it("does NOT match two equal-length arrays of different objects (the old bug)", () => {
    const r = compareValues([a, b], [c, c]);
    expect(r.match).toBe(false);
    expect(r.score).toBe(0);
  });

  it("penalizes extra elements via precision, surfaces them in the diff (F1)", () => {
    const r = compareValues([a], [a, b]); // 1 correct + 1 spurious extra
    // precision = 1/2, recall = 1/1, F1 = 2·0.5·1/1.5 = 0.6667
    expect(r.score).toBeCloseTo(2 / 3, 5);
    const diff = r.diff as ArrayDiff;
    expect(diff.precision).toBeCloseTo(0.5, 5);
    expect(diff.recall).toBeCloseTo(1, 5);
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

describe("compareValues — arrays with element_key matching", () => {
  const spec = {
    type: "array",
    hints: { element_key: "code" },
    items: {
      type: "object",
      properties: { code: { type: "string" }, limit: { type: "string" } },
    },
  };

  it("pairs elements by key regardless of order or a wrong sub-field", () => {
    const expected = [
      { code: "GL", limit: "1000000" },
      { code: "PROP", limit: "2000000" },
    ];
    // Reordered, and PROP's limit is wrong — but keys still pair them.
    const got = [
      { code: "PROP", limit: "9999999" },
      { code: "GL", limit: "1000000" },
    ];
    const r = compareValues(expected, got, spec);
    const diff = r.diff as ArrayDiff;
    expect(diff.matchedCount).toBe(2); // both keys matched
    // GL element = 1.0, PROP element = 0.5 (code ok, limit wrong) → credit 1.5
    // precision = recall = 1.5/2 = 0.75 → F1 = 0.75
    expect(diff.precision).toBeCloseTo(0.75, 5);
    expect(diff.recall).toBeCloseTo(0.75, 5);
    expect(r.score).toBeCloseTo(0.75, 5);
  });

  it("a real extra element GT lacks costs precision but NOT recall", () => {
    const expected = [{ code: "GL", limit: "1000000" }];
    const got = [
      { code: "GL", limit: "1000000" },
      { code: "UMB", limit: "5000000" }, // real part GT doesn't have
    ];
    const r = compareValues(expected, got, spec);
    const diff = r.diff as ArrayDiff;
    // recall stays perfect — nothing expected was missed.
    expect(diff.recall).toBeCloseTo(1, 5);
    // precision drops (1 of 2 produced elements is in GT).
    expect(diff.precision).toBeCloseTo(0.5, 5);
    expect(diff.elements.some((e) => e.status === "extra")).toBe(true);
  });

  it("a missed element costs recall but not precision", () => {
    const expected = [
      { code: "GL", limit: "1000000" },
      { code: "PROP", limit: "2000000" },
    ];
    const got = [{ code: "GL", limit: "1000000" }];
    const r = compareValues(expected, got, spec);
    const diff = r.diff as ArrayDiff;
    expect(diff.precision).toBeCloseTo(1, 5); // everything produced was right
    expect(diff.recall).toBeCloseTo(0.5, 5); // missed PROP
  });
});

describe("compareValues — informational sub-fields are not scored", () => {
  const spec = {
    type: "array",
    hints: { element_key: "code" },
    items: {
      type: "object",
      properties: {
        code: { type: "string" },
        limit: { type: "string" },
        applies_to_raw: { type: "string", hints: { informational: true } },
      },
    },
  };

  it("a wrong informational sub-field does not lower the score", () => {
    const expected = [{ code: "GL", limit: "1000000", applies_to_raw: "Each Occurrence" }];
    const got = [{ code: "GL", limit: "1000000", applies_to_raw: "per occurrence (reworded)" }];
    const r = compareValues(expected, got, spec);
    // Only code + limit are scored; both correct → 1.0 despite the reworded field.
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.match).toBe(true);
  });

  it("without the informational flag, the same wording difference lowers the score", () => {
    const plainSpec = {
      type: "array",
      hints: { element_key: "code" },
      items: {
        type: "object",
        properties: { code: { type: "string" }, limit: { type: "string" }, applies_to_raw: { type: "string" } },
      },
    };
    const expected = [{ code: "GL", limit: "1000000", applies_to_raw: "Each Occurrence" }];
    const got = [{ code: "GL", limit: "1000000", applies_to_raw: "per occurrence (reworded)" }];
    const r = compareValues(expected, got, plainSpec);
    expect(r.score).toBeCloseTo(2 / 3, 5); // 2 of 3 sub-fields correct
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
