import { describe, it, expect, vi } from "vitest";
import {
  classifyStep,
  classifyByKeywords,
  classifyWithLLM,
  getDocumentText,
  applyScope,
  type ClassifyConfig,
  type ClassifyLabel,
} from "../steps/classify";
import type { StepContext, StepOutput } from "../steps/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    tenantId: "t-1",
    documentId: "doc-1",
    jobId: "job-1",
    document: {
      filename: "invoice.pdf",
      storageKey: "tenants/t-1/uploads/invoice.pdf",
      mimeType: "application/pdf",
      contentHash: "abc123",
    },
    stepOutputs: {},
    db: null,
    storage: null,
    endpoints: null,
    queue: null,
    ...overrides,
  };
}

function makeStepOutput(output: Record<string, unknown>): StepOutput {
  return {
    stepId: "prev-step",
    stepType: "extract",
    output,
    durationMs: 100,
    costUsd: 0,
  };
}

function makeConfig(overrides: Partial<ClassifyConfig> = {}): ClassifyConfig {
  return {
    question: "What type of document is this?",
    labels: [
      {
        id: "invoice",
        description: "An invoice or bill",
        keywords: ["invoice", "amount due", "bill to", "payment"],
      },
      {
        id: "contract",
        description: "A legal contract",
        keywords: ["agreement", "parties", "whereas", "obligations"],
      },
      {
        id: "other",
        description: "Anything else",
      },
    ],
    method: "keyword_then_llm",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyByKeywords
// ---------------------------------------------------------------------------

describe("classifyByKeywords", () => {
  const labels: ClassifyLabel[] = [
    { id: "invoice", keywords: ["invoice", "amount due", "bill to"] },
    { id: "contract", keywords: ["agreement", "parties", "whereas"] },
    { id: "other" },
  ];

  it("matches when 2+ keywords are found", () => {
    const text = "This is an invoice with an amount due of $500";
    expect(classifyByKeywords(text, labels)).toEqual({ label: "invoice" });
  });

  it("does not match on a single keyword hit", () => {
    const text = "This document mentions an invoice but nothing else relevant";
    expect(classifyByKeywords(text, labels)).toBeNull();
  });

  it("returns null when no labels have keywords", () => {
    const text = "Some random document text";
    expect(classifyByKeywords(text, [{ id: "a" }, { id: "b" }])).toBeNull();
  });

  it("is case insensitive", () => {
    const text = "INVOICE received. AMOUNT DUE is $100.";
    expect(classifyByKeywords(text, labels)).toEqual({ label: "invoice" });
  });

  it("returns the first matching label when multiple match", () => {
    const text =
      "This invoice agreement has amount due and parties involved and whereas";
    const result = classifyByKeywords(text, labels);
    // "invoice" comes first in the list, and it has 2+ hits
    expect(result).toEqual({ label: "invoice" });
  });

  it("skips labels with empty keywords array", () => {
    const labelsWithEmpty: ClassifyLabel[] = [
      { id: "empty", keywords: [] },
      { id: "invoice", keywords: ["invoice", "amount due"] },
    ];
    const text = "This invoice has an amount due";
    expect(classifyByKeywords(text, labelsWithEmpty)).toEqual({
      label: "invoice",
    });
  });
});

// ---------------------------------------------------------------------------
// classifyWithLLM
// ---------------------------------------------------------------------------

describe("classifyWithLLM", () => {
  const cfg = makeConfig({ method: "llm" });

  it("returns parsed label and confidence from model response", async () => {
    const ctx = makeCtx({
      endpoints: {
        call: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            label: "invoice",
            confidence: 0.95,
            reasoning: "Contains billing information",
          }),
        }),
      },
    });

    const result = await classifyWithLLM(ctx, "invoice text here", cfg);
    expect(result.label).toBe("invoice");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toBe("Contains billing information");
  });

  it("snaps to first label when model returns unknown label", async () => {
    const ctx = makeCtx({
      endpoints: {
        call: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            label: "nonexistent_category",
            confidence: 0.8,
          }),
        }),
      },
    });

    const result = await classifyWithLLM(ctx, "some text", cfg);
    expect(result.label).toBe("invoice"); // first label
    expect(result.reasoning).toContain("nonexistent_category");
  });

  it("handles model error gracefully", async () => {
    const ctx = makeCtx({
      endpoints: {
        call: vi.fn().mockRejectedValue(new Error("API timeout")),
      },
    });

    const result = await classifyWithLLM(ctx, "some text", cfg);
    expect(result.label).toBe("other"); // last label
    expect(result.confidence).toBe(0.3);
    expect(result.reasoning).toContain("API timeout");
  });

  it("returns default when no endpoint is configured", async () => {
    const ctx = makeCtx({ endpoints: null });

    const result = await classifyWithLLM(ctx, "some text", cfg);
    expect(result.label).toBe("invoice"); // first label
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain("No model endpoint configured");
  });

  it("defaults confidence to 0.8 when model omits it", async () => {
    const ctx = makeCtx({
      endpoints: {
        call: vi.fn().mockResolvedValue({
          content: JSON.stringify({ label: "contract" }),
        }),
      },
    });

    const result = await classifyWithLLM(ctx, "some text", cfg);
    expect(result.label).toBe("contract");
    expect(result.confidence).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// getDocumentText
// ---------------------------------------------------------------------------

describe("getDocumentText", () => {
  it("returns text from a previous step output", async () => {
    const ctx = makeCtx({
      stepOutputs: {
        ocr: makeStepOutput({ text: "Parsed document content from OCR step" }),
      },
    });

    const text = await getDocumentText(ctx);
    expect(text).toBe("Parsed document content from OCR step");
  });

  it("reads from storage when no step output has text", async () => {
    const ctx = makeCtx({
      storage: {
        get: vi.fn().mockResolvedValue("Text from storage"),
      },
    });

    const text = await getDocumentText(ctx);
    expect(text).toBe("Text from storage");
  });

  it("falls back to filename when storage returns binary", async () => {
    const ctx = makeCtx({
      storage: {
        get: vi.fn().mockResolvedValue(Buffer.from("binary")),
      },
    });

    const text = await getDocumentText(ctx);
    expect(text).toBe("invoice.pdf");
  });

  it("falls back to filename when storage throws", async () => {
    const ctx = makeCtx({
      storage: {
        get: vi.fn().mockRejectedValue(new Error("not found")),
      },
    });

    const text = await getDocumentText(ctx);
    expect(text).toBe("invoice.pdf");
  });

  it("falls back to filename when no storage is configured", async () => {
    const ctx = makeCtx({ storage: null });
    const text = await getDocumentText(ctx);
    expect(text).toBe("invoice.pdf");
  });
});

// ---------------------------------------------------------------------------
// applyScope
// ---------------------------------------------------------------------------

describe("applyScope", () => {
  const longText = "x".repeat(15000);

  it("returns full text when scope is undefined", () => {
    expect(applyScope(longText)).toBe(longText);
  });

  it("returns full text when scope is 'full'", () => {
    expect(applyScope(longText, "full")).toBe(longText);
  });

  it("truncates to N*3000 chars for first_n_pages(N)", () => {
    expect(applyScope(longText, "first_n_pages(3)").length).toBe(9000);
  });

  it("returns full text for unrecognized scope", () => {
    expect(applyScope(longText, "something_else")).toBe(longText);
  });
});

// ---------------------------------------------------------------------------
// classifyStep.run — integration of method selection
// ---------------------------------------------------------------------------

describe("classifyStep.run", () => {
  it("keyword method never calls LLM", async () => {
    const callFn = vi.fn();
    const ctx = makeCtx({
      stepOutputs: {
        parse: makeStepOutput({ text: "invoice with amount due here" }),
      },
      endpoints: { call: callFn },
    });

    const result = await classifyStep.run(ctx, makeConfig({ method: "keyword" }));
    expect(result.ok).toBe(true);
    expect(result.output.method).toBe("keyword");
    expect(result.output.label).toBe("invoice");
    expect(callFn).not.toHaveBeenCalled();
  });

  it("keyword method returns last label when no keywords match", async () => {
    const ctx = makeCtx({
      stepOutputs: {
        parse: makeStepOutput({ text: "nothing relevant whatsoever" }),
      },
    });

    const result = await classifyStep.run(ctx, makeConfig({ method: "keyword" }));
    expect(result.ok).toBe(true);
    expect(result.output.label).toBe("other"); // last label
    expect(result.output.confidence).toBe(0.5);
    expect(result.costUsd).toBe(0);
  });

  it("llm method always calls LLM, skips keywords", async () => {
    const callFn = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        label: "contract",
        confidence: 0.9,
        reasoning: "Legal language detected",
      }),
    });
    const ctx = makeCtx({
      stepOutputs: {
        parse: makeStepOutput({ text: "invoice with amount due — but use LLM" }),
      },
      endpoints: { call: callFn },
    });

    const result = await classifyStep.run(ctx, makeConfig({ method: "llm" }));
    expect(result.ok).toBe(true);
    expect(result.output.method).toBe("llm");
    expect(result.output.label).toBe("contract");
    expect(callFn).toHaveBeenCalledOnce();
    expect(result.costUsd).toBe(0.005);
  });

  it("keyword_then_llm tries keywords first, then LLM on miss", async () => {
    const callFn = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        label: "other",
        confidence: 0.7,
        reasoning: "No clear category",
      }),
    });
    const ctx = makeCtx({
      stepOutputs: {
        parse: makeStepOutput({ text: "ambiguous document text" }),
      },
      endpoints: { call: callFn },
    });

    const result = await classifyStep.run(
      ctx,
      makeConfig({ method: "keyword_then_llm" }),
    );
    // Keywords don't match → falls through to LLM
    expect(result.output.method).toBe("llm");
    expect(callFn).toHaveBeenCalledOnce();
  });

  it("keyword_then_llm returns keyword result when keywords match", async () => {
    const callFn = vi.fn();
    const ctx = makeCtx({
      stepOutputs: {
        parse: makeStepOutput({ text: "agreement between the parties herein" }),
      },
      endpoints: { call: callFn },
    });

    const result = await classifyStep.run(
      ctx,
      makeConfig({ method: "keyword_then_llm" }),
    );
    expect(result.output.method).toBe("keyword");
    expect(result.output.label).toBe("contract");
    expect(callFn).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(0);
  });
});
