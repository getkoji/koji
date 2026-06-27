import { describe, it, expect } from "vitest";
import { arrayItemProperties, objectProperties, vocabHint, resolveVocab } from "./schema-tree";

describe("arrayItemProperties", () => {
  it("returns item properties for array-of-objects", () => {
    const spec = {
      type: "array",
      items: { type: "object", properties: { a: { type: "string" } } },
    };
    expect(arrayItemProperties(spec)).toEqual({ a: { type: "string" } });
  });

  it("treats any items object with properties as array-of-objects (no explicit item type)", () => {
    const spec = { type: "array", items: { properties: { a: { type: "number" } } } };
    expect(arrayItemProperties(spec)).toEqual({ a: { type: "number" } });
  });

  it("returns null for array of primitives", () => {
    expect(arrayItemProperties({ type: "array", items: { type: "string" } })).toBeNull();
  });

  it("returns null for non-array specs and nullish input", () => {
    expect(arrayItemProperties({ type: "object", properties: {} })).toBeNull();
    expect(arrayItemProperties(null)).toBeNull();
    expect(arrayItemProperties(undefined)).toBeNull();
  });
});

describe("objectProperties", () => {
  it("returns properties for a nested object", () => {
    const spec = { type: "object", properties: { city: { type: "string" } } };
    expect(objectProperties(spec)).toEqual({ city: { type: "string" } });
  });

  it("returns null when type is not object", () => {
    expect(objectProperties({ type: "array", properties: {} })).toBeNull();
    expect(objectProperties({ type: "object" })).toBeNull();
    expect(objectProperties(null)).toBeNull();
  });
});

describe("vocabHint", () => {
  it("renders mapping aliases", () => {
    const spec = { type: "mapping", mappings: { invoice: ["inv", "bill"], receipt: ["rcpt"] } };
    expect(vocabHint(spec)).toBe(" [pick from: invoice (inv, bill), receipt (rcpt)]");
  });

  it("renders enum/options", () => {
    expect(vocabHint({ type: "enum", options: ["a", "b"] })).toBe(" [pick from: a, b]");
    expect(vocabHint({ enum: ["x", "y"] })).toBe(" [pick from: x, y]");
  });

  it("drops a canonical key that is also listed as its own alias", () => {
    const spec = { mappings: { active: ["active", "ACTIVE"] } };
    expect(vocabHint(spec)).toBe(" [pick from: active (ACTIVE)]");
  });

  it("returns empty string when there is no controlled vocabulary", () => {
    expect(vocabHint({ type: "string" })).toBe("");
    expect(vocabHint({ type: "mapping", mappings: {} })).toBe("");
    expect(vocabHint(null)).toBe("");
  });

  it("renders a vocab_by decision table", () => {
    const spec = {
      type: "mapping",
      vocab_by: {
        coverage: {
          crime: { mappings: { employee_theft: ["EE Theft"], forgery: [] } },
          general_liability: { options: ["each_occurrence", "general_aggregate"] },
        },
      },
    };
    expect(vocabHint(spec)).toBe(
      " [pick by coverage: crime → employee_theft (EE Theft), forgery; general_liability → each_occurrence, general_aggregate]",
    );
  });

  it("appends the default branch to a vocab_by hint", () => {
    const spec = {
      type: "mapping",
      vocab_by: { coverage: { crime: { options: ["employee_theft"] } } },
      vocab_default: { options: ["other"] },
    };
    expect(vocabHint(spec)).toBe(" [pick by coverage: crime → employee_theft; otherwise: other]");
  });
});

describe("resolveVocab", () => {
  const spec = {
    type: "mapping",
    vocab_by: {
      coverage: {
        crime: { mappings: { employee_theft: ["EE Theft"] } },
        general_liability: { options: ["each_occurrence"] },
      },
    },
    vocab_default: { options: ["other"] },
  };

  it("returns the field unchanged when there is no vocab_by", () => {
    const plain = { type: "mapping", mappings: { a: [] } };
    const r = resolveVocab(plain, {});
    expect(r.status).toBe("static");
    expect(r.spec).toBe(plain);
  });

  it("selects the branch matching a sibling value", () => {
    const r = resolveVocab(spec, { coverage: "crime" });
    expect(r.status).toBe("matched");
    expect(r.sibling).toEqual({ field: "coverage", value: "crime" });
    expect(r.spec.mappings).toEqual({ employee_theft: ["EE Theft"] });
    expect(r.spec.vocab_by).toBeUndefined(); // conditional keys stripped after resolution
  });

  it("falls back to the default when no branch matches", () => {
    const r = resolveVocab(spec, { coverage: "surety" });
    expect(r.status).toBe("default");
    expect(r.spec.options).toEqual(["other"]);
  });

  it("reports unmatched when no branch matches and there is no default", () => {
    const noDefault = { type: "mapping", vocab_by: { coverage: { crime: { options: ["x"] } } } };
    const r = resolveVocab(noDefault, { coverage: "surety" });
    expect(r.status).toBe("unmatched");
    expect(r.spec.options).toBeUndefined();
    expect(r.spec.mappings).toBeUndefined();
  });

  it("skips a sibling whose value is null and tries the next", () => {
    const multi = {
      vocab_by: {
        primary: { a: { options: ["pa"] } },
        secondary: { b: { options: ["sb"] } },
      },
    };
    const r = resolveVocab(multi, { primary: null, secondary: "b" });
    expect(r.status).toBe("matched");
    expect(r.spec.options).toEqual(["sb"]);
  });
});
