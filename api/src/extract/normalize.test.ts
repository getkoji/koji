import { describe, it, expect } from "vitest";
import { normalizeExtracted } from "./normalize";

// Helper to run a single-field normalization
function normField(
  value: unknown,
  fieldSpec: Record<string, unknown>,
  fieldName = "f",
) {
  const extracted = { [fieldName]: value };
  const schema = { fields: { [fieldName]: fieldSpec } };
  const [result, report] = normalizeExtracted(extracted, schema);
  return { value: result[fieldName], report };
}

// ---------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------

describe("trim transform", () => {
  it("trims leading/trailing whitespace", () => {
    const { value } = normField("  hello  ", { normalize: "trim" });
    expect(value).toBe("hello");
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "trim" });
    expect(value).toBe(42);
  });

  it("handles already-trimmed strings", () => {
    const { value, report } = normField("hello", { normalize: "trim" });
    expect(value).toBe("hello");
    // No transform should be recorded when value doesn't change
    expect(report.applied.filter((a) => a.transform === "trim")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lowercase
// ---------------------------------------------------------------------------

describe("lowercase transform", () => {
  it("lowercases a string", () => {
    const { value } = normField("HELLO World", { normalize: "lowercase" });
    expect(value).toBe("hello world");
  });

  it("passes through non-string values", () => {
    const { value } = normField(null, { normalize: "lowercase" });
    expect(value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Uppercase
// ---------------------------------------------------------------------------

describe("uppercase transform", () => {
  it("uppercases a string", () => {
    const { value } = normField("hello", { normalize: "uppercase" });
    expect(value).toBe("HELLO");
  });
});

// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

describe("slugify transform", () => {
  it("converts to slug format", () => {
    const { value } = normField("Hello World!", { normalize: "slugify" });
    expect(value).toBe("hello_world");
  });

  it("strips leading/trailing underscores", () => {
    const { value } = normField("  --hello--  ", { normalize: "slugify" });
    expect(value).toBe("hello");
  });

  it("returns null for null input", () => {
    const { value } = normField(null, { normalize: "slugify" });
    expect(value).toBeNull();
  });

  it("converts numbers to slugs", () => {
    const { value } = normField(42, { normalize: "slugify" });
    expect(value).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// ISO 8601 date normalization
// ---------------------------------------------------------------------------

describe("iso8601 transform", () => {
  it("normalizes ISO date with single-digit month/day", () => {
    const { value } = normField("2025-1-5", { normalize: "iso8601" });
    expect(value).toBe("2025-01-05");
  });

  it("normalizes US date format MM/DD/YYYY", () => {
    const { value } = normField("01/15/2025", { normalize: "iso8601" });
    expect(value).toBe("2025-01-15");
  });

  it("normalizes verbose month-day-year (January 15, 2025)", () => {
    const { value } = normField("January 15, 2025", { normalize: "iso8601" });
    expect(value).toBe("2025-01-15");
  });

  it("normalizes verbose day-month-year (15 January 2025)", () => {
    const { value } = normField("15 January 2025", { normalize: "iso8601" });
    expect(value).toBe("2025-01-15");
  });

  it("normalizes abbreviated month names", () => {
    const { value } = normField("Mar 5, 2025", { normalize: "iso8601" });
    expect(value).toBe("2025-03-05");
  });

  it("normalizes European DD.MM.YYYY format", () => {
    const { value } = normField("15.01.2025", { normalize: "iso8601" });
    expect(value).toBe("2025-01-15");
  });

  it("expands 2-digit years (< 70 -> 20xx)", () => {
    const { value } = normField("01/15/25", { normalize: "iso8601" });
    expect(value).toBe("2025-01-15");
  });

  it("expands 2-digit years (>= 70 -> 19xx)", () => {
    const { value } = normField("01/15/95", { normalize: "iso8601" });
    expect(value).toBe("1995-01-15");
  });

  it("passes through non-string values", () => {
    const { value } = normField(null, { normalize: "iso8601" });
    expect(value).toBeNull();
  });

  it("passes through unparseable strings", () => {
    const { value } = normField("not a date", { normalize: "iso8601" });
    expect(value).toBe("not a date");
  });

  it("respects dayfirst locale from schema", () => {
    // When locale says DD/MM/YYYY, 04/06/2025 should be June 4, not April 6
    const extracted = { d: "04/06/2025" };
    const schema = {
      fields: { d: { normalize: "iso8601" } },
      locale: { fallback: { date_format: "DD/MM/YYYY" } },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.d).toBe("2025-06-04");
  });
});

// ---------------------------------------------------------------------------
// Minor units (currency to cents)
// ---------------------------------------------------------------------------

describe("minor_units transform", () => {
  it("converts dollar amount string to cents", () => {
    const { value } = normField("$1,234.56", { normalize: "minor_units" });
    expect(value).toBe(123456);
  });

  it("converts plain number string to cents", () => {
    const { value } = normField("10.50", { normalize: "minor_units" });
    expect(value).toBe(1050);
  });

  it("converts numeric value to cents", () => {
    const { value } = normField(10.5, { normalize: "minor_units" });
    expect(value).toBe(1050);
  });

  it("handles negative amounts in parentheses", () => {
    const { value } = normField("($50.00)", { normalize: "minor_units" });
    expect(value).toBe(-5000);
  });

  it("returns null for null input", () => {
    const { value } = normField(null, { normalize: "minor_units" });
    expect(value).toBeNull();
  });

  it("passes through booleans", () => {
    const { value } = normField(true, { normalize: "minor_units" });
    expect(value).toBe(true);
  });

  it("passes through unparseable strings", () => {
    const { value } = normField("no numbers", { normalize: "minor_units" });
    expect(value).toBe("no numbers");
  });

  it("handles zero", () => {
    const { value } = normField("$0.00", { normalize: "minor_units" });
    expect(value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E.164 phone normalization
// ---------------------------------------------------------------------------

describe("e164 transform", () => {
  it("formats 10-digit US number with +1", () => {
    const { value } = normField("(555) 123-4567", { normalize: "e164" });
    expect(value).toBe("+15551234567");
  });

  it("formats 11-digit number starting with 1", () => {
    const { value } = normField("1-555-123-4567", { normalize: "e164" });
    expect(value).toBe("+15551234567");
  });

  it("preserves existing + prefix", () => {
    const { value } = normField("+44 20 7946 0958", { normalize: "e164" });
    expect(value).toBe("+442079460958");
  });

  it("passes through null values", () => {
    const { value } = normField(null, { normalize: "e164" });
    expect(value).toBeNull();
  });

  it("passes through empty strings", () => {
    const { value } = normField("", { normalize: "e164" });
    expect(value).toBe("");
  });

  it("passes through non-string values", () => {
    const { value } = normField(12345, { normalize: "e164" });
    expect(value).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Multiple transforms (chained)
// ---------------------------------------------------------------------------

describe("chained transforms", () => {
  it("applies transforms in order", () => {
    const { value } = normField("  HELLO  ", { normalize: ["trim", "lowercase"] });
    expect(value).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Unknown transform
// ---------------------------------------------------------------------------

describe("unknown transform", () => {
  it("warns on unknown transform and passes value through", () => {
    const { value, report } = normField("test", { normalize: "unknown_transform" });
    expect(value).toBe("test");
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("unknown normalize transform");
  });
});

// ---------------------------------------------------------------------------
// Enum snapping via Levenshtein
// ---------------------------------------------------------------------------

describe("enum snapping", () => {
  it("snaps close misspelling to nearest option", () => {
    const { value } = normField("invoce", {
      options: ["invoice", "receipt", "credit_note"],
    });
    expect(value).toBe("invoice");
  });

  it("does not snap when value exactly matches (case-insensitive)", () => {
    const { value, report } = normField("Invoice", {
      options: ["invoice", "receipt"],
    });
    // Exact case-insensitive match -- no snap needed
    expect(value).toBe("Invoice");
    expect(report.applied.filter((a) => a.transform.startsWith("enum snap"))).toHaveLength(0);
  });

  it("does not snap when distance ratio >= 0.5", () => {
    const { value, report } = normField("xyz", {
      options: ["invoice", "receipt"],
    });
    // "xyz" is too far from any option
    expect(value).toBe("xyz");
    expect(report.applied.filter((a) => a.transform.startsWith("enum snap"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// US state lookup (derived_from)
// ---------------------------------------------------------------------------

describe("us_state_lookup derivation", () => {
  it("derives state abbreviation from address field", () => {
    const extracted = {
      address: "123 Main St, New York, NY 10001",
      state: null,
    };
    const schema = {
      fields: {
        address: {},
        state: {
          derived_from: { field: "address", method: "us_state_lookup" },
        },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.state).toBe("NY");
  });

  it("derives from full state name", () => {
    const extracted = {
      address: "123 Main St, California 90210",
      state: null,
    };
    const schema = {
      fields: {
        address: {},
        state: {
          derived_from: { field: "address", method: "us_state_lookup" },
        },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.state).toBe("CA");
  });

  it("does not override existing state value", () => {
    const extracted = { address: "123 Main St, NY 10001", state: "TX" };
    const schema = {
      fields: {
        address: {},
        state: {
          derived_from: { field: "address", method: "us_state_lookup" },
        },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.state).toBe("TX");
  });

  it("scans all fields when source is *", () => {
    const extracted = {
      field1: "something in Florida 33101",
      state: null,
    };
    const schema = {
      fields: {
        field1: {},
        state: {
          derived_from: { field: "*", method: "us_state_lookup" },
        },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.state).toBe("FL");
  });
});

// ---------------------------------------------------------------------------
// Array normalization (item-level)
// ---------------------------------------------------------------------------

describe("array item normalization", () => {
  it("applies item-level normalization to array of objects", () => {
    const extracted = {
      items: [
        { name: "  Widget  ", price: "$10.00" },
        { name: "  Gadget  ", price: "$20.00" },
      ],
    };
    const schema = {
      fields: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { normalize: "trim" },
              price: { normalize: "minor_units" },
            },
          },
        },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].name).toBe("Widget");
    expect(items[0].price).toBe(1000);
    expect(items[1].name).toBe("Gadget");
    expect(items[1].price).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// normalizeExtracted edge cases
// ---------------------------------------------------------------------------

describe("normalizeExtracted edge cases", () => {
  it("returns empty object for null input", () => {
    const [result, report] = normalizeExtracted(null, { fields: {} });
    expect(result).toEqual({});
    expect(report.applied).toHaveLength(0);
  });

  it("returns input unchanged when no normalize directives", () => {
    const extracted = { a: "hello", b: 42 };
    const [result] = normalizeExtracted(extracted, { fields: { a: {}, b: {} } });
    expect(result).toEqual({ a: "hello", b: 42 });
  });

  it("does not mutate the input object", () => {
    const extracted = { f: "  hello  " };
    const schema = { fields: { f: { normalize: "trim" } } };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.f).toBe("hello");
    expect(extracted.f).toBe("  hello  ");
  });
});

describe("resolve directive", () => {
  it("resolves field reference from template", () => {
    const extracted = {
      insurer_a: "Trisura Insurance Company",
      insurer_b: "Continental Casualty",
      gl_insurer_letter: "A",
      gl_insurer_name: null,
    };
    const schema = {
      fields: {
        insurer_a: { type: "string" },
        insurer_b: { type: "string" },
        gl_insurer_letter: { type: "string" },
        gl_insurer_name: { type: "string", resolve: "insurer_{gl_insurer_letter}" },
      },
    };
    const [result, report] = normalizeExtracted(extracted, schema);
    expect(result.gl_insurer_name).toBe("Trisura Insurance Company");
    expect(report.applied).toContainEqual(
      expect.objectContaining({ field: "gl_insurer_name", transform: expect.stringContaining("resolve") }),
    );
  });

  it("resolves to different insurer based on letter", () => {
    const extracted = {
      insurer_a: "Trisura",
      insurer_b: "Continental",
      auto_insurer_letter: "B",
      auto_insurer_name: null,
    };
    const schema = {
      fields: {
        insurer_a: { type: "string" },
        insurer_b: { type: "string" },
        auto_insurer_letter: { type: "string" },
        auto_insurer_name: { type: "string", resolve: "insurer_{auto_insurer_letter}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.auto_insurer_name).toBe("Continental");
  });

  it("does not overwrite existing value", () => {
    const extracted = {
      insurer_a: "Trisura",
      gl_insurer_letter: "A",
      gl_insurer_name: "Already Set",
    };
    const schema = {
      fields: {
        insurer_a: { type: "string" },
        gl_insurer_letter: { type: "string" },
        gl_insurer_name: { type: "string", resolve: "insurer_{gl_insurer_letter}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.gl_insurer_name).toBe("Already Set");
  });

  it("leaves null when referenced field is missing", () => {
    const extracted = {
      gl_insurer_letter: "C",
      gl_insurer_name: null,
    };
    const schema = {
      fields: {
        gl_insurer_letter: { type: "string" },
        gl_insurer_name: { type: "string", resolve: "insurer_{gl_insurer_letter}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.gl_insurer_name).toBeNull();
  });

  it("leaves null when source field is null", () => {
    const extracted = {
      insurer_a: "Trisura",
      gl_insurer_letter: null,
      gl_insurer_name: null,
    };
    const schema = {
      fields: {
        insurer_a: { type: "string" },
        gl_insurer_letter: { type: "string" },
        gl_insurer_name: { type: "string", resolve: "insurer_{gl_insurer_letter}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.gl_insurer_name).toBeNull();
  });
});
