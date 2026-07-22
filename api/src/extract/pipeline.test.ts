import { describe, it, expect, vi, beforeEach } from "vitest";
import { collapseKeyedRows, extractFields, extractLlmConfidence, extractLlmReasoning, extractSourceTexts, isCaptionValue, recoverCaptionValues, rejectCaptionValues, skipMarkedRows, stripProvenanceKeys, validateFields, valueAfterLabel, type ExtractionResult } from "./pipeline";
import type { ModelProvider } from "./providers";
import { DEFAULT_CONTEXT_TOKENS } from "./context-budget";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function mockProvider(response: string): ModelProvider {
  return {
    contextTokens: DEFAULT_CONTEXT_TOKENS,
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

  it("strips inline `__`-provenance keys from extracted output at every depth", async () => {
    // The model emits provenance inline, including on a nested array item that
    // the shallow top-level harvest never reaches.
    const provider = mockProvider(
      JSON.stringify({
        insured: "Acme",
        __source_text: { insured: "ACME CORP" },
        __source_context: { insured: "Named Insured: ACME CORP" },
        coverages: [
          {
            coverage: "GL",
            __source_text: "COMMERCIAL GENERAL LIABILITY",
            limits: [{ name: "Each Occurrence", amount: 1000, __source_text: "Each Occurrence $1,000" }],
          },
        ],
      }),
    );
    const schema = {
      name: "policy",
      fields: {
        insured: { type: "string" },
        coverages: { type: "array" },
      },
    };

    const result = await extractFields("policy text", schema, provider, "gpt-4o");

    const json = JSON.stringify(result.extracted);
    expect(json).not.toContain("__source_text");
    expect(json).not.toContain("__source_context");
    expect(result.extracted.insured).toBe("Acme");
    const cov = (result.extracted.coverages as Array<Record<string, unknown>>)[0]!;
    expect(cov.coverage).toBe("GL");
    expect((cov.limits as Array<Record<string, unknown>>)[0]).toEqual({ name: "Each Occurrence", amount: 1000 });
  });
});

describe("stripProvenanceKeys", () => {
  it("recursively deletes `__`-prefixed keys and leaves data untouched", () => {
    const v = {
      a: 1,
      __source_text: "x",
      nested: { b: 2, __source_context: "y", arr: [{ c: 3, __source_text: "z" }] },
    };
    stripProvenanceKeys(v);
    expect(v).toEqual({ a: 1, nested: { b: 2, arr: [{ c: 3 }] } });
  });

  it("is a no-op on scalars, null, and undefined", () => {
    expect(() => stripProvenanceKeys(null)).not.toThrow();
    expect(() => stripProvenanceKeys(undefined)).not.toThrow();
    expect(() => stripProvenanceKeys(42)).not.toThrow();
  });
});

describe("isCaptionValue", () => {
  it("flags values that end with a colon (labels/captions)", () => {
    expect(isCaptionValue("NAMED INSURED AND ADDRESS:")).toBe(true);
    expect(isCaptionValue("  Policy Number:  ")).toBe(true);
  });

  it("does not flag real data values", () => {
    expect(isCaptionValue("BELLASERA OFFICE PARK OWNERS ASSOCIATION")).toBe(false);
    expect(isCaptionValue("CHARLOTTE, NC 28209")).toBe(false);
    expect(isCaptionValue("GL-12345")).toBe(false);
  });

  it("ignores non-strings and a lone colon", () => {
    expect(isCaptionValue(null)).toBe(false);
    expect(isCaptionValue(42)).toBe(false);
    expect(isCaptionValue(":")).toBe(false);
  });
});

describe("rejectCaptionValues", () => {
  const fields = {
    insured_name: { type: "string", hints: { reject_caption: true } },
    notes: { type: "string" }, // no opt-in → never touched
  };

  it("nulls a caption value only for fields that opt in", () => {
    const extracted: Record<string, unknown> = {
      insured_name: "NAMED INSURED AND ADDRESS:",
      notes: "SEE ATTACHED:", // caption-shaped but NOT opted in
    };
    const nulled = rejectCaptionValues(extracted, fields);
    expect(nulled).toEqual(["insured_name"]);
    expect(extracted.insured_name).toBeNull();
    expect(extracted.notes).toBe("SEE ATTACHED:"); // untouched
  });

  it("leaves a correct value alone", () => {
    const extracted: Record<string, unknown> = { insured_name: "BELLASERA OFFICE PARK OWNERS ASSOCIATION" };
    const nulled = rejectCaptionValues(extracted, fields);
    expect(nulled).toEqual([]);
    expect(extracted.insured_name).toBe("BELLASERA OFFICE PARK OWNERS ASSOCIATION");
  });
});

describe("collapseKeyedRows", () => {
  const fields = {
    coverages: { type: "array", hints: { element_key: "coverage_code" } },
    notes: { type: "array" }, // no element_key → never touched
  };

  it("collapses same-key rows to the richest variant, preserving order", () => {
    const extracted: Record<string, unknown> = {
      coverages: [
        { coverage_code: "property", premium: "6955.91" },
        { coverage_code: "general_liability", premium: "360" },
        { coverage_code: "property", premium: "25000", limit: "500000" }, // richest property
        { coverage_code: "property", premium: "25000" },
      ],
    };
    const report = collapseKeyedRows(extracted, fields);
    expect(report).toEqual([{ field: "coverages", collapsed: 2 }]);
    expect(extracted.coverages).toEqual([
      { coverage_code: "general_liability", premium: "360" },
      { coverage_code: "property", premium: "25000", limit: "500000" },
    ]);
  });

  it("keeps the earliest variant on a richness tie", () => {
    const extracted: Record<string, unknown> = {
      coverages: [
        { coverage_code: "auto", premium: "100" },
        { coverage_code: "auto", premium: "999" },
      ],
    };
    collapseKeyedRows(extracted, fields);
    expect(extracted.coverages).toEqual([{ coverage_code: "auto", premium: "100" }]);
  });

  it("matches keys case- and whitespace-insensitively", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ coverage_code: "Fidelity  Crime" }, { coverage_code: "fidelity crime", limit: "25000" }],
    };
    collapseKeyedRows(extracted, fields);
    expect(extracted.coverages).toEqual([{ coverage_code: "fidelity crime", limit: "25000" }]);
  });

  it("keeps rows that don't carry the key, and ignores provenance keys in richness", () => {
    const extracted: Record<string, unknown> = {
      coverages: [
        { coverage_code: null, premium: "1" },
        { premium: "2" },
        { coverage_code: "gl", __source_text: "a", __x: "b" }, // richness 1
        { coverage_code: "gl", limit: "5", premium: "6" }, // richness 3 → wins
      ],
    };
    const report = collapseKeyedRows(extracted, fields);
    expect(report).toEqual([{ field: "coverages", collapsed: 1 }]);
    expect((extracted.coverages as unknown[]).length).toBe(3);
    expect((extracted.coverages as Array<Record<string, unknown>>)[2]).toEqual({
      coverage_code: "gl",
      limit: "5",
      premium: "6",
    });
  });

  it("keeps index-aligned source_texts in sync", () => {
    const extracted: Record<string, unknown> = {
      coverages: [
        { coverage_code: "property", premium: "1" },
        { coverage_code: "property", premium: "2", limit: "3" },
        { coverage_code: "gl" },
      ],
    };
    const sourceTexts: Record<string, string[]> = { coverages: ["src-a", "src-b", "src-c"] };
    collapseKeyedRows(extracted, fields, sourceTexts);
    expect(sourceTexts.coverages).toEqual(["src-b", "src-c"]);
  });

  it("does nothing without element_key or with unique keys", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ coverage_code: "a" }, { coverage_code: "b" }],
      notes: [{ n: "x" }, { n: "x" }],
    };
    expect(collapseKeyedRows(extracted, fields)).toEqual([]);
    expect((extracted.coverages as unknown[]).length).toBe(2);
    expect((extracted.notes as unknown[]).length).toBe(2);
  });
});

describe("skipMarkedRows", () => {
  const fields = {
    coverages: { type: "array", hints: { skip_row_when: ["Not Covered", "^\\$0$", "if included"] } },
    locations: { type: "array" }, // no opt-in → never touched
  };

  it("drops rows whose string values match a pattern, case-insensitively", () => {
    const extracted: Record<string, unknown> = {
      coverages: [
        { code: "GL", limit: "$1,000,000" },
        { code: "CYBER", limit: "NOT COVERED" },
        { code: "TRIA", limit: "If Included In The Policy" },
        { code: "PROP", limit: "$500,000" },
      ],
    };
    const report = skipMarkedRows(extracted, fields);
    expect(report).toEqual([{ field: "coverages", dropped: 2 }]);
    expect((extracted.coverages as unknown[]).map((r) => (r as { code: string }).code)).toEqual(["GL", "PROP"]);
  });

  it("matches nested string leaves and bare string elements", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "UMB", detail: { limit: "$0" } }, "Not Covered", { code: "GL", detail: { limit: "$5,000" } }],
    };
    skipMarkedRows(extracted, fields);
    expect(extracted.coverages).toEqual([{ code: "GL", detail: { limit: "$5,000" } }]);
  });

  it("does not match a pattern inside a longer value when anchored", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "GL", limit: "$1,000,000 ($0 deductible)" }],
    };
    const report = skipMarkedRows(extracted, fields);
    expect(report).toEqual([]);
    expect(extracted.coverages).toHaveLength(1);
  });

  it("only touches fields that opt in, and ignores non-arrays", () => {
    const extracted: Record<string, unknown> = {
      coverages: "Not Covered", // not an array → untouched even though it matches
      locations: [{ address: "Not Covered Lane" }],
    };
    const report = skipMarkedRows(extracted, fields);
    expect(report).toEqual([]);
    expect(extracted.coverages).toBe("Not Covered");
    expect(extracted.locations).toHaveLength(1);
  });

  it("keeps index-aligned source_texts in sync when rows drop", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "GL" }, { code: "CYBER", limit: "Not Covered" }, { code: "PROP" }],
    };
    const sourceTexts: Record<string, string[]> = { coverages: ["src-gl", "src-cyber", "src-prop"] };
    skipMarkedRows(extracted, fields, sourceTexts);
    expect(sourceTexts.coverages).toEqual(["src-gl", "src-prop"]);
  });

  it("leaves source_texts alone when lengths already disagree", () => {
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "GL" }, { code: "CYBER", limit: "Not Covered" }],
    };
    const sourceTexts: Record<string, string[]> = { coverages: ["only-one"] };
    skipMarkedRows(extracted, fields, sourceTexts);
    expect(sourceTexts.coverages).toEqual(["only-one"]);
  });

  it("drops a row whose SOURCE line matches even when its values look real", () => {
    const optFields = {
      coverages: { type: "array", hints: { skip_row_when: ["OPTIONAL", "^\\s*☐"] } },
    };
    const extracted: Record<string, unknown> = {
      coverages: [
        { code: "GL", premium: "$4,120" },
        { code: "UMB", premium: "$1,200" }, // values look bound…
        { code: "FID", premium: "$800" },
      ],
    };
    const sourceTexts: Record<string, string[]> = {
      coverages: [
        "General Liability   $4,120",
        "OPTIONAL COVERAGES AVAILABLE: Umbrella $1,200", // …but the source line is a menu row
        "☐ Fidelity Bond  $800",
      ],
    };
    const report = skipMarkedRows(extracted, optFields, sourceTexts);
    expect(report).toEqual([{ field: "coverages", dropped: 2 }]);
    expect(extracted.coverages).toEqual([{ code: "GL", premium: "$4,120" }]);
    expect(sourceTexts.coverages).toEqual(["General Liability   $4,120"]);
  });

  it("does not use source lines when they are misaligned with the array", () => {
    const optFields = {
      coverages: { type: "array", hints: { skip_row_when: ["OPTIONAL"] } },
    };
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "GL" }, { code: "UMB" }],
    };
    // One text for two rows — matching by index would blame the wrong row.
    const sourceTexts: Record<string, string[]> = { coverages: ["OPTIONAL COVERAGES"] };
    const report = skipMarkedRows(extracted, optFields, sourceTexts);
    expect(report).toEqual([]);
    expect(extracted.coverages).toHaveLength(2);
  });

  it("drops an enumerated row by its source line, full loop through extractFields", async () => {
    // The end-to-end gate: the enumeration pass re-adds a row from an
    // option/menu line whose extracted values look real; the deterministic
    // backstop drops it by its verbatim source line.
    const queue = [
      JSON.stringify({
        coverages: [{ code: "GL", premium: "$4,120", __source_text: "General Liability $4,120" }],
      }),
      JSON.stringify({
        coverages: [
          { code: "GL", premium: "$4,120" },
          { code: "UMB", premium: "$1,200", __source_text: "OPTIONAL COVERAGES AVAILABLE: Umbrella $1,200" },
        ],
      }),
    ];
    const provider: ModelProvider = {
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      generate: vi.fn().mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)),
    };
    const schema = {
      name: "policy",
      fields: {
        coverages: {
          type: "array",
          items: { type: "object", properties: { code: { type: "string" }, premium: { type: "string" } } },
          hints: { enumerate_rows: true, skip_row_when: ["OPTIONAL COVERAGES"] },
        },
      },
    };

    const result = await extractFields("# Coverages\nGeneral Liability $4,120\nmore text", schema, provider, "m");

    expect(result.extracted.coverages).toEqual([{ code: "GL", premium: "$4,120" }]);
    expect(result.source_texts?.coverages).toEqual(["General Liability $4,120"]);
    expect(result.normalization?.warnings).toContain("coverages: dropped 1 row(s) matching skip_row_when");
  });

  it("skips malformed regex patterns without throwing", () => {
    const badFields = { coverages: { type: "array", hints: { skip_row_when: ["([", "Not Covered"] } } };
    const extracted: Record<string, unknown> = {
      coverages: [{ code: "GL" }, { code: "CYBER", limit: "Not Covered" }],
    };
    expect(() => skipMarkedRows(extracted, badFields)).not.toThrow();
    expect(extracted.coverages).toEqual([{ code: "GL" }]);
  });
});

describe("valueAfterLabel", () => {
  const md = [
    "NAMED INSURED AND ADDRESS:",
    "BELLASERA OFFICE PARK OWNERS ASSOCIATION",
    "5200 PARK RD STE 111",
    "CHARLOTTE, NC 28209",
  ].join("\n");

  it("returns the line after the matching label", () => {
    expect(valueAfterLabel("NAMED INSURED AND ADDRESS:", md)).toBe("BELLASERA OFFICE PARK OWNERS ASSOCIATION");
  });

  it("matches ignoring markdown decoration and trailing colon", () => {
    const decorated = "**NAMED INSURED AND ADDRESS:**\nBELLASERA OFFICE PARK OWNERS ASSOCIATION";
    expect(valueAfterLabel("NAMED INSURED AND ADDRESS:", decorated)).toBe("BELLASERA OFFICE PARK OWNERS ASSOCIATION");
  });

  it("skips blank lines to the first real value", () => {
    expect(valueAfterLabel("Label:", "Label:\n\n\nActual Value")).toBe("Actual Value");
  });

  it("returns null when the next non-empty line is another label", () => {
    expect(valueAfterLabel("Label:", "Label:\nAnother Label:\nvalue")).toBeNull();
  });

  it("returns null when the label isn't found", () => {
    expect(valueAfterLabel("Missing Label:", md)).toBeNull();
  });
});

describe("recoverCaptionValues", () => {
  const md = ["NAMED INSURED AND ADDRESS:", "BELLASERA OFFICE PARK OWNERS ASSOCIATION", "5200 PARK RD STE 111"].join("\n");
  const fields = {
    insured_name: { type: "string", hints: { take_value_after_label: true } },
    other: { type: "string" }, // no opt-in
  };

  it("recovers the value from the line after the label for opted-in fields", () => {
    const extracted: Record<string, unknown> = { insured_name: "NAMED INSURED AND ADDRESS:", other: "SOME LABEL:" };
    const out = recoverCaptionValues(extracted, fields, md);
    expect(out.recovered).toEqual(["insured_name"]);
    expect(extracted.insured_name).toBe("BELLASERA OFFICE PARK OWNERS ASSOCIATION");
    expect(extracted.other).toBe("SOME LABEL:"); // not opted in → untouched
  });

  it("nulls (never emits the caption) when no value can be recovered", () => {
    const extracted: Record<string, unknown> = { insured_name: "NAMED INSURED AND ADDRESS:" };
    const out = recoverCaptionValues(extracted, fields, "some unrelated document text");
    expect(out.nulled).toEqual(["insured_name"]);
    expect(extracted.insured_name).toBeNull();
  });

  it("leaves a correct (non-caption) value alone", () => {
    const extracted: Record<string, unknown> = { insured_name: "BELLASERA OFFICE PARK OWNERS ASSOCIATION" };
    const out = recoverCaptionValues(extracted, fields, md);
    expect(out.recovered).toEqual([]);
    expect(out.nulled).toEqual([]);
    expect(extracted.insured_name).toBe("BELLASERA OFFICE PARK OWNERS ASSOCIATION");
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

  it("assigns low confidence when value has no provenance and no llm confidence", async () => {
    const provider = mockProvider(JSON.stringify({ name: "Acme" }));
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("doc", schema, provider, "m");
    // Fallback: 0.70 * 0 (no provenance) + 0.30 * 1 (valid) = 0.30
    expect(result.confidence.name).toBe("low");
    expect(result.confidence_scores.name).toBeGreaterThan(0);
    expect(result.confidence_scores.name).toBeLessThan(0.4);
  });

  it("assigns high confidence when value found in source text", async () => {
    const provider = mockProvider(JSON.stringify({ name: "Acme Corp" }));
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("Name: Acme Corp", schema, provider, "m");
    // Fallback: 0.70 * 0.85 (provenance, no bbox) + 0.30 * 1 (valid) = 0.895
    expect(result.confidence.name).toBe("high");
    expect(result.confidence_scores.name).toBeGreaterThanOrEqual(0.7);
  });

  it("LLM self-reported confidence is ignored (stripped but not used in scoring)", async () => {
    const response = JSON.stringify({
      name: "Acme Corp",
      __confidence: { name: 0.95 },
    });
    const provider = mockProvider(response);
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("Name: Acme Corp", schema, provider, "m");
    // LLM confidence ignored; 0.70 * 0.85 (provenance, no bbox) + 0.30 * 1 (valid) = 0.895
    expect(result.confidence.name).toBe("high");
    expect(result.confidence_scores.name).toBeGreaterThanOrEqual(0.7);
    // __confidence should not leak into extracted output
    expect(result.extracted).not.toHaveProperty("__confidence");
  });

  it("falls back gracefully when __confidence is malformed", async () => {
    const response = JSON.stringify({
      name: "Acme Corp",
      __confidence: "not a dict",
    });
    const provider = mockProvider(response);
    const schema = { name: "test", fields: { name: { type: "string" } } };

    const result = await extractFields("Name: Acme Corp", schema, provider, "m");
    // Should still produce a score using fallback weights
    expect(result.confidence_scores.name).toBeGreaterThan(0);
    expect(result.extracted).not.toHaveProperty("__confidence");
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
    expect(result.confidence_scores.name).toBeGreaterThan(0);
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
// validateFields — recursion into nested array/object fields
// ---------------------------------------------------------------------------

describe("validateFields (nested depth)", () => {
  it("coerces numbers and resolves mappings inside array-of-objects items", () => {
    const extracted = {
      coverages: [
        { kind: "GL", limit: "$1,000,000", applies_to: "EE Theft" },
        { kind: "Property", limit: "2,500", applies_to: "forgery" },
      ],
    };
    const fields = {
      coverages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            limit: { type: "number" },
            applies_to: {
              type: "mapping",
              mappings: { employee_theft: ["EE Theft", "employee theft"], forgery: [] },
            },
          },
        },
      },
    };

    validateFields(extracted, fields);

    expect(extracted.coverages[0]!.limit).toBe(1000000);
    expect(extracted.coverages[0]!.applies_to).toBe("employee_theft");
    expect(extracted.coverages[1]!.limit).toBe(2500);
    expect(extracted.coverages[1]!.applies_to).toBe("forgery");
  });

  it("folds case and whitespace when matching a mapping alias", () => {
    const fields = {
      applies_to: {
        type: "mapping",
        mappings: {
          each_occurrence: ["Each Occurrence"],
          general_aggregate: ["General Aggregate"],
        },
      },
    };
    for (const raw of ["each occurrence", "EACH OCCURRENCE", "  each   occurrence ", "Each\nOccurrence"]) {
      const extracted: Record<string, unknown> = { applies_to: raw };
      validateFields(extracted, fields);
      expect(extracted.applies_to).toBe("each_occurrence");
    }
  });

  it("folds case/whitespace for enum options too", () => {
    const fields = { status: { type: "enum", options: ["in_force"] } };
    const extracted: Record<string, unknown> = { status: "  IN_FORCE " };
    validateFields(extracted, fields);
    expect(extracted.status).toBe("in_force");
  });

  it("keeps a value that is itself a canonical code (does not chase a colliding alias)", () => {
    // Regression for the applies_to collision: `building` is a real code AND
    // `blanket_building` lists "Building" as an alias. A value equal to a
    // declared code must stay that code, not be rewritten to the aliasing one —
    // no whitespace/case fix should change this. The dead alias is a schema bug,
    // not something the resolver silently "corrects".
    const fields = {
      applies_to: {
        type: "mapping",
        mappings: {
          building: ["Building Limit", "Building Coverage"],
          blanket_building: ["Blanket Building", "Building"],
        },
      },
    };
    const extracted: Record<string, unknown> = { applies_to: "building" };
    validateFields(extracted, fields);
    expect(extracted.applies_to).toBe("building");
  });

  it("recurses two levels deep (coverages[] -> limits[])", () => {
    const extracted = {
      coverages: [
        { limits: [{ applies_to: "Each Occ", premium: "1,000" }] },
      ],
    };
    const fields = {
      coverages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            limits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  applies_to: { type: "mapping", mappings: { each_occurrence: ["Each Occ"] } },
                  premium: { type: "number" },
                },
              },
            },
          },
        },
      },
    };

    validateFields(extracted, fields);

    expect(extracted.coverages[0]!.limits[0]!.applies_to).toBe("each_occurrence");
    expect(extracted.coverages[0]!.limits[0]!.premium).toBe(1000);
  });

  it("coerces fields inside a nested object", () => {
    const extracted = { totals: { amount: "$42" } };
    const fields = {
      totals: { type: "object", properties: { amount: { type: "number" } } },
    };

    validateFields(extracted, fields);

    expect(extracted.totals.amount).toBe(42);
  });

  it("coerces inside a nested object declared with the 'fields' alias", () => {
    const extracted = { totals: { amount: "$42" } };
    const fields = {
      totals: { type: "object", fields: { amount: { type: "number" } } },
    };

    validateFields(extracted, fields as Record<string, Record<string, unknown>>);

    expect(extracted.totals.amount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// validateFields — conditional vocabulary (vocab_by)
// ---------------------------------------------------------------------------

describe("validateFields (conditional vocab)", () => {
  // applies_to's allowed codes depend on the row's `coverage`.
  const itemProps = {
    coverage: { type: "enum", options: ["crime", "general_liability"] },
    applies_to: {
      type: "mapping",
      vocab_by: {
        coverage: {
          crime: { mappings: { employee_theft: ["EE Theft"], forgery: [] } },
          general_liability: { mappings: { each_occurrence: ["Each Occ"], general_aggregate: [] } },
        },
      },
    },
  };
  const fields = {
    coverages: { type: "array", items: { type: "object", properties: itemProps } },
  };

  it("resolves each row against its own sibling value", () => {
    const extracted = {
      coverages: [
        { coverage: "crime", applies_to: "EE Theft" },
        { coverage: "general_liability", applies_to: "Each Occ" },
      ],
    };
    const issues = validateFields(extracted, fields);
    expect(issues).toEqual([]);
    expect(extracted.coverages[0]!.applies_to).toBe("employee_theft");
    expect(extracted.coverages[1]!.applies_to).toBe("each_occurrence");
  });

  it("flags a cross-branch pairing (crime row with a GL code)", () => {
    const extracted = {
      coverages: [{ coverage: "crime", applies_to: "Each Occ" }],
    };
    const issues = validateFields(extracted, fields);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("coverages[0].applies_to");
    expect(issues[0]!.message).toContain("coverage=\"crime\"");
  });

  it("flags when the sibling value matches no branch and there is no default", () => {
    const extracted = {
      coverages: [{ coverage: "general_liability", applies_to: "whatever" }],
    };
    // narrow the schema to a vocab_by with only a crime branch
    const narrow = {
      coverages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            coverage: { type: "string" },
            applies_to: { type: "mapping", vocab_by: { coverage: { crime: { mappings: { employee_theft: [] } } } } },
          },
        },
      },
    };
    const issues = validateFields(extracted, narrow);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("no conditional vocabulary branch");
    expect(extracted.coverages[0]!.applies_to).toBe("whatever"); // left as-is
  });

  it("uses vocab_default when no branch matches", () => {
    const extracted = { coverages: [{ coverage: "surety", applies_to: "MISC" }] };
    const withDefault = {
      coverages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            coverage: { type: "string" },
            applies_to: {
              type: "mapping",
              vocab_by: { coverage: { crime: { mappings: { employee_theft: [] } } } },
              vocab_default: { mappings: { misc: ["MISC"] } },
            },
          },
        },
      },
    };
    const issues = validateFields(extracted, withDefault);
    expect(issues).toEqual([]);
    expect(extracted.coverages[0]!.applies_to).toBe("misc");
  });

  it("works on top-level sibling fields too", () => {
    const extracted = { coverage: "crime", applies_to: "EE Theft" };
    const topFields = {
      coverage: { type: "string" },
      applies_to: { type: "mapping", vocab_by: { coverage: { crime: { mappings: { employee_theft: ["EE Theft"] } } } } },
    };
    const issues = validateFields(extracted, topFields);
    expect(issues).toEqual([]);
    expect(extracted.applies_to).toBe("employee_theft");
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

  it("emits a keep_raw companion with the verbatim alongside the canonical value", async () => {
    const markdown = "Coverage schedule: Each Occurrence limit 1,000,000";
    const provider = mockProvider(
      JSON.stringify({ coverages: [{ applies_to: "Each Occurrence" }] }),
    );
    const schema = {
      name: "coi",
      fields: {
        coverages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              applies_to: {
                type: "mapping",
                keep_raw: true,
                mappings: { each_occurrence: ["Each Occurrence"] },
              },
            },
          },
        },
      },
    };

    const result = await extractFields(markdown, schema, provider, "m");
    const row = (result.extracted.coverages as Array<Record<string, unknown>>)[0]!;
    expect(row.applies_to).toBe("each_occurrence");       // canonical
    expect(row.applies_to_raw).toBe("Each Occurrence");   // verbatim companion
  });

  it("keep_raw recovers the printed alias when the model returns the canonical code (array)", async () => {
    // Production shape: the model returns the canonical value (instructed to pick
    // from allowed values) plus per-item __source_text. The raw must still be the
    // document's printed alias, resolved via the field's effective vocabulary.
    const markdown = "Coverage schedule\nGeneral Liability — Each Occurrence: 1,000,000";
    const sourceText = "General Liability — Each Occurrence: 1,000,000";
    const itemProps = (applies: Record<string, unknown>) => ({
      name: "coi",
      fields: {
        coverages: { type: "array", items: { type: "object", properties: { coverage: { type: "string" }, applies_to: applies } } },
      },
    });

    // static mapping
    let result = await extractFields(
      markdown,
      itemProps({ type: "mapping", keep_raw: true, mappings: { each_occurrence: ["Each Occurrence"] } }),
      mockProvider(JSON.stringify({ coverages: [{ coverage: "general_liability", applies_to: "each_occurrence", __source_text: sourceText }] })),
      "m",
    );
    let row = (result.extracted.coverages as Array<Record<string, unknown>>)[0]!;
    expect(row.applies_to).toBe("each_occurrence");
    expect(row.applies_to_raw).toBe("Each Occurrence");

    // vocab_by (no static mappings — effective vocab comes from the branch)
    result = await extractFields(
      markdown,
      itemProps({ type: "mapping", keep_raw: true, vocab_by: { coverage: { general_liability: { mappings: { each_occurrence: ["Each Occurrence"] } } } } }),
      mockProvider(JSON.stringify({ coverages: [{ coverage: "general_liability", applies_to: "each_occurrence", __source_text: sourceText }] })),
      "m",
    );
    row = (result.extracted.coverages as Array<Record<string, unknown>>)[0]!;
    expect(row.applies_to).toBe("each_occurrence");
    expect(row.applies_to_raw).toBe("Each Occurrence");
  });

  it("surfaces a conditional-vocabulary mismatch in the validation report", async () => {
    // crime row carrying a GL-only code → resolution against the crime branch
    // fails and the issue is reported.
    const provider = mockProvider(
      JSON.stringify({ coverages: [{ coverage: "crime", applies_to: "Each Occ" }] }),
    );
    const schema = {
      name: "coi",
      fields: {
        coverages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              coverage: { type: "string" },
              applies_to: {
                type: "mapping",
                vocab_by: {
                  coverage: {
                    crime: { mappings: { employee_theft: ["EE Theft"] } },
                    general_liability: { mappings: { each_occurrence: ["Each Occ"] } },
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = await extractFields("doc", schema, provider, "m");
    expect(result.validation!.ok).toBe(false);
    expect(result.validation!.issues.some((i) => i.rule === "conditional_vocab")).toBe(true);
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

    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
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

// ---------------------------------------------------------------------------
// extractLlmReasoning
// ---------------------------------------------------------------------------

describe("extractLlmReasoning", () => {
  it("extracts reasoning map and removes it from parsed object", () => {
    const parsed: Record<string, unknown> = {
      name: "Acme",
      __reasoning: {
        name: "Found 'Acme' on the first page header",
      },
    };

    const reasoning = extractLlmReasoning(parsed);

    expect(reasoning.name).toBe("Found 'Acme' on the first page header");
    expect(parsed.__reasoning).toBeUndefined();
  });

  it("returns empty object when __reasoning is missing", () => {
    const parsed: Record<string, unknown> = { name: "Acme" };
    const reasoning = extractLlmReasoning(parsed);

    expect(Object.keys(reasoning)).toHaveLength(0);
  });

  it("ignores non-string reasoning values", () => {
    const parsed: Record<string, unknown> = {
      __reasoning: { name: "valid", age: 42, active: true },
    };

    const reasoning = extractLlmReasoning(parsed);

    expect(reasoning.name).toBe("valid");
    expect(reasoning.age).toBeUndefined();
    expect(reasoning.active).toBeUndefined();
  });

  it("returns empty object when __reasoning is null", () => {
    const parsed: Record<string, unknown> = { __reasoning: null };
    const reasoning = extractLlmReasoning(parsed);

    expect(Object.keys(reasoning)).toHaveLength(0);
  });

  it("returns empty object when __reasoning is an array", () => {
    const parsed: Record<string, unknown> = { __reasoning: ["not", "valid"] };
    const reasoning = extractLlmReasoning(parsed);

    expect(Object.keys(reasoning)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractSourceTexts
// ---------------------------------------------------------------------------

describe("extractSourceTexts", () => {
  it("extracts __source_text from array-of-objects items", () => {
    const parsed: Record<string, unknown> = {
      items: [
        { name: "Widget", qty: 2, __source_text: "Widget  2 pcs" },
        { name: "Gadget", qty: 5, __source_text: "Gadget  5 pcs" },
      ],
      total: 100,
    };

    const texts = extractSourceTexts(parsed);

    expect(texts).toEqual({ items: ["Widget  2 pcs", "Gadget  5 pcs"] });
    // __source_text stripped from items
    const items = parsed.items as Record<string, unknown>[];
    expect(items[0]).not.toHaveProperty("__source_text");
    expect(items[1]).not.toHaveProperty("__source_text");
    // other fields untouched
    expect(parsed.total).toBe(100);
  });

  it("returns empty object when no arrays have source texts", () => {
    const parsed: Record<string, unknown> = {
      items: [{ name: "Widget" }],
      total: 100,
    };

    const texts = extractSourceTexts(parsed);
    expect(texts).toEqual({});
  });

  it("handles mixed items with and without source texts", () => {
    const parsed: Record<string, unknown> = {
      items: [
        { name: "A", __source_text: "Line A" },
        { name: "B" },
        { name: "C", __source_text: "Line C" },
      ],
    };

    const texts = extractSourceTexts(parsed);
    expect(texts).toEqual({ items: ["Line A", "", "Line C"] });
  });

  it("skips non-array fields", () => {
    const parsed: Record<string, unknown> = {
      name: "test",
      count: 5,
    };

    const texts = extractSourceTexts(parsed);
    expect(texts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractFields — __source_text integration
// ---------------------------------------------------------------------------

describe("extractFields __source_text integration", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("strips __source_text from extracted array items and includes source_texts in result", async () => {
    const provider = mockProvider(
      JSON.stringify({
        line_items: [
          { desc: "Widget", qty: 2, __source_text: "Widget  2 pcs  $10" },
          { desc: "Gadget", qty: 5, __source_text: "Gadget  5 pcs  $25" },
        ],
      }),
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

    const result = await extractFields(
      "Widget  2 pcs  $10\nGadget  5 pcs  $25",
      schema,
      provider,
      "gpt-4o",
    );

    // __source_text stripped from extracted items
    const items = result.extracted.line_items as Record<string, unknown>[];
    expect(items[0]).not.toHaveProperty("__source_text");
    expect(items[1]).not.toHaveProperty("__source_text");

    // source_texts collected from array items
    expect(result.source_texts).toEqual({
      line_items: ["Widget  2 pcs  $10", "Gadget  5 pcs  $25"],
    });
  });

  it("omits source_texts from result when no arrays have them", async () => {
    const provider = mockProvider(
      JSON.stringify({ name: "Acme Corp" }),
    );

    const schema = {
      name: "company",
      fields: {
        name: { type: "string" },
      },
    };

    const result = await extractFields("Acme Corp", schema, provider, "gpt-4o");
    expect(result.source_texts).toBeUndefined();
  });

  it("includes __source_text instruction in the prompt for array-of-objects", async () => {
    const provider = mockProvider(
      JSON.stringify({ items: [] }),
    );

    const schema = {
      name: "test",
      fields: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      },
    };

    await extractFields("doc", schema, provider, "m");
    const prompt = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(prompt).toContain("__source_text");
  });
});
