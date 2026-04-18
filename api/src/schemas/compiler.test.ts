import { describe, it, expect } from "vitest";
import { compileSchema } from "./compiler";

describe("schema compiler — valid schemas", () => {
  it("compiles a minimal valid schema", () => {
    const result = compileSchema(`
name: test
fields:
  name:
    type: string
    required: true
`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.name).toBe("test");
      expect(result.parsed.fields).toBeDefined();
    }
  });

  it("compiles all field types", () => {
    const result = compileSchema(`
name: all_types
fields:
  a: { type: string }
  b: { type: number }
  c: { type: date }
  d: { type: boolean }
  e: { type: enum, values: [x, y] }
  f:
    type: array
    items: { type: string }
  g:
    type: object
    fields:
      nested: { type: string }
`);
    expect(result.ok).toBe(true);
  });

  it("compiles schema with validation rules", () => {
    const result = compileSchema(`
name: validated
fields:
  code:
    type: string
    validate:
      regex: "^[A-Z]{3}$"
      min_length: 3
      max_length: 3
  amount:
    type: number
    validate:
      min: 0
      max: 1000000
`);
    expect(result.ok).toBe(true);
  });

  it("compiles schema with normalize and derived fields", () => {
    const result = compileSchema(`
name: derived
fields:
  address:
    type: string
  state:
    type: string
    derived_from: address
    method: us_state_lookup
  date:
    type: date
    normalize: iso8601
  amount:
    type: number
    normalize: minor_units
`);
    expect(result.ok).toBe(true);
  });
});

describe("schema compiler — invalid schemas", () => {
  it("rejects invalid YAML", () => {
    const result = compileSchema("{{{{not yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.message).toContain("YAML parse error");
    }
  });

  it("rejects missing name", () => {
    const result = compileSchema(`
fields:
  a: { type: string }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("'name'"))).toBe(true);
    }
  });

  it("rejects missing fields", () => {
    const result = compileSchema(`
name: test
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("'fields'"))).toBe(true);
    }
  });

  it("rejects field without type", () => {
    const result = compileSchema(`
name: test
fields:
  amount:
    required: true
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("'type' is required"))).toBe(true);
    }
  });

  it("rejects unknown type", () => {
    const result = compileSchema(`
name: test
fields:
  a: { type: integer }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("unknown type 'integer'"))).toBe(true);
    }
  });

  it("rejects enum without values", () => {
    const result = compileSchema(`
name: test
fields:
  status: { type: enum }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("requires 'values' array"))).toBe(true);
    }
  });

  it("rejects array without items", () => {
    const result = compileSchema(`
name: test
fields:
  tags: { type: array }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("requires 'items'"))).toBe(true);
    }
  });

  it("rejects object without fields", () => {
    const result = compileSchema(`
name: test
fields:
  address: { type: object }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("requires 'fields'"))).toBe(true);
    }
  });

  it("rejects derived_from referencing nonexistent field", () => {
    const result = compileSchema(`
name: test
fields:
  state:
    type: string
    derived_from: address
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("'address' which is not defined"))).toBe(true);
    }
  });

  it("rejects unknown normalize value", () => {
    const result = compileSchema(`
name: test
fields:
  a:
    type: string
    normalize: capitalize
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("unknown normalize"))).toBe(true);
    }
  });

  it("rejects invalid regex pattern", () => {
    const result = compileSchema(`
name: test
fields:
  code:
    type: string
    validate:
      regex: "([invalid"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("regex pattern does not compile"))).toBe(true);
    }
  });

  it("rejects non-number min/max", () => {
    const result = compileSchema(`
name: test
fields:
  amount:
    type: number
    validate:
      min: "zero"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("min must be a number"))).toBe(true);
    }
  });
});

describe("schema compiler — unknown property suggestions", () => {
  it("suggests 'validate' for 'validat'", () => {
    const result = compileSchema(`
name: test
fields:
  a:
    type: string
    validat:
      min: 0
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("did you mean 'validate'"))).toBe(true);
    }
  });

  it("suggests 'required' for 'requied'", () => {
    const result = compileSchema(`
name: test
fields:
  a:
    type: string
    requied: true
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("did you mean 'required'"))).toBe(true);
    }
  });

  it("suggests 'regex' for 'regx' in validate", () => {
    const result = compileSchema(`
name: test
fields:
  a:
    type: string
    validate:
      regx: "^[A-Z]$"
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("did you mean 'regex'"))).toBe(true);
    }
  });
});

describe("schema compiler — multiple errors", () => {
  it("reports all errors at once", () => {
    const result = compileSchema(`
name: test
fields:
  a:
    requied: true
  b:
    type: integer
  c:
    type: enum
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
