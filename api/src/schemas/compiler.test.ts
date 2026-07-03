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

  it("rejects enum without values, options, or mappings", () => {
    const result = compileSchema(`
name: test
fields:
  status: { type: enum }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("requires 'values', 'options', 'mappings', or 'vocab_by'"))).toBe(true);
    }
  });

  it("accepts enum with options (alias for values)", () => {
    const result = compileSchema(`
name: test
fields:
  status:
    type: enum
    options: [active, inactive, pending]
`);
    expect(result.ok).toBe(true);
  });

  it("accepts enum with mappings (canonical values as keys)", () => {
    const result = compileSchema(`
name: test
fields:
  policy_type:
    type: enum
    mappings:
      property: ["Property", "Commercial Property"]
      general_liability: ["GL", "General Liability"]
`);
    expect(result.ok).toBe(true);
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

  it("rejects object with neither properties nor fields", () => {
    const result = compileSchema(`
name: test
fields:
  address: { type: object }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("requires a 'properties' (or 'fields') definition"))).toBe(true);
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

describe("schema compiler — conditional vocabulary (vocab_by)", () => {
  it("accepts a mapping field that supplies its vocabulary via vocab_by", () => {
    const result = compileSchema(`
name: coi
fields:
  coverage:
    type: enum
    values: [crime, general_liability]
  applies_to:
    type: mapping
    vocab_by:
      coverage:
        crime:
          mappings:
            employee_theft: ["EE Theft"]
        general_liability:
          options: [each_occurrence, general_aggregate]
`);
    expect(result.ok).toBe(true);
  });

  it("does NOT require a static mappings block when vocab_by is present", () => {
    const result = compileSchema(`
name: t
fields:
  coverage: { type: string }
  applies_to:
    type: mapping
    vocab_by:
      coverage:
        crime: { options: [employee_theft] }
`);
    expect(result.ok).toBe(true);
  });

  it("rejects vocab_by referencing a non-existent sibling", () => {
    const result = compileSchema(`
name: t
fields:
  applies_to:
    type: mapping
    vocab_by:
      nope:
        x: { options: [a] }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /sibling 'nope'/.test(e.message))).toBe(true);
    }
  });

  it("rejects a branch that declares no vocabulary", () => {
    const result = compileSchema(`
name: t
fields:
  coverage: { type: string }
  applies_to:
    type: mapping
    vocab_by:
      coverage:
        crime: { description: "oops, no vocab" }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /must declare 'mappings'/.test(e.message))).toBe(true);
    }
  });

  it("accepts vocab_default", () => {
    const result = compileSchema(`
name: t
fields:
  coverage: { type: string }
  applies_to:
    type: mapping
    vocab_by:
      coverage:
        crime: { options: [employee_theft] }
    vocab_default:
      options: [other]
`);
    expect(result.ok).toBe(true);
  });
});

describe("schema compiler — standalone object fields", () => {
  it("accepts type: object with properties (canonical, matching array items)", () => {
    const result = compileSchema(`
name: t
fields:
  address:
    type: object
    properties:
      city: { type: string }
      zip: { type: string }
`);
    expect(result.ok).toBe(true);
  });

  it("accepts type: object with fields (legacy alias)", () => {
    const result = compileSchema(`
name: t
fields:
  address:
    type: object
    fields:
      city: { type: string }
`);
    expect(result.ok).toBe(true);
  });
});

describe("schema compiler — keep_raw", () => {
  it("accepts keep_raw on a field", () => {
    const result = compileSchema(`
name: t
fields:
  applies_to:
    type: mapping
    keep_raw: true
    mappings:
      each_occurrence: ["Each Occurrence"]
`);
    expect(result.ok).toBe(true);
  });
});

describe("schema compiler — vocab_by sibling validation at depth", () => {
  it("accepts a vocab_by inside array items referencing a valid item sibling", () => {
    const result = compileSchema(`
name: coi
fields:
  coverages:
    type: array
    items:
      type: object
      properties:
        coverage: { type: string }
        applies_to:
          type: mapping
          vocab_by:
            coverage:
              crime: { mappings: { employee_theft: ["EE Theft"] } }
`);
    expect(result.ok).toBe(true);
  });

  it("rejects a vocab_by inside array items referencing a non-existent sibling", () => {
    const result = compileSchema(`
name: coi
fields:
  coverages:
    type: array
    items:
      type: object
      properties:
        applies_to:
          type: mapping
          vocab_by:
            kind:
              crime: { mappings: { employee_theft: ["EE Theft"] } }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /coverages\.applies_to/.test(e.field ?? "") && /sibling 'kind'/.test(e.message))).toBe(true);
    }
  });

  it("rejects a malformed branch inside a nested object", () => {
    const result = compileSchema(`
name: t
fields:
  insured:
    type: object
    properties:
      kind: { type: string }
      code:
        type: mapping
        vocab_by:
          kind:
            corp: { description: "no vocab here" }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /insured\.code/.test(e.field ?? "") && /must declare 'mappings'/.test(e.message))).toBe(true);
    }
  });
});

describe("forms block validation (oss-367)", () => {
  const base = `
name: t
fields:
  parts:
    type: array
    items:
      type: object
      properties:
        code: { type: string }
`;
  it("accepts a valid forms block", () => {
    const r = compileSchema(base + `
forms:
  - id: x
    field: parts
    anchor: "SUMMARY"
    row: { pattern: "(?<label>\\\\w+)" }
    set: { label: "{label}" }
`);
    expect(r.ok).toBe(true);
  });

  it("rejects missing row.pattern, unknown field, and invalid regex", () => {
    const r1 = compileSchema(base + "forms:\n  - field: parts\n    anchor: A\n");
    expect(r1.ok).toBe(false);
    const r2 = compileSchema(base + `forms:\n  - field: nope\n    anchor: A\n    row: { pattern: x }\n`);
    expect(r2.ok).toBe(false);
    const r3 = compileSchema(base + `forms:\n  - field: parts\n    anchor: A\n    row: { pattern: "([" }\n`);
    expect(r3.ok).toBe(false);
  });
});
