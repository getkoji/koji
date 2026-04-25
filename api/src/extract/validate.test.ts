import { describe, it, expect } from "vitest";
import { validateExtracted, type ValidationReport } from "./validate";

// Helper to run validation with a single rule
function runRule(
  ruleName: string,
  params: unknown,
  data: Record<string, unknown>,
): ValidationReport {
  return validateExtracted(data, {
    validation: [{ [ruleName]: params }],
  });
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

describe("ValidationReport shape", () => {
  it("returns ok:true with empty issues when no rules", () => {
    const report = validateExtracted({ a: 1 }, {});
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("returns ok:true when validation is not an array", () => {
    const report = validateExtracted({ a: 1 }, { validation: "not an array" });
    expect(report.ok).toBe(true);
  });

  it("returns ok:true for null extracted", () => {
    const report = validateExtracted(null, { validation: [{ required: ["a"] }] });
    expect(report.ok).toBe(true);
  });

  it("issues have correct structure", () => {
    const report = runRule("required", ["missing_field"], {});
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toEqual({
      rule: "required",
      field: "missing_field",
      message: expect.stringContaining("missing"),
    });
  });
});

// ---------------------------------------------------------------------------
// required
// ---------------------------------------------------------------------------

describe("required rule", () => {
  it("passes when all required fields are present", () => {
    const report = runRule("required", ["name", "date"], {
      name: "John",
      date: "2025-01-01",
    });
    expect(report.ok).toBe(true);
  });

  it("fails when a required field is null", () => {
    const report = runRule("required", ["name"], { name: null });
    expect(report.ok).toBe(false);
    expect(report.issues[0].field).toBe("name");
  });

  it("fails when a required field is missing", () => {
    const report = runRule("required", ["name"], {});
    expect(report.ok).toBe(false);
  });

  it("fails when a required field is empty string", () => {
    const report = runRule("required", ["name"], { name: "  " });
    expect(report.ok).toBe(false);
  });

  it("fails when a required field is empty array", () => {
    const report = runRule("required", ["items"], { items: [] });
    expect(report.ok).toBe(false);
  });

  it("fails when a required field is empty object", () => {
    const report = runRule("required", ["meta"], { meta: {} });
    expect(report.ok).toBe(false);
  });

  it("reports multiple missing fields", () => {
    const report = runRule("required", ["a", "b", "c"], { b: "ok" });
    expect(report.issues).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// not_empty
// ---------------------------------------------------------------------------

describe("not_empty rule", () => {
  it("passes when field has a value", () => {
    const report = runRule("not_empty", ["name"], { name: "John" });
    expect(report.ok).toBe(true);
  });

  it("fails when field is null", () => {
    const report = runRule("not_empty", ["name"], { name: null });
    expect(report.ok).toBe(false);
  });

  it("fails when field is empty array", () => {
    const report = runRule("not_empty", ["items"], { items: [] });
    expect(report.ok).toBe(false);
  });

  it("fails when field is empty object", () => {
    const report = runRule("not_empty", ["meta"], { meta: {} });
    expect(report.ok).toBe(false);
  });

  it("passes when field is non-empty string (even whitespace)", () => {
    // not_empty checks null/empty-array/empty-object, not whitespace-only strings
    const report = runRule("not_empty", ["name"], { name: "  " });
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enum_in
// ---------------------------------------------------------------------------

describe("enum_in rule", () => {
  it("passes when value is in allowed set", () => {
    const report = runRule(
      "enum_in",
      { field: "status", allowed: ["active", "inactive"] },
      { status: "active" },
    );
    expect(report.ok).toBe(true);
  });

  it("fails when value is not in allowed set", () => {
    const report = runRule(
      "enum_in",
      { field: "status", allowed: ["active", "inactive"] },
      { status: "pending" },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].rule).toBe("enum_in");
    expect(report.issues[0].message).toContain("pending");
  });

  it("passes when value is null (not checked)", () => {
    const report = runRule(
      "enum_in",
      { field: "status", allowed: ["active", "inactive"] },
      { status: null },
    );
    expect(report.ok).toBe(true);
  });

  it("skips when params are malformed", () => {
    const report = runRule("enum_in", "bad params", { status: "x" });
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// date_order
// ---------------------------------------------------------------------------

describe("date_order rule", () => {
  it("passes when dates are in order", () => {
    const report = runRule("date_order", ["start_date", "end_date"], {
      start_date: "2025-01-01",
      end_date: "2025-12-31",
    });
    expect(report.ok).toBe(true);
  });

  it("fails when dates are out of order", () => {
    const report = runRule("date_order", ["start_date", "end_date"], {
      start_date: "2025-12-31",
      end_date: "2025-01-01",
    });
    expect(report.ok).toBe(false);
    expect(report.issues[0].rule).toBe("date_order");
  });

  it("passes when dates are equal", () => {
    const report = runRule("date_order", ["start_date", "end_date"], {
      start_date: "2025-06-15",
      end_date: "2025-06-15",
    });
    expect(report.ok).toBe(true);
  });

  it("skips when a date field is missing", () => {
    const report = runRule("date_order", ["start_date", "end_date"], {
      start_date: "2025-01-01",
    });
    expect(report.ok).toBe(true);
  });

  it("skips with fewer than 2 fields", () => {
    const report = runRule("date_order", ["start_date"], {
      start_date: "2025-01-01",
    });
    expect(report.ok).toBe(true);
  });

  it("validates 3+ dates in sequence", () => {
    const report = runRule("date_order", ["a", "b", "c"], {
      a: "2025-01-01",
      b: "2025-06-01",
      c: "2025-03-01",
    });
    expect(report.ok).toBe(false);
    expect(report.issues[0].message).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// sum_equals
// ---------------------------------------------------------------------------

describe("sum_equals rule", () => {
  it("passes when sum matches field value", () => {
    const report = runRule(
      "sum_equals",
      { field: "total", sum_of: "line_items.amount", tolerance: 0.01 },
      {
        total: 300,
        line_items: [{ amount: 100 }, { amount: 200 }],
      },
    );
    expect(report.ok).toBe(true);
  });

  it("passes within tolerance", () => {
    const report = runRule(
      "sum_equals",
      { field: "total", sum_of: "line_items.amount", tolerance: 1 },
      {
        total: 300.5,
        line_items: [{ amount: 100 }, { amount: 200 }],
      },
    );
    expect(report.ok).toBe(true);
  });

  it("fails when sum does not match", () => {
    const report = runRule(
      "sum_equals",
      { field: "total", sum_of: "line_items.amount", tolerance: 0.01 },
      {
        total: 500,
        line_items: [{ amount: 100 }, { amount: 200 }],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].rule).toBe("sum_equals");
  });

  it("skips when field value is null", () => {
    const report = runRule(
      "sum_equals",
      { field: "total", sum_of: "line_items.amount" },
      { total: null, line_items: [{ amount: 100 }] },
    );
    expect(report.ok).toBe(true);
  });

  it("skips when no numeric parts found", () => {
    const report = runRule(
      "sum_equals",
      { field: "total", sum_of: "line_items.amount" },
      { total: 100, line_items: [] },
    );
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// field_sum
// ---------------------------------------------------------------------------

describe("field_sum rule", () => {
  it("passes when field equals sum of addends", () => {
    const report = runRule(
      "field_sum",
      { field: "total", addends: ["subtotal", "tax"] },
      { total: 110, subtotal: 100, tax: 10 },
    );
    expect(report.ok).toBe(true);
  });

  it("fails when field does not equal sum of addends", () => {
    const report = runRule(
      "field_sum",
      { field: "total", addends: ["subtotal", "tax"] },
      { total: 200, subtotal: 100, tax: 10 },
    );
    expect(report.ok).toBe(false);
  });

  it("auto-corrects when auto_correct is true", () => {
    const data = { total: 200, subtotal: 100, tax: 10 };
    const report = runRule(
      "field_sum",
      { field: "total", addends: ["subtotal", "tax"], auto_correct: true },
      data,
    );
    expect(report.ok).toBe(false); // Still reported as issue
    expect(data.total).toBe(110); // But corrected
    expect(report.issues[0].message).toContain("corrected");
  });
});

// ---------------------------------------------------------------------------
// min_words
// ---------------------------------------------------------------------------

describe("min_words rule", () => {
  it("passes when field has enough words", () => {
    const report = runRule(
      "min_words",
      { field: "description", min: 3 },
      { description: "this is enough words" },
    );
    expect(report.ok).toBe(true);
  });

  it("fails and nulls field when below minimum", () => {
    const data: Record<string, unknown> = { description: "short" };
    const report = runRule("min_words", { field: "description", min: 3 }, data);
    expect(report.ok).toBe(false);
    expect(data.description).toBeNull();
    expect(report.issues[0].message).toContain("1 words");
  });

  it("skips non-string values", () => {
    const report = runRule(
      "min_words",
      { field: "description", min: 3 },
      { description: 42 },
    );
    expect(report.ok).toBe(true);
  });

  it("uses default min of 5 when not specified", () => {
    const data: Record<string, unknown> = { description: "one two three four" };
    const report = runRule("min_words", { field: "description" }, data);
    expect(report.ok).toBe(false);
    expect(data.description).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

describe("regex rule", () => {
  it("passes when value matches pattern", () => {
    const report = runRule(
      "regex",
      { field: "invoice_no", pattern: "^INV-\\d+$" },
      { invoice_no: "INV-12345" },
    );
    expect(report.ok).toBe(true);
  });

  it("fails when value does not match", () => {
    const report = runRule(
      "regex",
      { field: "invoice_no", pattern: "^INV-\\d+$" },
      { invoice_no: "PO-12345" },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].message).toContain("does not match");
  });

  it("skips when value is null", () => {
    const report = runRule(
      "regex",
      { field: "invoice_no", pattern: "^INV-\\d+$" },
      { invoice_no: null },
    );
    expect(report.ok).toBe(true);
  });

  it("reports invalid regex pattern", () => {
    const report = runRule(
      "regex",
      { field: "f", pattern: "[invalid" },
      { f: "test" },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].message).toContain("invalid pattern");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("validateExtracted edge cases", () => {
  it("reports malformed rule (not a single-key dict)", () => {
    const report = validateExtracted(
      { a: 1 },
      { validation: [{ rule1: [], rule2: [] }] },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].rule).toBe("malformed");
  });

  it("reports unknown rule name", () => {
    const report = validateExtracted(
      { a: 1 },
      { validation: [{ nonexistent_rule: [] }] },
    );
    expect(report.ok).toBe(false);
    expect(report.issues[0].rule).toBe("unknown");
  });

  it("runs multiple rules", () => {
    const report = validateExtracted(
      { name: null, status: "bad" },
      {
        validation: [
          { required: ["name"] },
          { enum_in: { field: "status", allowed: ["active", "inactive"] } },
        ],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(2);
  });

  it("handles array input gracefully", () => {
    const report = validateExtracted([1, 2, 3], {
      validation: [{ required: ["a"] }],
    });
    expect(report.ok).toBe(true); // Early return for non-object
  });
});
