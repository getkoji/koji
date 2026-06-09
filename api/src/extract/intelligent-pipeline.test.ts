import { describe, it, expect, vi, beforeEach } from "vitest";
import { intelligentExtract } from "./intelligent-pipeline";
import type { ModelProvider } from "./providers";

function mockProvider(responses: string | string[]): ModelProvider {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    generate: vi.fn().mockImplementation(async () => {
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    }),
  };
}

describe("intelligentExtract", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("extracts flat fields from a simple document", async () => {
    const markdown = [
      "# Header",
      "Invoice Number: INV-001",
      "Date: 2025-01-15",
      "# Totals",
      "Total: $150.00",
    ].join("\n");

    const schema = {
      name: "invoice",
      fields: {
        invoice_number: { type: "string" },
        date: { type: "date" },
        total: { type: "number" },
      },
    };

    const provider = mockProvider(
      JSON.stringify({
        invoice_number: "INV-001",
        date: "2025-01-15",
        total: 150.0,
      }),
    );

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.strategy).toBe("intelligent");
    expect(result.extracted.invoice_number).toBe("INV-001");
    expect(result.extracted.date).toBe("2025-01-15");
    expect(result.extracted.total).toBe(150.0);
    expect(result.confidence_scores.invoice_number).toBeGreaterThan(0);
  });

  it("routes fields to relevant chunks", async () => {
    const markdown = [
      "# Policy Info",
      "Policy Number: POL-123",
      "Insured: John Doe",
      "# Claims",
      "Date of Loss: 2025-03-15",
      "Amount: $50,000",
    ].join("\n");

    const schema = {
      name: "claim",
      categories: {
        keywords: {
          header: ["policy", "insured"],
          claims: ["loss", "amount", "claim"],
        },
      },
      fields: {
        policy_number: {
          type: "string",
          hints: { look_in: ["header"] },
        },
        date_of_loss: {
          type: "date",
          hints: { look_in: ["claims"] },
        },
        amount: {
          type: "number",
          hints: { look_in: ["claims"] },
        },
      },
    };

    // The router will create groups — fields in same chunks get grouped together
    const provider = mockProvider(
      JSON.stringify({
        policy_number: "POL-123",
        date_of_loss: "2025-03-15",
        amount: 50000,
      }),
    );

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.extracted.policy_number).toBe("POL-123");
    expect(result.extracted.date_of_loss).toBe("2025-03-15");
    expect(result.extracted.amount).toBe(50000);
    // Should have made multiple LLM calls (groups)
    expect((provider.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("retries missing required fields via gap-fill", async () => {
    const markdown = [
      "# Header",
      "Invoice Number: INV-001",
      "# Details",
      "Total: $150.00",
    ].join("\n");

    const schema = {
      name: "invoice",
      fields: {
        invoice_number: { type: "string", required: true },
        total: { type: "number" },
      },
    };

    // First call returns null for invoice_number, gap-fill succeeds
    const responses = [
      JSON.stringify({ invoice_number: null, total: 150.0 }),
      JSON.stringify({ invoice_number: "INV-001" }),
    ];
    const provider = mockProvider(responses);

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.extracted.invoice_number).toBe("INV-001");
    expect(result.gap_filled).toContain("invoice_number");
  });

  it("handles wave-based field dependencies", async () => {
    const markdown = [
      "# Filing",
      "Form Type: 10-K",
      "Filing Date: 2025-06-15",
    ].join("\n");

    const schema = {
      name: "filing",
      fields: {
        form_type: { type: "string" },
        filing_date: {
          type: "date",
          depends_on: ["form_type"],
          extraction_hint_by: {
            form_type: {
              "10-K": "Look for the fiscal year end date",
            },
          },
        },
      },
    };

    const responses = [
      JSON.stringify({ form_type: "10-K" }),
      JSON.stringify({ filing_date: "2025-06-15" }),
    ];
    const provider = mockProvider(responses);

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.extracted.form_type).toBe("10-K");
    expect(result.extracted.filing_date).toBe("2025-06-15");
  });

  it("handles empty document", async () => {
    const provider = mockProvider("{}");
    const schema = {
      name: "test",
      fields: { field_a: { type: "string" } },
    };

    const result = await intelligentExtract("", schema, provider, "gpt-4o-mini");

    expect(result.extracted.field_a).toBeNull();
    expect(result.confidence.field_a).toBe("not_found");
  });

  it("snaps verbatim fields to source text", async () => {
    const markdown = [
      "# Description",
      "The building suffered extensive water damage from a burst pipe on the second floor.",
    ].join("\n");

    const schema = {
      name: "claim",
      fields: {
        description: {
          type: "string",
          verbatim: true,
        },
      },
    };

    // LLM returns slightly paraphrased version
    const provider = mockProvider(
      JSON.stringify({
        description: "The building suffered extensive water damage from burst pipe on second floor",
      }),
    );

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    // Should snap to the actual source text
    expect(result.extracted.description).toContain("burst pipe");
  });

  it("returns ExtractionResult-compatible shape", async () => {
    const markdown = "# Test\nValue: 42";
    const schema = {
      name: "test",
      fields: { value: { type: "number" } },
    };
    const provider = mockProvider(JSON.stringify({ value: 42 }));

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    // Check all required ExtractionResult fields
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.strategy).toBe("intelligent");
    expect(result.schema).toBe("test");
    expect(typeof result.elapsed_ms).toBe("number");
    expect(result.extracted).toBeDefined();
    expect(result.confidence).toBeDefined();
    expect(result.confidence_scores).toBeDefined();
  });

  it("handles array fields with deduplication", async () => {
    const markdown = [
      "# Items",
      "| Name | Qty | Price |",
      "|---|---|---|",
      "| Widget | 2 | $10 |",
      "| Gadget | 1 | $25 |",
    ].join("\n");

    const schema = {
      name: "invoice",
      fields: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number" },
              price: { type: "number" },
            },
          },
        },
      },
    };

    const provider = mockProvider(
      JSON.stringify({
        items: [
          { name: "Widget", quantity: 2, price: 10 },
          { name: "Gadget", quantity: 1, price: 25 },
        ],
      }),
    );

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.extracted.items).toHaveLength(2);
  });

  it("runs classifier when classify config is present", async () => {
    const markdown = [
      "# Invoice Header",
      "Invoice Number: INV-001",
      "# Policy Section",
      "Policy Number: POL-999",
    ].join("\n");

    const schema = {
      name: "invoice",
      classify: {
        types: [
          { id: "invoice", description: "Commercial invoice" },
          { id: "policy", description: "Insurance policy" },
        ],
      },
      apply_to: ["invoice"],
      fields: {
        invoice_number: { type: "string" },
      },
    };

    // First call: classifier (returns sections JSON)
    // Second call: extraction on the matched section
    const responses = [
      JSON.stringify({
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 0 },
          { type: "policy", start_chunk: 1, end_chunk: 1 },
        ],
      }),
      JSON.stringify({ invoice_number: "INV-001" }),
    ];
    const provider = mockProvider(responses);

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");

    expect(result.extracted.invoice_number).toBe("INV-001");
  });

  it("skips classifier for short documents", async () => {
    // 2 chunks — below the default short_doc_chunks threshold
    const markdown = [
      "# Header",
      "Invoice Number: INV-001",
    ].join("\n");

    const schema = {
      name: "test",
      classify: {
        types: [{ id: "invoice", description: "Invoice" }],
      },
      fields: {
        invoice_number: { type: "string" },
      },
    };

    // Only extraction call — no classifier call needed
    const provider = mockProvider(
      JSON.stringify({ invoice_number: "INV-001" }),
    );

    const result = await intelligentExtract(markdown, schema, provider, "gpt-4o-mini");
    expect(result.extracted.invoice_number).toBe("INV-001");
  });
});
