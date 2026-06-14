/**
 * Unit tests for the schema YAML → FieldMeta[] normalizer.
 *
 * Coverage targets:
 *   - All three input shapes (`fields:`, `properties:`, top-level legacy)
 *   - Precedence between shapes when a field is declared twice
 *   - enum/options/mappings/pattern extraction
 *   - Forward-compat (unknown YAML keys are silently dropped)
 *   - Bad inputs (empty string, invalid YAML) → empty array, never throws
 *   - Scalar coercion + dedup for enum
 */
import { describe, it, expect } from "vitest";
import { extractFieldMetas } from "./field-meta";

describe("extractFieldMetas", () => {
  it("normalizes the typical `fields:` shape", () => {
    const yaml = `
name: invoices
fields:
  total:
    type: number
    description: "Total amount"
    required: true
`;
    expect(extractFieldMetas(yaml)).toEqual([
      { name: "total", type: "number", description: "Total amount", required: true },
    ]);
  });

  it("normalizes the legacy top-level shape", () => {
    const yaml = `
governance:
  type: string
  enum: ["hoa", "condo"]
`;
    expect(extractFieldMetas(yaml)).toEqual([
      { name: "governance", type: "string", enum: ["hoa", "condo"] },
    ]);
  });

  it("normalizes the json-schema `properties:` shape", () => {
    const yaml = `
type: object
properties:
  status:
    type: string
    enum: ["open", "closed"]
`;
    expect(extractFieldMetas(yaml)).toEqual([
      { name: "status", type: "string", enum: ["open", "closed"] },
    ]);
  });

  it("prefers `fields:` over `properties:` and legacy top-level", () => {
    const yaml = `
amount:
  type: string
  enum: ["from_top_level"]
properties:
  amount:
    type: string
    enum: ["from_properties"]
fields:
  amount:
    type: number
    enum: [1, 2, 3]
`;
    const metas = extractFieldMetas(yaml);
    const amount = metas.find((m) => m.name === "amount")!;
    expect(amount.type).toBe("number");
    expect(amount.enum).toEqual(["1", "2", "3"]);
  });

  it("dedups + coerces enum scalars to strings", () => {
    const yaml = `
fields:
  dupes:
    type: string
    enum: ["a", "b", "a", "c", "b"]
  numeric:
    type: integer
    enum: [1, 2, 3, 2]
  flags:
    type: boolean
    enum: [true, false, true]
`;
    const metas = extractFieldMetas(yaml);
    expect(metas.find((m) => m.name === "dupes")!.enum).toEqual(["a", "b", "c"]);
    expect(metas.find((m) => m.name === "numeric")!.enum).toEqual(["1", "2", "3"]);
    expect(metas.find((m) => m.name === "flags")!.enum).toEqual(["true", "false"]);
  });

  it("drops non-scalar enum entries (objects, arrays)", () => {
    const yaml = `
fields:
  mixed:
    type: string
    enum:
      - "ok"
      - { unexpected: "shape" }
      - "fine"
      - [1, 2]
`;
    expect(extractFieldMetas(yaml)[0]!.enum).toEqual(["ok", "fine"]);
  });

  it("omits enum when empty", () => {
    const yaml = `
fields:
  blank:
    type: string
    enum: []
`;
    expect(extractFieldMetas(yaml)[0]).not.toHaveProperty("enum");
  });

  it("surfaces the legacy `options` alias", () => {
    const yaml = `
fields:
  community_type:
    type: string
    options: ["monoline", "multiline"]
`;
    expect(extractFieldMetas(yaml)[0]!.options).toEqual(["monoline", "multiline"]);
  });

  it("collapses redundant `options` when equivalent to enum", () => {
    const yaml = `
fields:
  thing:
    type: string
    enum: ["a", "b"]
    options: ["a", "b"]
`;
    const meta = extractFieldMetas(yaml)[0]!;
    expect(meta.enum).toEqual(["a", "b"]);
    expect(meta).not.toHaveProperty("options");
  });

  it("keeps `options` when it differs from enum", () => {
    const yaml = `
fields:
  thing:
    type: string
    enum: ["a", "b"]
    options: ["x", "y"]
`;
    const meta = extractFieldMetas(yaml)[0]!;
    expect(meta.enum).toEqual(["a", "b"]);
    expect(meta.options).toEqual(["x", "y"]);
  });

  it("treats enum-type `values:` as the enum list", () => {
    const yaml = `
fields:
  status:
    type: enum
    values: ["draft", "published", "archived"]
`;
    expect(extractFieldMetas(yaml)[0]!.enum).toEqual(["draft", "published", "archived"]);
  });

  it("extracts mappings as bucket → aliases", () => {
    const yaml = `
fields:
  state:
    type: string
    mappings:
      CA: ["California", "Calif"]
      NY: ["New York", "NYS"]
      TX: []
`;
    expect(extractFieldMetas(yaml)[0]!.mappings).toEqual({
      CA: ["California", "Calif"],
      NY: ["New York", "NYS"],
      TX: [],
    });
  });

  it("extracts `validate.regex` as pattern", () => {
    const yaml = `
fields:
  zip:
    type: string
    validate:
      regex: "^[0-9]{5}$"
`;
    expect(extractFieldMetas(yaml)[0]!.pattern).toBe("^[0-9]{5}$");
  });

  it("extracts top-level `pattern` as fallback", () => {
    const yaml = `
fields:
  zip:
    type: string
    pattern: "^[0-9]{5}$"
`;
    expect(extractFieldMetas(yaml)[0]!.pattern).toBe("^[0-9]{5}$");
  });

  it("silently drops unknown YAML keys (forward-compat)", () => {
    const yaml = `
fields:
  weird:
    type: string
    description: "fine"
    something_we_dont_know_about: { nested: true }
    futureBitcoinValidator: { rules: 42 }
`;
    expect(extractFieldMetas(yaml)).toEqual([
      { name: "weird", type: "string", description: "fine" },
    ]);
  });

  it("ignores `patterns:` (the regression that motivated the rewrite)", () => {
    const yaml = `
fields:
  unit_address_range:
    type: string
    patterns:
      - regex: "^[0-9]+-[0-9]+$"
      - regex: "^Unit [A-Z]$"
    description: "Range like 1-100 or Unit A"
`;
    const meta = extractFieldMetas(yaml)[0]!;
    expect(meta).not.toHaveProperty("enum");
    expect(meta).not.toHaveProperty("options");
    expect(meta.description).toBe("Range like 1-100 or Unit A");
  });

  it("returns empty array for empty input", () => {
    expect(extractFieldMetas("")).toEqual([]);
  });

  it("returns empty array for invalid YAML instead of throwing", () => {
    expect(extractFieldMetas("fields:\n  bad: [unterminated")).toEqual([]);
  });

  it("returns empty array when YAML has no recognised fields", () => {
    expect(extractFieldMetas("name: just_a_name\nversion: 1")).toEqual([]);
  });

  it("defaults type to `string` when missing", () => {
    const yaml = `
fields:
  untyped:
    description: "no type declared"
`;
    expect(extractFieldMetas(yaml)[0]!.type).toBe("string");
  });

  it("emits all fields when multiple are declared", () => {
    const yaml = `
fields:
  a:
    type: string
  b:
    type: number
  c:
    type: boolean
`;
    expect(extractFieldMetas(yaml).map((m) => m.name)).toEqual(["a", "b", "c"]);
  });

  it("skips top-level keys that don't look like field definitions", () => {
    const yaml = `
name: invoices
description: "A schema"
version: 2
fields:
  total:
    type: number
`;
    expect(extractFieldMetas(yaml).map((m) => m.name)).toEqual(["total"]);
  });
});
