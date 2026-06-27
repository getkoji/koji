import { describe, it, expect } from "vitest";
import { arrayItemProperties, objectProperties, vocabHint } from "./schema-tree";

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
});
