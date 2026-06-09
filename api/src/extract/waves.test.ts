import { describe, it, expect } from "vitest";
import { toposortFields, resolveConditionalHints, resolveWaveFields } from "./waves";

// ---------------------------------------------------------------------------
// toposortFields
// ---------------------------------------------------------------------------

describe("toposortFields", () => {
  it("returns a single wave with all fields when no depends_on", () => {
    const schema = {
      fields: {
        name: { type: "string" },
        age: { type: "number" },
        city: { type: "string" },
      },
    };
    const waves = toposortFields(schema);
    expect(waves).toEqual([["age", "city", "name"]]);
  });

  it("sorts fields alphabetically within each wave", () => {
    const schema = {
      fields: {
        zebra: { type: "string" },
        apple: { type: "string" },
        mango: { type: "string" },
      },
    };
    const waves = toposortFields(schema);
    expect(waves).toEqual([["apple", "mango", "zebra"]]);
  });

  it("produces correct waves for linear dependency A->B->C", () => {
    const schema = {
      fields: {
        c: { type: "string", depends_on: ["b"] },
        b: { type: "string", depends_on: ["a"] },
        a: { type: "string" },
      },
    };
    const waves = toposortFields(schema);
    expect(waves).toEqual([["a"], ["b"], ["c"]]);
  });

  it("handles diamond dependency correctly", () => {
    // A has no deps, B and C depend on A, D depends on B and C
    const schema = {
      fields: {
        d: { type: "string", depends_on: ["b", "c"] },
        b: { type: "string", depends_on: ["a"] },
        c: { type: "string", depends_on: ["a"] },
        a: { type: "string" },
      },
    };
    const waves = toposortFields(schema);
    expect(waves).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("throws on circular dependency", () => {
    const schema = {
      fields: {
        a: { type: "string", depends_on: ["b"] },
        b: { type: "string", depends_on: ["a"] },
      },
    };
    expect(() => toposortFields(schema)).toThrow(/[Cc]ircular/);
  });

  it("throws on self-dependency", () => {
    const schema = {
      fields: {
        a: { type: "string", depends_on: ["a"] },
      },
    };
    expect(() => toposortFields(schema)).toThrow(/depend on itself/);
  });

  it("throws on reference to nonexistent field", () => {
    const schema = {
      fields: {
        a: { type: "string", depends_on: ["nonexistent"] },
      },
    };
    expect(() => toposortFields(schema)).toThrow(/unknown field/);
  });

  it("returns empty waves for empty schema", () => {
    expect(toposortFields({ fields: {} })).toEqual([]);
    expect(toposortFields({})).toEqual([]);
  });

  it("ignores non-dict field specs", () => {
    const schema = {
      fields: {
        a: "string",
        b: { type: "string" },
      },
    };
    const waves = toposortFields(schema as any);
    expect(waves).toEqual([["a", "b"]]);
  });

  it("ignores non-list depends_on values", () => {
    const schema = {
      fields: {
        a: { type: "string", depends_on: "b" },
        b: { type: "string" },
      },
    };
    // depends_on is not a list, so treated as no deps
    const waves = toposortFields(schema as any);
    expect(waves).toEqual([["a", "b"]]);
  });

  it("ignores non-string entries in depends_on", () => {
    const schema = {
      fields: {
        a: { type: "string", depends_on: [123, null, "b"] },
        b: { type: "string" },
      },
    };
    const waves = toposortFields(schema as any);
    expect(waves).toEqual([["b"], ["a"]]);
  });
});

// ---------------------------------------------------------------------------
// resolveConditionalHints
// ---------------------------------------------------------------------------

describe("resolveConditionalHints", () => {
  it("resolves extraction_hint_by to extraction_hint", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: {
          "10-K": "Look for fiscal year ended",
          "10-Q": "Look for quarterly period ended",
        },
      },
    };
    const result = resolveConditionalHints(spec, { form_type: "10-K" });
    expect(result.extraction_hint).toBe("Look for fiscal year ended");
  });

  it("returns original spec when parent value is missing", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: {
          "10-K": "Look for fiscal year ended",
        },
      },
    };
    const result = resolveConditionalHints(spec, {});
    expect(result).toBe(spec); // same reference — not mutated
    expect(result.extraction_hint).toBeUndefined();
  });

  it("returns original spec when parent value does not match any key", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: {
          "10-K": "Look for fiscal year ended",
        },
      },
    };
    const result = resolveConditionalHints(spec, { form_type: "8-K" });
    expect(result).toBe(spec);
  });

  it("uses string coercion to match numeric parent values", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        page_count: {
          "5": "Single page document",
          "10": "Multi page document",
        },
      },
    };
    const result = resolveConditionalHints(spec, { page_count: 5 });
    expect(result.extraction_hint).toBe("Single page document");
  });

  it("returns spec unchanged when no extraction_hint_by", () => {
    const spec = { type: "string" };
    const result = resolveConditionalHints(spec, { form_type: "10-K" });
    expect(result).toBe(spec);
  });

  it("first matching parent wins", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: {
          "10-K": "Hint from form_type",
        },
        category: {
          annual: "Hint from category",
        },
      },
    };
    const result = resolveConditionalHints(spec, {
      form_type: "10-K",
      category: "annual",
    });
    expect(result.extraction_hint).toBe("Hint from form_type");
  });

  it("does not mutate the original field_spec", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: { "10-K": "Hint" },
      },
    };
    const original = { ...spec };
    resolveConditionalHints(spec, { form_type: "10-K" });
    expect(spec).toEqual(original);
    expect(spec).not.toHaveProperty("extraction_hint");
  });

  it("returns non-dict field_spec as-is", () => {
    expect(resolveConditionalHints("string" as any, {})).toBe("string");
  });

  it("skips parent with non-dict value_map", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        bad_parent: "not a dict",
        good_parent: { yes: "Found it" },
      },
    };
    const result = resolveConditionalHints(spec as any, {
      bad_parent: "anything",
      good_parent: "yes",
    });
    expect(result.extraction_hint).toBe("Found it");
  });

  it("skips empty-string matched values", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: { "10-K": "  " },
      },
    };
    const result = resolveConditionalHints(spec, { form_type: "10-K" });
    expect(result).toBe(spec);
  });

  it("handles null parent value gracefully", () => {
    const spec = {
      type: "string",
      extraction_hint_by: {
        form_type: { "10-K": "Hint" },
      },
    };
    const result = resolveConditionalHints(spec, { form_type: null });
    expect(result).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// resolveWaveFields
// ---------------------------------------------------------------------------

describe("resolveWaveFields", () => {
  it("returns only wave fields", () => {
    const schema = {
      name: "test",
      fields: {
        a: { type: "string" },
        b: { type: "string", depends_on: ["a"] },
        c: { type: "string" },
      },
    };
    const result = resolveWaveFields(schema, ["a", "c"], {});
    expect(Object.keys(result.fields)).toEqual(["a", "c"]);
    expect(result.fields.b).toBeUndefined();
  });

  it("preserves non-field schema properties", () => {
    const schema = {
      name: "invoice",
      version: 2,
      fields: {
        a: { type: "string" },
      },
    };
    const result = resolveWaveFields(schema, ["a"], {});
    expect(result.name).toBe("invoice");
    expect((result as any).version).toBe(2);
  });

  it("resolves conditional hints in returned copy", () => {
    const schema = {
      fields: {
        form_type: { type: "string" },
        date: {
          type: "string",
          extraction_hint_by: {
            form_type: { "10-K": "Fiscal year ended" },
          },
        },
      },
    };
    const result = resolveWaveFields(schema, ["date"], { form_type: "10-K" });
    expect(result.fields.date.extraction_hint).toBe("Fiscal year ended");
  });

  it("does not mutate the original schemaDef", () => {
    const schema = {
      name: "test",
      fields: {
        a: { type: "string" },
        b: {
          type: "string",
          extraction_hint_by: {
            a: { hello: "world hint" },
          },
        },
      },
    };
    const originalFields = Object.keys(schema.fields);
    resolveWaveFields(schema, ["b"], { a: "hello" });
    // Original schema still has both fields
    expect(Object.keys(schema.fields)).toEqual(originalFields);
    // Original field spec not mutated
    expect((schema.fields.b as any).extraction_hint).toBeUndefined();
  });

  it("skips wave field names not present in schema", () => {
    const schema = {
      fields: {
        a: { type: "string" },
      },
    };
    const result = resolveWaveFields(schema, ["a", "nonexistent"], {});
    expect(Object.keys(result.fields)).toEqual(["a"]);
  });
});
