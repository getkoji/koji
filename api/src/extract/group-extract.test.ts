import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Chunk } from "./document-map";
import type { RouteGroup } from "./router";
import type { ModelProvider } from "./providers";
import {
  describeArrayItem,
  describeProperty,
  collectExtractionNotes,
  renderContextChunks,
  buildGroupPrompt,
  buildGapFillPrompt,
  unwrapNestedResult,
  extractLlmConfidence,
  extractSourceTexts,
  extractGroup,
  fillGap,
} from "./group-extract";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(response: string): ModelProvider {
  return { generate: vi.fn().mockResolvedValue(response) };
}

function makeChunk(overrides: Partial<Chunk> & { index: number; title: string; content: string }): Chunk {
  return { category: "other", signals: {}, ...overrides };
}

function makeGroup(overrides: Partial<RouteGroup>): RouteGroup {
  return {
    fields: Object.keys(overrides.fieldSpecs ?? {}),
    fieldSpecs: {},
    chunks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describeArrayItem
// ---------------------------------------------------------------------------

describe("describeArrayItem", () => {
  it("renders object with properties", () => {
    const spec = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "number" },
        },
      },
    };
    const result = describeArrayItem(spec);
    expect(result).toContain("objects with properties");
    expect(result).toContain("name: string");
    expect(result).toContain("qty: number");
    expect(result).toContain("__source_text");
  });

  it("renders nested arrays recursively", () => {
    const spec = {
      type: "array",
      items: {
        type: "array",
        items: { type: "string" },
      },
    };
    const result = describeArrayItem(spec);
    expect(result).toBe(" of arrays of string");
  });

  it("renders simple item types", () => {
    const spec = { type: "array", items: { type: "number" } };
    expect(describeArrayItem(spec)).toBe(" of number");
  });

  it("returns empty string for missing items spec", () => {
    expect(describeArrayItem({ type: "array" })).toBe("");
  });

  it("returns ' of objects' for object with no properties", () => {
    const spec = { type: "array", items: { type: "object" } };
    expect(describeArrayItem(spec)).toBe(" of objects");
  });
});

// ---------------------------------------------------------------------------
// describeProperty
// ---------------------------------------------------------------------------

describe("describeProperty", () => {
  it("renders nested object with properties", () => {
    const result = describeProperty("address", {
      type: "object",
      properties: { street: { type: "string" }, zip: { type: "string" } },
    });
    expect(result).toContain("address: object with properties");
    expect(result).toContain("street: string");
    expect(result).toContain("zip: string");
  });

  it("renders array property with recursive shape", () => {
    const result = describeProperty("items", {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(result).toContain("items: array");
    expect(result).toContain("name: string");
  });

  it("falls back to string for non-dict spec", () => {
    expect(describeProperty("foo", "not a dict")).toBe("foo: string");
  });
});

// ---------------------------------------------------------------------------
// collectExtractionNotes
// ---------------------------------------------------------------------------

describe("collectExtractionNotes", () => {
  it("collects hints from fields", () => {
    const fields = {
      date: { type: "date", extraction_hint: "Look for the effective date" },
      name: { type: "string" },
    };
    const result = collectExtractionNotes(fields);
    expect(result).toContain("**date**");
    expect(result).toContain("Look for the effective date");
  });

  it("returns empty string when no hints", () => {
    const fields = { a: { type: "string" }, b: { type: "number" } };
    expect(collectExtractionNotes(fields)).toBe("");
  });

  it("skips empty/whitespace hints", () => {
    const fields = { a: { type: "string", extraction_hint: "   " } };
    expect(collectExtractionNotes(fields)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderContextChunks
// ---------------------------------------------------------------------------

describe("renderContextChunks", () => {
  it("renders context chunks not in routed set", () => {
    const ctx = [
      makeChunk({ index: 0, title: "Header", content: "Doc header" }),
      makeChunk({ index: 1, title: "Intro", content: "Doc intro" }),
    ];
    const routed = [makeChunk({ index: 2, title: "Body", content: "Body" })];
    const result = renderContextChunks(ctx, routed);
    expect(result).toContain("## Document context");
    expect(result).toContain("### Header");
    expect(result).toContain("### Intro");
  });

  it("skips chunks already in routed set (by index)", () => {
    const ctx = [
      makeChunk({ index: 0, title: "Header", content: "Doc header" }),
      makeChunk({ index: 1, title: "Intro", content: "Doc intro" }),
    ];
    const routed = [makeChunk({ index: 0, title: "Header", content: "Doc header" })];
    const result = renderContextChunks(ctx, routed);
    expect(result).not.toContain("### Header");
    expect(result).toContain("### Intro");
  });

  it("returns empty string when all context chunks are already routed", () => {
    const ctx = [makeChunk({ index: 0, title: "Header", content: "Doc header" })];
    const routed = [makeChunk({ index: 0, title: "Header", content: "Doc header" })];
    expect(renderContextChunks(ctx, routed)).toBe("");
  });

  it("returns empty string for null/empty context", () => {
    expect(renderContextChunks(null, [])).toBe("");
    expect(renderContextChunks([], [])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildGroupPrompt
// ---------------------------------------------------------------------------

describe("buildGroupPrompt", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("includes field descriptions with types and required labels", () => {
    const group = makeGroup({
      fieldSpecs: {
        name: { type: "string", required: true, description: "Full name" },
        age: { type: "number" },
      },
      chunks: [makeChunk({ index: 0, title: "Bio", content: "John age 30" })],
    });
    const prompt = buildGroupPrompt(group, "person");
    expect(prompt).toContain("name: string (REQUIRED)");
    expect(prompt).toContain("Full name");
    expect(prompt).toContain("age: number");
  });

  it("renders array shape in field descriptions", () => {
    const group = makeGroup({
      fieldSpecs: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { desc: { type: "string" }, qty: { type: "number" } },
          },
        },
      },
      chunks: [makeChunk({ index: 0, title: "Table", content: "Widget 2" })],
    });
    const prompt = buildGroupPrompt(group, "invoice");
    expect(prompt).toContain("array");
    expect(prompt).toContain("desc: string");
    expect(prompt).toContain("qty: number");
  });

  it("renders options as pick-from list", () => {
    const group = makeGroup({
      fieldSpecs: {
        status: { type: "enum", options: ["active", "inactive"] },
      },
      chunks: [makeChunk({ index: 0, title: "S", content: "status active" })],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).toContain("[pick from: active, inactive]");
  });

  it("renders mappings as pick-from with aliases", () => {
    const group = makeGroup({
      fieldSpecs: {
        doc_type: {
          type: "mapping",
          mappings: {
            invoice: ["inv", "bill"],
            receipt: ["rcpt"],
          },
        },
      },
      chunks: [makeChunk({ index: 0, title: "D", content: "doc type inv" })],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).toContain("[pick from:");
    expect(prompt).toContain("invoice (inv, bill)");
    expect(prompt).toContain("receipt (rcpt)");
  });

  it("includes extraction notes section when hints exist", () => {
    const group = makeGroup({
      fieldSpecs: {
        date: { type: "date", extraction_hint: "Use the effective date" },
      },
      chunks: [makeChunk({ index: 0, title: "D", content: "2025-01-01" })],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).toContain("## Extraction notes");
    expect(prompt).toContain("Use the effective date");
  });

  it("filters lines matching exclude_contains patterns", () => {
    const group = makeGroup({
      fieldSpecs: {
        total: {
          type: "number",
          hints: { exclude_contains: ["copyright"] },
        },
      },
      chunks: [
        makeChunk({
          index: 0,
          title: "Footer",
          content: "Total: $100\nCopyright 2025 Acme Corp\nTax: $10",
        }),
      ],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).toContain("Total: $100");
    expect(prompt).toContain("Tax: $10");
    expect(prompt).not.toContain("Copyright 2025 Acme Corp");
  });

  it("exclude_contains is case-insensitive", () => {
    const group = makeGroup({
      fieldSpecs: {
        total: {
          type: "number",
          hints: { exclude_contains: ["COPYRIGHT"] },
        },
      },
      chunks: [
        makeChunk({
          index: 0,
          title: "F",
          content: "Total: $100\ncopyright notice here",
        }),
      ],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).not.toContain("copyright notice here");
  });

  it("includes context chunks section (skips duplicates)", () => {
    const ctxChunks = [
      makeChunk({ index: 0, title: "Header", content: "Doc header" }),
      makeChunk({ index: 1, title: "Intro", content: "Doc intro" }),
    ];
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "Header", content: "Doc header" })],
    });
    const prompt = buildGroupPrompt(group, "test", ctxChunks);
    expect(prompt).toContain("## Document context");
    expect(prompt).toContain("### Intro");
    // Header is already in the group's chunks, so should NOT appear in context
    // Count occurrences of "### Header" — should appear only once (in document sections)
    const headerMatches = prompt.match(/### Header/g);
    expect(headerMatches?.length).toBe(1);
  });

  it("adds date_locale instruction from schema config", () => {
    const group = makeGroup({
      fieldSpecs: { date: { type: "date" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "01/02/2025" })],
    });
    const prompt = buildGroupPrompt(group, "test", undefined, {
      date_locale: "DD/MM/YYYY",
    });
    expect(prompt).toContain("DD/MM/YYYY");
  });

  it("adds default_currency instruction from schema config", () => {
    const group = makeGroup({
      fieldSpecs: { amount: { type: "number" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "100" })],
    });
    const prompt = buildGroupPrompt(group, "test", undefined, {
      default_currency: "CAD",
    });
    expect(prompt).toContain("CAD");
  });

  it("adds blank_form_aware instruction from schema config", () => {
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "____" })],
    });
    const prompt = buildGroupPrompt(group, "test", undefined, {
      blank_form_aware: true,
    });
    expect(prompt).toContain("BLANK unfilled form");
  });

  it("reads locale from nested locale.fallback config", () => {
    const group = makeGroup({
      fieldSpecs: { date: { type: "date" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "01/02/2025" })],
    });
    const prompt = buildGroupPrompt(group, "test", undefined, {
      locale: { fallback: { date_format: "MM/DD/YYYY", currency: "USD" } },
    });
    expect(prompt).toContain("MM/DD/YYYY");
    expect(prompt).toContain("USD");
  });

  it("includes FLAT JSON instruction with schema name warning", () => {
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "test" })],
    });
    const prompt = buildGroupPrompt(group, "my_schema");
    expect(prompt).toContain("FLAT JSON");
    expect(prompt).toContain('"my_schema"');
  });

  it("renders chunk content with titles and separators", () => {
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [
        makeChunk({ index: 0, title: "Page 1", content: "First page" }),
        makeChunk({ index: 1, title: "Page 2", content: "Second page" }),
      ],
    });
    const prompt = buildGroupPrompt(group, "test");
    expect(prompt).toContain("### Page 1");
    expect(prompt).toContain("First page");
    expect(prompt).toContain("---");
    expect(prompt).toContain("### Page 2");
    expect(prompt).toContain("Second page");
  });
});

// ---------------------------------------------------------------------------
// buildGapFillPrompt
// ---------------------------------------------------------------------------

describe("buildGapFillPrompt", () => {
  it("includes the single field name and type", () => {
    const chunks = [makeChunk({ index: 0, title: "Doc", content: "some text" })];
    const prompt = buildGapFillPrompt(
      "filing_date",
      { type: "date", required: true, description: "The filing date" },
      chunks,
      "metadata",
    );
    expect(prompt).toContain("filing_date");
    expect(prompt).toContain("date");
    expect(prompt).toContain("(REQUIRED)");
    expect(prompt).toContain("The filing date");
  });

  it("includes extraction notes when field has hint", () => {
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];
    const prompt = buildGapFillPrompt(
      "amount",
      { type: "number", extraction_hint: "Look in the totals section" },
      chunks,
      "invoice",
    );
    expect(prompt).toContain("## Extraction notes");
    expect(prompt).toContain("Look in the totals section");
  });

  it("includes context chunks section", () => {
    const chunks = [makeChunk({ index: 2, title: "Body", content: "body text" })];
    const ctxChunks = [makeChunk({ index: 0, title: "Header", content: "header" })];
    const prompt = buildGapFillPrompt(
      "name",
      { type: "string" },
      chunks,
      "test",
      ctxChunks,
    );
    expect(prompt).toContain("## Document context");
    expect(prompt).toContain("### Header");
  });

  it("renders options/mappings for gap fill field", () => {
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];
    const prompt = buildGapFillPrompt(
      "status",
      { type: "enum", options: ["active", "inactive"] },
      chunks,
      "test",
    );
    expect(prompt).toContain("[pick from: active, inactive]");
  });

  it("includes null fallback instruction with field name", () => {
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];
    const prompt = buildGapFillPrompt("name", { type: "string" }, chunks, "test");
    expect(prompt).toContain('"name": null');
  });

  it("includes FLAT JSON instruction with schema name warning", () => {
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];
    const prompt = buildGapFillPrompt("name", { type: "string" }, chunks, "my_schema");
    expect(prompt).toContain("FLAT JSON");
    expect(prompt).toContain('"my_schema"');
  });
});

// ---------------------------------------------------------------------------
// unwrapNestedResult
// ---------------------------------------------------------------------------

describe("unwrapNestedResult", () => {
  it("passes through already-flat results", () => {
    const result = { name: "Acme", date: "2025-01-01" };
    const expected = new Set(["name", "date"]);
    expect(unwrapNestedResult(result, expected)).toEqual(result);
  });

  it("unwraps result nested under schema name", () => {
    const result = { invoice: { name: "Acme", total: 100 } };
    const expected = new Set(["name", "total"]);
    const unwrapped = unwrapNestedResult(result, expected);
    expect(unwrapped).toEqual({ name: "Acme", total: 100 });
  });

  it("passes through when multiple nested dicts match", () => {
    const result = {
      a: { name: "X" },
      b: { name: "Y" },
    };
    const expected = new Set(["name"]);
    expect(unwrapNestedResult(result, expected)).toEqual(result);
  });

  it("passes through when no expected fields (empty set)", () => {
    const result = { wrapper: { name: "Acme" } };
    expect(unwrapNestedResult(result, new Set())).toEqual(result);
  });

  it("passes through null/empty/non-dict input", () => {
    expect(unwrapNestedResult({}, new Set(["a"]))).toEqual({});
    expect(unwrapNestedResult(null as any, new Set(["a"]))).toEqual(null);
  });
});

// ---------------------------------------------------------------------------
// extractLlmConfidence
// ---------------------------------------------------------------------------

describe("extractLlmConfidence (compat shim, always empty)", () => {
  // The LLM's self-emitted __confidence is now stripped at parse time
  // (see parseJsonResponse) and the deterministic scorer in
  // extract/field-confidence.ts replaces it. extractLlmConfidence is
  // retained as a no-op for backwards compatibility.
  it("always returns an empty dict (no LLM signal used for routing)", () => {
    const parsed: Record<string, unknown> = {
      name: "Acme",
      __confidence: { name: 0.95, date: 0.8 },
    };
    const conf = extractLlmConfidence(parsed, new Set(["name", "date"]));
    expect(conf).toEqual({});
  });

  it("defensively strips __confidence even when called directly", () => {
    const parsed: Record<string, unknown> = {
      name: "Acme",
      __confidence: { name: 0.95 },
    };
    extractLlmConfidence(parsed, new Set(["name"]));
    expect(parsed.__confidence).toBeUndefined();
  });

  it("returns empty dict regardless of input shape", () => {
    expect(extractLlmConfidence({ name: "Acme" }, new Set(["name"]))).toEqual({});
    expect(
      extractLlmConfidence(
        { __confidence: "not a dict" } as Record<string, unknown>,
        new Set(["name"]),
      ),
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractSourceTexts
// ---------------------------------------------------------------------------

describe("extractSourceTexts", () => {
  it("strips __source_text from array items and returns map", () => {
    const parsed: Record<string, unknown> = {
      items: [
        { name: "Widget", __source_text: "Widget line" },
        { name: "Gadget", __source_text: "Gadget line" },
      ],
      total: 100,
    };
    const texts = extractSourceTexts(parsed);
    expect(texts).toEqual({ items: ["Widget line", "Gadget line"] });
    const items = parsed.items as Record<string, unknown>[];
    expect(items[0]).not.toHaveProperty("__source_text");
    expect(items[1]).not.toHaveProperty("__source_text");
  });

  it("returns empty dict when no arrays have source texts", () => {
    const parsed: Record<string, unknown> = {
      items: [{ name: "Widget" }],
      total: 100,
    };
    expect(extractSourceTexts(parsed)).toEqual({});
  });

  it("handles mixed items with and without __source_text", () => {
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

  it("ignores non-array fields", () => {
    const parsed: Record<string, unknown> = { name: "test", count: 5 };
    expect(extractSourceTexts(parsed)).toEqual({});
  });

  it("handles non-dict array items gracefully", () => {
    const parsed: Record<string, unknown> = { tags: ["a", "b", "c"] };
    expect(extractSourceTexts(parsed)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// extractGroup (mocked provider)
// ---------------------------------------------------------------------------

describe("extractGroup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("extracts fields from successful JSON response", async () => {
    const provider = mockProvider(
      JSON.stringify({ name: "Acme Corp", total: 150 }),
    );
    const group = makeGroup({
      fieldSpecs: {
        name: { type: "string" },
        total: { type: "number" },
      },
      chunks: [makeChunk({ index: 0, title: "Doc", content: "Acme Corp total 150" })],
    });

    const result = await extractGroup(group, "invoice", provider);
    expect(result.name).toBe("Acme Corp");
    expect(result.total).toBe(150);
    expect(provider.generate).toHaveBeenCalledWith(expect.any(String), true);
  });

  it("handles JSON embedded in surrounding text (regex fallback)", async () => {
    const provider = mockProvider(
      'Here is the result:\n\n{"name": "Test Corp"}\n\nDone.',
    );
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "Test Corp" })],
    });

    const result = await extractGroup(group, "test", provider);
    expect(result.name).toBe("Test Corp");
  });

  it("returns empty dict on completely invalid JSON", async () => {
    const provider = mockProvider("This is not JSON at all");
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "text" })],
    });

    const result = await extractGroup(group, "test", provider);
    expect(result).toEqual({});
  });

  it("returns empty dict on provider error", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error("API timeout")),
    };
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "text" })],
    });

    const result = await extractGroup(group, "test", provider);
    expect(result).toEqual({});
  });

  it("unwraps nested result under schema name", async () => {
    const provider = mockProvider(
      JSON.stringify({ invoice: { name: "Acme", total: 100 } }),
    );
    const group = makeGroup({
      fieldSpecs: {
        name: { type: "string" },
        total: { type: "number" },
      },
      chunks: [makeChunk({ index: 0, title: "D", content: "text" })],
    });

    const result = await extractGroup(group, "invoice", provider);
    expect(result.name).toBe("Acme");
    expect(result.total).toBe(100);
  });

  it("strips __confidence at parse time (does not attach __llm_confidence)", async () => {
    const provider = mockProvider(
      JSON.stringify({
        name: "Acme",
        __confidence: { name: 0.95 },
      }),
    );
    const group = makeGroup({
      fieldSpecs: { name: { type: "string" } },
      chunks: [makeChunk({ index: 0, title: "D", content: "text" })],
    });

    const result = await extractGroup(group, "test", provider);
    expect(result.name).toBe("Acme");
    // LLM self-rated confidence is noise — stripped at parse and not surfaced.
    expect(result.__llm_confidence).toBeUndefined();
    expect(result.__confidence).toBeUndefined();
  });

  it("strips __source_text from array items", async () => {
    const provider = mockProvider(
      JSON.stringify({
        items: [
          { name: "A", __source_text: "Line A" },
          { name: "B", __source_text: "Line B" },
        ],
      }),
    );
    const group = makeGroup({
      fieldSpecs: {
        items: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" } } },
        },
      },
      chunks: [makeChunk({ index: 0, title: "D", content: "text" })],
    });

    const result = await extractGroup(group, "test", provider);
    const items = result.items as Record<string, unknown>[];
    expect(items[0]).not.toHaveProperty("__source_text");
    expect(items[1]).not.toHaveProperty("__source_text");
  });
});

// ---------------------------------------------------------------------------
// fillGap (mocked provider)
// ---------------------------------------------------------------------------

describe("fillGap", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("extracts a single field successfully", async () => {
    const provider = mockProvider(
      JSON.stringify({ filing_date: "2025-06-01" }),
    );
    const chunks = [makeChunk({ index: 0, title: "Doc", content: "Filed 2025-06-01" })];

    const result = await fillGap(
      "filing_date",
      { type: "date", required: true },
      chunks,
      "metadata",
      provider,
    );
    expect(result.filing_date).toBe("2025-06-01");
  });

  it("returns null field value when field is absent", async () => {
    const provider = mockProvider(JSON.stringify({ filing_date: null }));
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];

    const result = await fillGap(
      "filing_date",
      { type: "date" },
      chunks,
      "test",
      provider,
    );
    expect(result.filing_date).toBeNull();
  });

  it("returns empty dict on provider error", async () => {
    const provider: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];

    const result = await fillGap(
      "name",
      { type: "string" },
      chunks,
      "test",
      provider,
    );
    expect(result).toEqual({});
  });

  it("unwraps nested result for gap fill", async () => {
    const provider = mockProvider(
      JSON.stringify({ metadata: { filing_date: "2025-01-01" } }),
    );
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];

    const result = await fillGap(
      "filing_date",
      { type: "date" },
      chunks,
      "metadata",
      provider,
    );
    expect(result.filing_date).toBe("2025-01-01");
  });

  it("strips __confidence at parse time (does not attach __llm_confidence)", async () => {
    const provider = mockProvider(
      JSON.stringify({
        name: "Acme",
        __confidence: { name: 0.85 },
      }),
    );
    const chunks = [makeChunk({ index: 0, title: "D", content: "text" })];

    const result = await fillGap(
      "name",
      { type: "string" },
      chunks,
      "test",
      provider,
    );
    expect(result.__llm_confidence).toBeUndefined();
  });
});
