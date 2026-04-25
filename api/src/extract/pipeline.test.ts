import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractFields, type ExtractionResult } from "./pipeline";
import type { ModelProvider } from "./providers";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function mockProvider(response: string): ModelProvider {
  return {
    generate: vi.fn().mockResolvedValue(response),
  };
}

// ---------------------------------------------------------------------------
// Basic extraction
// ---------------------------------------------------------------------------

describe("extractFields", () => {
  beforeEach(() => {
    // Suppress console.log during tests
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("extracts fields from a well-formed JSON response", async () => {
    const provider = mockProvider(
      JSON.stringify({
        invoice_number: "INV-001",
        total: 150.0,
        date: "2025-01-15",
      }),
    );

    const schema = {
      name: "invoice",
      fields: {
        invoice_number: { type: "string", required: true },
        total: { type: "number" },
        date: { type: "date" },
      },
    };

    const result = await extractFields("Invoice INV-001...", schema, provider, "gpt-4o");

    expect(result.extracted.invoice_number).toBe("INV-001");
    expect(result.extracted.total).toBe(150.0);
    expect(result.extracted.date).toBe("2025-01-15");
    expect(result.model).toBe("gpt-4o");
    expect(result.strategy).toBe("intelligent");
    expect(result.schema).toBe("invoice");
  });

  it("returns the correct ExtractionResult shape", async () => {
    const provider = mockProvider(JSON.stringify({ name: "Test" }));
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("doc text", schema, provider, "gpt-4o");

    expect(result).toHaveProperty("model");
    expect(result).toHaveProperty("strategy");
    expect(result).toHaveProperty("schema");
    expect(result).toHaveProperty("elapsed_ms");
    expect(result).toHaveProperty("extracted");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("confidence_scores");
    expect(result).toHaveProperty("normalization");
    expect(result).toHaveProperty("validation");
    expect(typeof result.elapsed_ms).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

describe("prompt building", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("includes all schema field names in the prompt", async () => {
    const provider = mockProvider(JSON.stringify({ a: 1, b: 2, c: 3 }));

    const schema = {
      name: "test",
      fields: {
        field_alpha: { type: "string", description: "Alpha field" },
        field_beta: { type: "number", required: true },
        field_gamma: { type: "date" },
      },
    };

    await extractFields("some markdown", schema, provider, "test-model");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("field_alpha");
    expect(prompt).toContain("field_beta");
    expect(prompt).toContain("field_gamma");
    expect(prompt).toContain("Alpha field");
    expect(prompt).toContain("REQUIRED");
  });

  it("includes the document markdown in the prompt", async () => {
    const provider = mockProvider(JSON.stringify({}));
    const schema = { name: "test", fields: { f: { type: "string" } } };

    await extractFields("## My Document\n\nHere is some content.", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("## My Document");
    expect(prompt).toContain("Here is some content.");
  });

  it("includes enum/options in the prompt", async () => {
    const provider = mockProvider(JSON.stringify({ status: "active" }));

    const schema = {
      name: "test",
      fields: {
        status: { type: "enum", options: ["active", "inactive", "pending"] },
      },
    };

    await extractFields("doc", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("active");
    expect(prompt).toContain("inactive");
    expect(prompt).toContain("pending");
  });

  it("includes extraction hints in the prompt", async () => {
    const provider = mockProvider(JSON.stringify({ f: "val" }));

    const schema = {
      name: "test",
      fields: {
        f: { type: "string", extraction_hint: "Look near the header" },
      },
    };

    await extractFields("doc", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("Look near the header");
  });

  it("includes date_locale instruction when set", async () => {
    const provider = mockProvider(JSON.stringify({}));

    const schema = {
      name: "test",
      fields: { f: { type: "string" } },
      date_locale: "DD/MM/YYYY",
    };

    await extractFields("doc", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("DD/MM/YYYY");
  });

  it("includes blank_form_aware instruction when set", async () => {
    const provider = mockProvider(JSON.stringify({}));

    const schema = {
      name: "test",
      fields: { f: { type: "string" } },
      blank_form_aware: true,
    };

    await extractFields("doc", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("BLANK unfilled form");
  });

  it("calls provider with jsonMode=true", async () => {
    const provider = mockProvider(JSON.stringify({}));
    const schema = { name: "test", fields: { f: { type: "string" } } };

    await extractFields("doc", schema, provider, "m");

    expect(provider.generate).toHaveBeenCalledWith(expect.any(String), true);
  });
});

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

describe("JSON parsing", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("handles JSON embedded in surrounding text", async () => {
    const provider = mockProvider(
      'Here is the result:\n\n{"name": "Test Corp"}\n\nDone.',
    );
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.name).toBe("Test Corp");
  });

  it("returns all nulls for completely invalid JSON", async () => {
    const provider = mockProvider("This is not JSON at all");
    const schema = {
      name: "test",
      fields: {
        name: { type: "string" },
        date: { type: "date" },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.name).toBeNull();
    expect(result.extracted.date).toBeNull();
    expect(result.confidence.name).toBe("not_found");
    expect(result.confidence.date).toBe("not_found");
    expect(result.confidence_scores.name).toBe(0);
  });

  it("unwraps nested result when LLM wraps under schema name", async () => {
    const provider = mockProvider(
      JSON.stringify({
        invoice: { invoice_number: "INV-001", total: 100 },
      }),
    );

    const schema = {
      name: "invoice",
      fields: {
        invoice_number: { type: "string" },
        total: { type: "number" },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.invoice_number).toBe("INV-001");
    expect(result.extracted.total).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

describe("confidence scoring", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("assigns not_found / 0 for null values", async () => {
    const provider = mockProvider(JSON.stringify({ name: null }));
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.confidence.name).toBe("not_found");
    expect(result.confidence_scores.name).toBe(0);
  });

  it("assigns high confidence for extracted values", async () => {
    const provider = mockProvider(JSON.stringify({ name: "Acme" }));
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.confidence.name).toBe("high");
    expect(result.confidence_scores.name).toBeGreaterThan(0);
  });

  it("assigns confidence for each field independently", async () => {
    const provider = mockProvider(
      JSON.stringify({ name: "Acme", phone: null }),
    );
    const schema = {
      name: "test",
      fields: {
        name: { type: "string" },
        phone: { type: "string" },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.confidence.name).toBe("high");
    expect(result.confidence.phone).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Field validation (inline)
// ---------------------------------------------------------------------------

describe("field validation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("normalizes date format with zero-padding", async () => {
    const provider = mockProvider(JSON.stringify({ date: "2025-1-5" }));
    const schema = { name: "test", fields: { date: { type: "date" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.date).toBe("2025-01-05");
  });

  it("coerces string numbers to numeric type", async () => {
    const provider = mockProvider(JSON.stringify({ total: "$1,234.56" }));
    const schema = { name: "test", fields: { total: { type: "number" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.total).toBe(1234.56);
  });

  it("snaps enum values to closest match (case-insensitive)", async () => {
    const provider = mockProvider(JSON.stringify({ status: "ACTIVE" }));
    const schema = {
      name: "test",
      fields: {
        status: { type: "enum", options: ["active", "inactive"] },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.status).toBe("active");
  });

  it("resolves mapping values to canonical form", async () => {
    const provider = mockProvider(JSON.stringify({ doc_type: "inv" }));
    const schema = {
      name: "test",
      fields: {
        doc_type: {
          type: "mapping",
          mappings: {
            invoice: ["inv", "bill"],
            receipt: ["rcpt"],
          },
        },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.doc_type).toBe("invoice");
  });

  it("sets missing fields to null", async () => {
    const provider = mockProvider(JSON.stringify({ name: "Test" }));
    const schema = {
      name: "test",
      fields: {
        name: { type: "string" },
        missing_field: { type: "string" },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.missing_field).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Normalization integration
// ---------------------------------------------------------------------------

describe("normalization integration", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("applies normalize transforms from schema", async () => {
    const provider = mockProvider(JSON.stringify({ name: "  HELLO  " }));
    const schema = {
      name: "test",
      fields: { name: { type: "string", normalize: ["trim", "lowercase"] } },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.name).toBe("hello");
    expect(result.normalization).toBeDefined();
    expect(result.normalization!.applied.length).toBeGreaterThan(0);
  });

  it("reports normalization details", async () => {
    const provider = mockProvider(JSON.stringify({ price: "$10.50" }));
    const schema = {
      name: "test",
      fields: { price: { type: "string", normalize: "minor_units" } },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.extracted.price).toBe(1050);
    expect(result.normalization!.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "price", transform: "minor_units" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation integration
// ---------------------------------------------------------------------------

describe("validation integration", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs schema validation rules and reports issues", async () => {
    const provider = mockProvider(JSON.stringify({ name: null }));
    const schema = {
      name: "test",
      fields: { name: { type: "string" } },
      validation: [{ required: ["name"] }],
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.validation).toBeDefined();
    expect(result.validation!.ok).toBe(false);
    expect(result.validation!.issues).toHaveLength(1);
  });

  it("reports ok:true when all validations pass", async () => {
    const provider = mockProvider(
      JSON.stringify({ name: "Acme", status: "active" }),
    );
    const schema = {
      name: "test",
      fields: {
        name: { type: "string" },
        status: { type: "string" },
      },
      validation: [
        { required: ["name"] },
        { enum_in: { field: "status", allowed: ["active", "inactive"] } },
      ],
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.validation!.ok).toBe(true);
    expect(result.validation!.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Array field types in prompt
// ---------------------------------------------------------------------------

describe("array fields", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("describes array of objects in the prompt", async () => {
    const provider = mockProvider(
      JSON.stringify({ line_items: [{ desc: "Widget", qty: 2 }] }),
    );

    const schema = {
      name: "invoice",
      fields: {
        line_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              desc: { type: "string" },
              qty: { type: "number" },
            },
          },
        },
      },
    };

    await extractFields("doc", schema, provider, "m");

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain("line_items");
    expect(prompt).toContain("array");
    expect(prompt).toContain("desc");
    expect(prompt).toContain("qty");
  });
});

// ---------------------------------------------------------------------------
// elapsed_ms
// ---------------------------------------------------------------------------

describe("elapsed_ms", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("records a non-negative elapsed time", async () => {
    const provider = mockProvider(JSON.stringify({}));
    const schema = { name: "test", fields: { f: { type: "string" } } };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});
