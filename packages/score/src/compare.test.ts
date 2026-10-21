import { describe, it, expect } from "vitest";
import { compareValues, formatValue, matchPolicy, type ArrayDiff, type ObjectDiff } from "./compare";

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

  it("forgives punctuation-only differences (comma placement, phone separators)", () => {
    expect(compareValues("CHARLOTTE, NC 28226", "CHARLOTTE NC 28226").match).toBe(true);
    expect(compareValues("PO BOX 4810, DAVIDSON, NC", "PO BOX 4810, DAVIDSON NC").match).toBe(true);
    expect(compareValues("704-376-9896", "704.376.9896").match).toBe(true);
  });

  it("still fails when alphanumeric content differs, not just punctuation", () => {
    // dropped unit ("Ste 300"), different PO box, dropped entity suffix
    expect(compareValues("705 Griffith St, Ste 300, Davidson", "705 Griffith St, Davidson").match).toBe(false);
    expect(compareValues("PO BOX 4810", "PO BOX 12457").match).toBe(false);
    expect(compareValues("Allmerica Financial Benefit Insurance Company", "Allmerica Financial Benefit Insurance").match).toBe(false);
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

  it("treats an empty collection as the same absence as null", () => {
    // Ground truth writes an absent field as null; extraction returns [] for
    // an empty collection and {} for an empty object. Scoring those against
    // each other as a mismatch invents a failure out of a representation
    // difference, and breaks the adversarial case where a fixture asserts a
    // field should NOT be extracted and the model correctly declines with [].
    expect(compareValues(null, []).match).toBe(true);
    expect(compareValues([], null).match).toBe(true);
    expect(compareValues(null, {}).match).toBe(true);
    expect(compareValues({}, null).match).toBe(true);
    expect(compareValues("", []).match).toBe(true);
    expect(compareValues(undefined, {}).match).toBe(true);
  });

  it("still fails when only one side is empty", () => {
    expect(compareValues(null, [{ a: 1 }]).match).toBe(false);
    expect(compareValues([{ a: 1 }], null).match).toBe(false);
    expect(compareValues(null, { a: 1 }).match).toBe(false);
    expect(compareValues({ a: 1 }, null).match).toBe(false);
    expect(compareValues([], [{ a: 1 }]).match).toBe(false);
    expect(compareValues([{ a: 1 }], []).match).toBe(false);
  });

  it("honours a declared `mappings:` block without `match: enum`", () => {
    // The author wrote the synonyms down in the schema, and extraction already
    // folds values through them. Scoring that ignored them marked a correct
    // extraction wrong.
    const spec = {
      type: "string",
      mappings: {
        "Employer's First Report": ["First Report of Injury", "Employer's First Report of Injury"],
        "Proof of Loss": ["Sworn Statement in Proof of Loss"],
      },
    };
    expect(compareValues("Employer's First Report", "Employer's First Report of Injury", spec).match).toBe(true);
    expect(compareValues("First Report of Injury", "Employer's First Report", spec).match).toBe(true);
    // Different canonical members are still different values.
    expect(compareValues("Employer's First Report", "Sworn Statement in Proof of Loss", spec).match).toBe(false);
    // A value outside the vocabulary falls through to the normal comparison.
    expect(compareValues("Acme Corp", "ACME CORP", spec).match).toBe(true);
    expect(compareValues("Acme Corp", "Widget Inc", spec).match).toBe(false);
    // Without the mappings the two spellings are not the same value.
    expect(compareValues("Employer's First Report", "Employer's First Report of Injury").match).toBe(false);
  });

  it("does not let mappings loosen `match: exact`", () => {
    const spec = {
      match: "exact",
      mappings: { "Employer's First Report": ["Employer's First Report of Injury"] },
    };
    expect(compareValues("Employer's First Report", "Employer's First Report of Injury", spec).match).toBe(false);
  });

  it("does not apply a bare `options:` list as a synonym table", () => {
    // `options` lists the allowed values; it says nothing about two of them
    // being equivalent. Only `mappings` declares equivalence.
    const spec = { type: "string", options: ["gold", "silver"] };
    expect(compareValues("gold", "silver", spec).match).toBe(false);
    expect(compareValues("gold", "GOLD", spec).match).toBe(true);
  });

  it("does not score an object key that is empty on both sides", () => {
    // `{coverages: []}` vs `{coverages: null}` carries no signal, so it must
    // neither help nor hurt the object's score.
    const r = compareValues({ name: "Acme", coverages: [] }, { name: "Acme", coverages: null });
    expect(r.match).toBe(true);
    expect(r.score).toBe(1);
    const half = compareValues(
      { name: "Acme", city: "Davidson", notes: [] },
      { name: "Acme", city: "Charlotte", notes: null },
    );
    // Only `name` and `city` are scored: 1 of 2, not 2 of 3.
    expect(half.score).toBeCloseTo(0.5, 9);
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

  it("labels every element diff with its element_key value", () => {
    const expected = [
      { code: "GL", limit: "1000000" },
      { code: "PROP", limit: "2000000" }, // will be missed (FN)
      { code: "CRIME", limit: "250000" }, // will pair but differ (changed)
    ];
    const got = [
      { code: "GL", limit: "1000000" }, // matched
      { code: "CRIME", limit: "999" }, // changed
      { code: "UMB", limit: "5000000" }, // extra (FP)
    ];
    const r = compareValues(expected, got, spec);
    const diff = r.diff as ArrayDiff;
    const keysOf = (s: string) =>
      diff.elements.filter((e) => e.status === s).map((e) => (e as { key?: string }).key);
    expect(keysOf("matched")).toEqual(["GL"]);
    expect(keysOf("changed")).toEqual(["CRIME"]);
    expect(keysOf("missing")).toEqual(["PROP"]);
    expect(keysOf("extra")).toEqual(["UMB"]);
  });

  it("omits key when the element doesn't carry the key sub-field", () => {
    const expected = [{ code: "GL", limit: "1" }];
    const got = [{ limit: "2" }]; // no code → extra without a key
    const r = compareValues(expected, got, spec);
    const diff = r.diff as ArrayDiff;
    const extra = diff.elements.find((e) => e.status === "extra");
    expect(extra).toBeDefined();
    expect((extra as { key?: string }).key).toBeUndefined();
  });
});

describe("compareValues — arrays without element_key carry no element keys", () => {
  it("leaves key off every element diff", () => {
    const spec = { type: "array", items: { type: "object", properties: { code: { type: "string" } } } };
    const r = compareValues([{ code: "GL" }], [{ code: "UMB" }], spec);
    const diff = r.diff as ArrayDiff;
    expect(diff.elements.length).toBeGreaterThan(0);
    for (const e of diff.elements) {
      expect((e as { key?: string }).key).toBeUndefined();
    }
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

// ── Date-equivalent scalars ───────────────────────────────────────────
// Added with the move into @koji/score: the Python scorers this package
// replaces both normalized dates, so the unified scorer has to as well or
// unification would be a regression.
describe("compareValues — dates", () => {
  const matches: Array<[string, string]> = [
    ["2026-03-26", "03/26/2026"],
    ["2026-03-26", "March 26, 2026"],
    ["2026-03-26", "Mar. 26 2026"],
    ["2026-03-26", "26 March 2026"],
    ["2026-03-26", "26th of March, 2026"],
    ["2026-03-26", "2026/03/26"],
    ["2026-03-26", "3/26/26"],
    ["2026-03-26", "26.03.2026"], // day-first only because 26 is not a month
  ];
  it.each(matches)("treats %s and %s as the same date", (expected, got) => {
    expect(compareValues(expected, got).match).toBe(true);
  });

  const mismatches: Array<[string, string]> = [
    ["2026-03-26", "2026-03-27"],
    ["2026-03-26", "March 27, 2026"],
    ["2026-03-26", "2026-04-26"],
    ["2026-03-26", "03/26/2025"],
  ];
  it.each(mismatches)("keeps %s and %s distinct", (expected, got) => {
    expect(compareValues(expected, got).match).toBe(false);
  });

  it("reads ambiguous numeric dates month-first", () => {
    // 01/02/2026 is 2 January in day-first locales. Month-first is the declared
    // default; per-field overrides belong in the `match:` policy, not here.
    expect(compareValues("2026-01-02", "01/02/2026").match).toBe(true);
    expect(compareValues("2026-02-01", "01/02/2026").match).toBe(false);
  });

  it("rejects impossible days rather than rolling them over", () => {
    // new Date(2026, 1, 31) silently becomes 2 March. A non-date must not
    // compare equal to the date it would roll into.
    expect(compareValues("2026-03-03", "02/31/2026").match).toBe(false);
  });

  it("does not read a date out of a non-date string", () => {
    expect(compareValues("2026-03-26", "Ste 300").match).toBe(false);
    expect(compareValues("Ste 300", "2026-03-26").match).toBe(false);
  });

  it("still compares a date against a non-date by the other rules", () => {
    // One-sided date parse must fall through, not short-circuit to false.
    expect(compareValues("POLICY-2026", "policy 2026").match).toBe(true);
  });

  it("does not let the numeric path read a slashed date as a quantity", () => {
    // parseFloat("03/26/2026") is 3 — without the date branch running first,
    // this would compare 3 against 3 and wrongly match.
    expect(compareValues("03/26/2026", "03/27/2026").match).toBe(false);
  });

  it("expands two-digit years on the POSIX pivot", () => {
    expect(compareValues("2026-03-26", "03/26/26").match).toBe(true);
    expect(compareValues("1999-03-26", "03/26/99").match).toBe(true);
  });
});


// ── Declared equivalence policy (`match:`) ────────────────────────────

describe("matchPolicy", () => {
  it("defaults to normalized when nothing is declared", () => {
    expect(matchPolicy(undefined)).toEqual({ mode: "normalized", tolerance: 0.01 });
    expect(matchPolicy({ type: "string" })).toEqual({ mode: "normalized", tolerance: 0.01 });
  });

  it("accepts a bare mode string", () => {
    expect(matchPolicy({ match: "contains" }).mode).toBe("contains");
  });

  it("accepts an object with a tolerance", () => {
    expect(matchPolicy({ match: { mode: "numeric", tolerance: 0.5 } })).toEqual({
      mode: "numeric",
      tolerance: 0.5,
    });
  });

  it("throws on an unknown mode rather than falling back", () => {
    // A typo that silently reverted to the default would look configured while
    // scoring differently — the exact failure this policy exists to prevent.
    expect(() => matchPolicy({ match: "noramlized" })).toThrow(/unknown match mode/);
    expect(() => matchPolicy({ match: { mode: 42 } })).toThrow(/unknown match mode/);
  });

  it("throws on a nonsensical tolerance", () => {
    expect(() => matchPolicy({ match: { mode: "numeric", tolerance: -1 } })).toThrow(/tolerance/);
    expect(() => matchPolicy({ match: { mode: "numeric", tolerance: "soon" } })).toThrow(/tolerance/);
  });
});

describe("compareValues — match: exact", () => {
  const spec = { match: "exact" };
  it("forgives nothing", () => {
    expect(compareValues("ABC-1", "ABC-1", spec).match).toBe(true);
    expect(compareValues("ABC-1", "abc-1", spec).match).toBe(false);
    expect(compareValues("ABC-1", " ABC-1 ", spec).match).toBe(false);
    expect(compareValues("2026-03-26", "03/26/2026", spec).match).toBe(false);
  });
});

describe("compareValues — match: contains", () => {
  const spec = { match: "contains" };
  it("accepts a value the document wraps", () => {
    // The governing_law class: 33% of this corpus's scored "errors".
    expect(compareValues("State of Delaware", "Delaware", spec).match).toBe(true);
    expect(compareValues("Delaware", "State of Delaware", spec).match).toBe(true);
    expect(compareValues("The laws of the State of New York", "New York", spec).match).toBe(true);
  });

  it("still rejects a different value", () => {
    expect(compareValues("State of Delaware", "State of Hawaii", spec).match).toBe(false);
    expect(compareValues("Delaware", "Dela", spec).match).toBe(true); // substring by design
    expect(compareValues("Delaware", "Wisconsin", spec).match).toBe(false);
  });

  it("does not treat an empty value as contained in everything", () => {
    expect(compareValues("Delaware", "", spec).match).toBe(false);
    expect(compareValues("Delaware", "   ", spec).match).toBe(false);
  });
});

describe("compareValues — match: numeric", () => {
  it("compares quantities within tolerance", () => {
    const spec = { match: "numeric" };
    expect(compareValues(1250, "$1,250.00", spec).match).toBe(true);
    expect(compareValues(1250, 1250.005, spec).match).toBe(true);
    expect(compareValues(1250, 1251, spec).match).toBe(false);
  });

  it("honours a declared tolerance", () => {
    expect(compareValues(1250, 1250.4, { match: { mode: "numeric", tolerance: 0.5 } }).match).toBe(true);
    expect(compareValues(1250, 1250.6, { match: { mode: "numeric", tolerance: 0.5 } }).match).toBe(false);
  });

  it("fails a non-quantity instead of forgiving it", () => {
    // This is the point of declaring `numeric`: "n/a" is not a number, and a
    // normalized comparison would have called it equal to itself and moved on.
    const spec = { match: "numeric" };
    expect(compareValues("n/a", "n/a", spec).match).toBe(false);
    expect(compareValues(1250, "twelve fifty", spec).match).toBe(false);
  });
});

describe("compareValues — match: date", () => {
  const spec = { match: "date" };
  it("compares calendar days across formats", () => {
    expect(compareValues("2026-03-26", "March 26, 2026", spec).match).toBe(true);
    expect(compareValues("2026-03-26", "2026-03-27", spec).match).toBe(false);
  });

  it("fails a non-date rather than falling back to text equality", () => {
    expect(compareValues("not a date", "not a date", spec).match).toBe(false);
  });
});

describe("compareValues — match: enum", () => {
  const spec = { match: "enum", options: ["Occurrence", "Claims Made"] };
  it("resolves to the canonical member", () => {
    expect(compareValues("Occurrence", "occurrence", spec).match).toBe(true);
    expect(compareValues("Claims Made", "claims-made", spec).match).toBe(true);
    expect(compareValues("Occurrence", "Claims Made", spec).match).toBe(false);
  });

  it("rejects a value outside the vocabulary", () => {
    expect(compareValues("Occurrence", "Something Else", spec).match).toBe(false);
  });

  it("resolves aliases declared in mappings", () => {
    const mapped = { match: "enum", mappings: { Occurrence: ["occ", "per occurrence"] } };
    expect(compareValues("Occurrence", "per occurrence", mapped).match).toBe(true);
    expect(compareValues("Occurrence", "aggregate", mapped).match).toBe(false);
  });

  it("falls back to a normalized comparison with no declared vocabulary", () => {
    // Declaring `enum` on a field with no options would otherwise fail every
    // value, including a value identical to the expected one.
    expect(compareValues("Occurrence", "occurrence", { match: "enum" }).match).toBe(true);
  });
});

describe("the policy is opt-in", () => {
  it("scores identically with and without an undeclared spec", () => {
    // Adopting this policy must not move an existing number. Everything the
    // default forgives, it forgave before.
    const cases: Array<[unknown, unknown]> = [
      ["ABC-1", "abc 1"],
      ["2026-03-26", "03/26/2026"],
      [1250, "$1,250.00"],
      ["CHARLOTTE, NC", "CHARLOTTE NC"],
      ["Acme Co", "Acme Corporation"],
      ["State of Delaware", "Delaware"],
    ];
    for (const [expected, got] of cases) {
      expect(compareValues(expected, got).match).toBe(
        compareValues(expected, got, { type: "string" }).match,
      );
    }
  });

  it("leaves the governing_law class failing until contains is declared", () => {
    expect(compareValues("State of Delaware", "Delaware").match).toBe(false);
    expect(compareValues("State of Delaware", "Delaware", { match: "contains" }).match).toBe(true);
  });
});

// ── Numeric equivalence must not read a prefix (oss-554/556/559) ──────
//
// The guard used to admit any string of digits and punctuation and let
// parseFloat read a prefix, so a truncation compared equal to the value it was
// truncated from. Every case here scored as a MATCH before.
describe("compareValues — numeric guard", () => {
  const collisions: Array<[string, string, string]> = [
    ["45", "45-5108603", "bare number vs TIN"],
    ["704", "704-376-9896", "bare number vs phone"],
    ["2026", "2026-05-01", "year vs full date"],
    ["12", "12-31-2026", "number vs date"],
    ["1250", "1250-9999", "amount vs hyphenated id"],
    ["2017-28-12", "2017-12-28", "invalid date vs real date, both read as 2017"],
  ];
  it.each(collisions)("keeps %s and %s distinct (%s)", (expected, got) => {
    expect(compareValues(expected, got).match).toBe(false);
  });

  it("still matches genuine quantities", () => {
    expect(compareValues(1250, "$1,250.00").match).toBe(true);
    expect(compareValues("1250.00", "1250").match).toBe(true);
    expect(compareValues("1 250", "1250").match).toBe(true); // space as separator
    expect(compareValues(-5, "-5").match).toBe(true);
    expect(compareValues(1250, 1250.005).match).toBe(true); // within 0.01
    expect(compareValues(1250, 1251).match).toBe(false);
  });

  it("still matches formatting-only differences by punctuation, not by quantity", () => {
    // These must survive: they pass on the punctuation rule, which is intact.
    expect(compareValues("704-376-9896", "704.376.9896").match).toBe(true);
    expect(compareValues("CHARLOTTE, NC", "CHARLOTTE NC").match).toBe(true);
  });

  it("does not read a quantity out of a dotted identifier", () => {
    expect(compareValues("704.376.9896", "704").match).toBe(false);
  });
});
