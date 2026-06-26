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
    expect(items[0]!.name).toBe("Widget");
    expect(items[0]!.price).toBe(1000);
    expect(items[1]!.name).toBe("Gadget");
    expect(items[1]!.price).toBe(2000);
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

// ---------------------------------------------------------------------------
// map directive
// ---------------------------------------------------------------------------

describe("map directive", () => {
  it("replaces a string value via lookup table", () => {
    const { value, report } = normField("Y", { map: { Y: "Yes", N: "No" } });
    expect(value).toBe("Yes");
    expect(report.applied.some((r) => r.transform.includes("map"))).toBe(true);
  });

  it("falls back to case-insensitive match when exact key missing", () => {
    const { value } = normField("YES", { map: { yes: "Yes", no: "No" } });
    expect(value).toBe("Yes");
  });

  it("trims whitespace for the case-insensitive fallback", () => {
    const { value } = normField("  yes  ", { map: { yes: "Yes" } });
    expect(value).toBe("Yes");
  });

  it("leaves the value untouched when no match", () => {
    const { value, report } = normField("maybe", { map: { yes: "Yes", no: "No" } });
    expect(value).toBe("maybe");
    expect(report.applied.some((r) => r.transform.includes("map"))).toBe(false);
  });

  it("skips non-string values", () => {
    const { value } = normField(42, { map: { "42": "forty-two" } });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// default directive
// ---------------------------------------------------------------------------

describe("default directive", () => {
  it("fills null with the default", () => {
    const { value, report } = normField(null, { default: "USD" });
    expect(value).toBe("USD");
    expect(report.applied.some((r) => r.transform.startsWith("default"))).toBe(true);
  });

  it("fills empty string with the default", () => {
    const { value } = normField("", { default: "USD" });
    expect(value).toBe("USD");
  });

  it("fills whitespace-only string with the default", () => {
    const { value } = normField("   ", { default: "USD" });
    expect(value).toBe("USD");
  });

  it("keeps a non-empty value", () => {
    const { value } = normField("EUR", { default: "USD" });
    expect(value).toBe("EUR");
  });

  it("keeps falsy-but-meaningful values (0, false)", () => {
    expect(normField(0, { default: 999 }).value).toBe(0);
    expect(normField(false, { default: true }).value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// concat directive
// ---------------------------------------------------------------------------

describe("concat directive", () => {
  it("combines source fields with the default space separator when target is empty", () => {
    const extracted = { first: "Frank", last: "Thomas", full: null };
    const schema = {
      fields: {
        first: { type: "string" },
        last: { type: "string" },
        full: { type: "string", concat: { fields: ["first", "last"] } },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.full).toBe("Frank Thomas");
  });

  it("honors a custom separator", () => {
    const extracted = { city: "Toronto", state: "ON", combined: "" };
    const schema = {
      fields: {
        city: { type: "string" },
        state: { type: "string" },
        combined: { type: "string", concat: { fields: ["city", "state"], separator: ", " } },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.combined).toBe("Toronto, ON");
  });

  it("trims and skips null/empty source fields", () => {
    const extracted = { a: "  hello  ", b: null, c: "", d: "world", out: null };
    const schema = {
      fields: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        d: { type: "string" },
        out: { type: "string", concat: { fields: ["a", "b", "c", "d"] } },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.out).toBe("hello world");
  });

  it("does NOT overwrite an existing non-empty target", () => {
    const extracted = { first: "Frank", last: "Thomas", full: "Existing Name" };
    const schema = {
      fields: {
        first: { type: "string" },
        last: { type: "string" },
        full: { type: "string", concat: { fields: ["first", "last"] } },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.full).toBe("Existing Name");
  });
});

// ---------------------------------------------------------------------------
// computed directive
// ---------------------------------------------------------------------------

describe("computed directive", () => {
  it("interpolates {field} placeholders from other extracted values", () => {
    const extracted = { city: "Toronto", country: "Canada", location: null };
    const schema = {
      fields: {
        city: { type: "string" },
        country: { type: "string" },
        location: { type: "string", computed: "{city}, {country}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.location).toBe("Toronto, Canada");
  });

  it("strips placeholders with no matching field", () => {
    const extracted = { city: "Toronto", out: null };
    const schema = {
      fields: {
        city: { type: "string" },
        out: { type: "string", computed: "{city} {missing}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.out).toBe("Toronto");
  });

  it("leaves the target untouched when the template produces empty output", () => {
    const extracted = { out: null };
    const schema = {
      fields: {
        out: { type: "string", computed: "{missing} {also_missing}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.out).toBeNull();
  });

  it("does NOT overwrite an existing non-empty target", () => {
    const extracted = { city: "Toronto", country: "Canada", location: "Pre-filled" };
    const schema = {
      fields: {
        city: { type: "string" },
        country: { type: "string" },
        location: { type: "string", computed: "{city}, {country}" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.location).toBe("Pre-filled");
  });
});

// ---------------------------------------------------------------------------
// rename directive
// ---------------------------------------------------------------------------

describe("rename directive", () => {
  it("renames a field's output key", () => {
    const extracted = { policy_no: "ABC-123" };
    const schema = {
      fields: {
        policy_no: { type: "string", rename: "policyNumber" },
      },
    };
    const [result, report] = normalizeExtracted(extracted, schema);
    expect(result.policyNumber).toBe("ABC-123");
    expect("policy_no" in result).toBe(false);
    expect(report.applied.some((r) => r.transform.startsWith("rename"))).toBe(true);
  });

  it("does NOT overwrite an existing field with the new name", () => {
    const extracted = { policy_no: "ABC-123", policyNumber: "XYZ-789" };
    const schema = {
      fields: {
        policy_no: { type: "string", rename: "policyNumber" },
        policyNumber: { type: "string" },
      },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.policyNumber).toBe("XYZ-789");
    // The original key stays — collision short-circuits the rename.
    expect(result.policy_no).toBe("ABC-123");
  });

  it("ignores a rename to the same name", () => {
    const extracted = { name: "Frank" };
    const schema = {
      fields: { name: { type: "string", rename: "name" } },
    };
    const [result] = normalizeExtracted(extracted, schema);
    expect(result.name).toBe("Frank");
  });
});

// ---------------------------------------------------------------------------
// collapse_spaces
// ---------------------------------------------------------------------------

describe("collapse_spaces transform", () => {
  it("collapses runs of spaces to one", () => {
    const { value } = normField("ACME   Corp", { normalize: "collapse_spaces" });
    expect(value).toBe("ACME Corp");
  });

  it("collapses mixed spaces and tabs", () => {
    const { value } = normField("foo \t\t bar", { normalize: "collapse_spaces" });
    expect(value).toBe("foo bar");
  });

  it("preserves newlines (multi-line addresses)", () => {
    const { value } = normField("123 Main St\n  Apt  4", {
      normalize: "collapse_spaces",
    });
    expect(value).toBe("123 Main St\n Apt 4");
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "collapse_spaces" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// remove_spaces
// ---------------------------------------------------------------------------

describe("remove_spaces transform", () => {
  it("strips spaces from codes and identifiers", () => {
    const { value } = normField("ABC 123", { normalize: "remove_spaces" });
    expect(value).toBe("ABC123");
  });

  it("strips runs of spaces", () => {
    const { value } = normField("555   123   4567", {
      normalize: "remove_spaces",
    });
    expect(value).toBe("5551234567");
  });

  it("strips tabs and newlines too (any whitespace is noise here)", () => {
    const { value } = normField("ABC\t123\n456", {
      normalize: "remove_spaces",
    });
    expect(value).toBe("ABC123456");
  });

  it("strips Unicode non-breaking spaces (U+00A0)", () => {
    const { value } = normField("ABC 123", { normalize: "remove_spaces" });
    expect(value).toBe("ABC123");
  });

  it("leaves a string with no whitespace unchanged", () => {
    const { value, report } = normField("ABC123", {
      normalize: "remove_spaces",
    });
    expect(value).toBe("ABC123");
    expect(
      report.applied.filter((a) => a.transform === "remove_spaces"),
    ).toHaveLength(0);
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "remove_spaces" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// fix_punctuation_spacing
// ---------------------------------------------------------------------------

describe("fix_punctuation_spacing transform", () => {
  it("removes space before comma", () => {
    const { value } = normField("Smith , Jones", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("Smith, Jones");
  });

  it("removes space before period, semicolon, colon, paren-close", () => {
    const { value } = normField("end . next ; then : and )", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("end. next; then: and)");
  });

  it("adds space after comma/semicolon/colon when missing before a letter", () => {
    const { value } = normField("Smith,Jones;extra:more", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("Smith, Jones; extra: more");
  });

  it("preserves initials with periods (does not space . before letter)", () => {
    const { value } = normField("J. R. R. Tolkien", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("J. R. R. Tolkien");
  });

  it("preserves decimal numbers (period without surrounding space)", () => {
    const { value } = normField("Total: $1,234.56", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("Total: $1,234.56");
  });

  it("does not break already-correct text", () => {
    const { value, report } = normField("ACME Corp, Inc.", {
      normalize: "fix_punctuation_spacing",
    });
    expect(value).toBe("ACME Corp, Inc.");
    expect(
      report.applied.filter((a) => a.transform === "fix_punctuation_spacing"),
    ).toHaveLength(0);
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "fix_punctuation_spacing" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// prose preset (trim + collapse_spaces + fix_punctuation_spacing)
// ---------------------------------------------------------------------------

describe("prose transform", () => {
  it("fixes the common OCR spacing failure modes in one pass", () => {
    const { value } = normField("  ACME   Corp , Inc.  ", { normalize: "prose" });
    expect(value).toBe("ACME Corp, Inc.");
  });

  it("handles legal-name OCR output (space before comma, no space after)", () => {
    const { value } = normField("Robert M. Critz , P.A.", { normalize: "prose" });
    expect(value).toBe("Robert M. Critz, P.A.");
  });

  it("normalizes a multi-issue address", () => {
    const { value } = normField("200 QUEENS  OFFICE  CONDOMINIUM   ASSOCIATION INC", {
      normalize: "prose",
    });
    expect(value).toBe("200 QUEENS OFFICE CONDOMINIUM ASSOCIATION INC");
  });

  it("leaves a clean string unchanged", () => {
    const { value, report } = normField("The Cincinnati Insurance Companies", {
      normalize: "prose",
    });
    expect(value).toBe("The Cincinnati Insurance Companies");
    expect(report.applied.filter((a) => a.transform === "prose")).toHaveLength(0);
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "prose" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// digits_only
// ---------------------------------------------------------------------------

describe("digits_only transform", () => {
  it("strips formatting from a phone-like string", () => {
    const { value } = normField("(555) 123-4567", { normalize: "digits_only" });
    expect(value).toBe("5551234567");
  });

  it("strips letters too", () => {
    const { value } = normField("ABC-123-DEF", { normalize: "digits_only" });
    expect(value).toBe("123");
  });

  it("returns empty string when there are no digits", () => {
    const { value } = normField("hello", { normalize: "digits_only" });
    expect(value).toBe("");
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "digits_only" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// integer
// ---------------------------------------------------------------------------

describe("integer transform", () => {
  it("parses a human-formatted integer", () => {
    const { value } = normField("1,234", { normalize: "integer" });
    expect(value).toBe(1234);
  });

  it("handles negatives", () => {
    const { value } = normField("-1,234", { normalize: "integer" });
    expect(value).toBe(-1234);
  });

  it("strips underscores and spaces (common separators)", () => {
    const { value } = normField("1_000_000", { normalize: "integer" });
    expect(value).toBe(1000000);
  });

  it("bails on decimals (does not silently truncate)", () => {
    const { value } = normField("1.5", { normalize: "integer" });
    expect(value).toBe("1.5");
  });

  it("bails on garbage", () => {
    const { value } = normField("not a number", { normalize: "integer" });
    expect(value).toBe("not a number");
  });

  it("passes through numbers unchanged", () => {
    const { value } = normField(42, { normalize: "integer" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// decimal_amount
// ---------------------------------------------------------------------------

describe("decimal_amount transform", () => {
  it("parses a dollar string", () => {
    const { value } = normField("$1,234.56", { normalize: "decimal_amount" });
    expect(value).toBe(1234.56);
  });

  it("recognises accounting parentheses as negatives", () => {
    const { value } = normField("(50.00)", { normalize: "decimal_amount" });
    expect(value).toBe(-50);
  });

  it("parses a bare decimal", () => {
    const { value } = normField("0.42", { normalize: "decimal_amount" });
    expect(value).toBe(0.42);
  });

  it("passes through numbers unchanged", () => {
    const { value } = normField(99.5, { normalize: "decimal_amount" });
    expect(value).toBe(99.5);
  });

  it("bails on garbage", () => {
    const { value } = normField("not a number", { normalize: "decimal_amount" });
    expect(value).toBe("not a number");
  });
});

// ---------------------------------------------------------------------------
// percent
// ---------------------------------------------------------------------------

describe("percent transform", () => {
  it("strips the percent sign and parses as number", () => {
    const { value } = normField("12%", { normalize: "percent" });
    expect(value).toBe(12);
  });

  it("preserves magnitude (does NOT divide by 100)", () => {
    const { value } = normField("12.5%", { normalize: "percent" });
    expect(value).toBe(12.5);
  });

  it("handles a value with no percent sign", () => {
    const { value } = normField("12", { normalize: "percent" });
    expect(value).toBe(12);
  });

  it("passes through numbers unchanged", () => {
    const { value } = normField(12, { normalize: "percent" });
    expect(value).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------

describe("boolean transform", () => {
  it("coerces common truthy strings", () => {
    for (const s of ["true", "TRUE", "yes", "Y", "1", "on"]) {
      const { value } = normField(s, { normalize: "boolean" });
      expect(value).toBe(true);
    }
  });

  it("coerces common falsy strings", () => {
    for (const s of ["false", "FALSE", "no", "N", "0", "off"]) {
      const { value } = normField(s, { normalize: "boolean" });
      expect(value).toBe(false);
    }
  });

  it("passes through actual booleans unchanged", () => {
    expect(normField(true, { normalize: "boolean" }).value).toBe(true);
    expect(normField(false, { normalize: "boolean" }).value).toBe(false);
  });

  it("passes through unrecognised strings unchanged", () => {
    const { value } = normField("maybe", { normalize: "boolean" });
    expect(value).toBe("maybe");
  });

  it("trims whitespace before checking", () => {
    const { value } = normField("  yes  ", { normalize: "boolean" });
    expect(value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

describe("email transform", () => {
  it("trims and lowercases", () => {
    const { value } = normField("  Foo@Bar.COM ", { normalize: "email" });
    expect(value).toBe("foo@bar.com");
  });

  it("leaves a clean email unchanged", () => {
    const { value, report } = normField("foo@bar.com", { normalize: "email" });
    expect(value).toBe("foo@bar.com");
    expect(report.applied.filter((a) => a.transform === "email")).toHaveLength(0);
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "email" });
    expect(value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

describe("url transform", () => {
  it("lowercases scheme and host", () => {
    const { value } = normField("HTTPS://Example.COM/Foo", { normalize: "url" });
    expect(value).toBe("https://example.com/Foo");
  });

  it("drops trailing slash on path-root URLs", () => {
    const { value } = normField("https://example.com/", { normalize: "url" });
    expect(value).toBe("https://example.com");
  });

  it("preserves trailing slash on non-root paths", () => {
    const { value } = normField("https://example.com/foo/", { normalize: "url" });
    expect(value).toBe("https://example.com/foo/");
  });

  it("preserves query and hash", () => {
    const { value } = normField("https://example.com/?q=1#frag", {
      normalize: "url",
    });
    expect(value).toBe("https://example.com/?q=1#frag");
  });

  it("passes through invalid URLs unchanged", () => {
    const { value } = normField("not a url", { normalize: "url" });
    expect(value).toBe("not a url");
  });
});

// ---------------------------------------------------------------------------
// title_case
// ---------------------------------------------------------------------------

describe("title_case transform", () => {
  it("capitalizes each word", () => {
    const { value } = normField("acme corp", { normalize: "title_case" });
    expect(value).toBe("Acme Corp");
  });

  it("preserves already-uppercase tokens as acronyms", () => {
    const { value } = normField("ACME corp", { normalize: "title_case" });
    expect(value).toBe("ACME Corp");
  });

  it("lowercases mixed-case non-acronyms", () => {
    const { value } = normField("aCMe CoRp", { normalize: "title_case" });
    expect(value).toBe("Acme Corp");
  });

  it("handles hyphenated names", () => {
    const { value } = normField("smith-jones", { normalize: "title_case" });
    expect(value).toBe("Smith-Jones");
  });

  it("passes through non-string values", () => {
    const { value } = normField(42, { normalize: "title_case" });
    expect(value).toBe(42);
  });
});
