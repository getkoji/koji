import { describe, it, expect, vi } from "vitest";
import { runCascade } from "./cascade";
import { normalizeConfig } from "./config";
import type { CascadeDeps } from "./cascade";
import type { GetPageTexts } from "./pdf-text";
import type { ModelProvider } from "../extract/providers";
import type { DocumentType } from "../parse/classify";

const input = { filename: "doc.pdf", mimeType: "application/pdf", fileBuffer: Buffer.from("x") };

/** Fake windowed-text extractor returning canned pages. */
function fakePages(pages: Array<{ page: number; text: string }>, totalPages?: number): GetPageTexts {
  return vi.fn(async () => ({ totalPages: totalPages ?? pages.length, pages }));
}

function fakeDocType(t: DocumentType) {
  return vi.fn(async () => t);
}

describe("runCascade", () => {
  it("Tier 2: short-circuits on a confident keyword match without calling the LLM", async () => {
    const generate = vi.fn();
    const deps: CascadeDeps = {
      getPageTexts: fakePages([
        { page: 1, text: "cover sheet please route" },
        { page: 2, text: "INVOICE amount due remit to Acme" },
      ]),
      classifyDocType: fakeDocType("digital_pdf"),
      provider: { generate } as unknown as ModelProvider,
    };
    const config = normalizeConfig({
      classes: {
        invoice: { keywords: ["invoice", "amount due", "remit to"] },
        policy: { keywords: ["declarations"] },
      },
    });

    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("invoice");
    expect(out.method).toBe("keyword");
    expect(out.tierUsed).toBe(2);
    expect(out.evidencePage).toBe(2); // ignored the cover sheet
    expect(generate).not.toHaveBeenCalled();
  });

  it("escalates an ambiguous keyword tie to the LLM tier", async () => {
    // Two classes each match one of their two keywords → 0.5 vs 0.5, no margin.
    const generate = vi.fn(async () =>
      JSON.stringify({ label: "policy", confidence: 0.8, evidence_page: 1 }),
    );
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "invoice declarations" }]),
      classifyDocType: fakeDocType("digital_pdf"),
      provider: { generate } as unknown as ModelProvider,
    };
    const config = normalizeConfig({
      classes: {
        invoice: { keywords: ["invoice", "amount due"] },
        policy: { keywords: ["declarations", "insuring agreement"] },
      },
    });

    const out = await runCascade(input, config, deps);
    expect(generate).toHaveBeenCalledOnce();
    expect(out.label).toBe("policy");
    expect(out.method).toBe("llm");
    expect(out.tierUsed).toBe(3);
  });

  it("honors max_tier as a hard ceiling (no LLM even when a provider is present)", async () => {
    const generate = vi.fn();
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "invoice declarations" }]),
      classifyDocType: fakeDocType("digital_pdf"),
      provider: { generate } as unknown as ModelProvider,
    };
    const config = normalizeConfig({
      classify: { max_tier: 2 },
      classes: {
        invoice: { keywords: ["invoice", "amount due"] },
        policy: { keywords: ["declarations", "insuring agreement"] },
      },
    });

    const out = await runCascade(input, config, deps);
    expect(generate).not.toHaveBeenCalled();
    expect(out.label).toBe("unknown");
    expect(out.tierUsed).toBe(2); // reached keyword, ceiling stopped there
  });

  it("Tier 4: falls through to vision for a scanned doc with no text layer", async () => {
    const generate = vi.fn();
    const generateWithImage = vi.fn(async () =>
      JSON.stringify({ label: "policy", confidence: 0.7, evidence_page: 1 }),
    );
    const renderPageImages = vi.fn(async () => ["base64img"]);
    const deps: CascadeDeps = {
      // scanned: window pages come back with empty text
      getPageTexts: fakePages([{ page: 1, text: "" }], 1),
      classifyDocType: fakeDocType("scanned_pdf"),
      provider: { generate, generateWithImage } as unknown as ModelProvider,
      renderPageImages,
    };
    const config = normalizeConfig({ classes: { policy: { keywords: ["declarations"] } } });

    const out = await runCascade(input, config, deps);
    expect(generate).not.toHaveBeenCalled(); // no text → text-LLM tier skipped
    expect(renderPageImages).toHaveBeenCalledOnce();
    expect(generateWithImage).toHaveBeenCalledOnce();
    expect(out.label).toBe("policy");
    expect(out.method).toBe("vision");
    expect(out.tierUsed).toBe(4);
  });

  it("returns unknown when the vision tier is unavailable and text tiers fail", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "" }], 1),
      classifyDocType: fakeDocType("scanned_pdf"),
      // no provider / renderer
    };
    const config = normalizeConfig({ classes: { policy: { keywords: ["declarations"] } } });
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("unknown");
    expect(out.method).toBe("unknown");
  });

  // oss-489: an `unknown` from a text-less PDF that never reached the vision
  // tier is a different failure from one the model looked at and couldn't
  // label. The outcome has to say which.
  it("explains WHY it could not decide — no renderer for the vision tier", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "" }], 1),
      classifyDocType: fakeDocType("scanned_pdf"),
      provider: {
        generate: vi.fn(),
        generateWithImage: vi.fn(),
      } as unknown as ModelProvider,
      // no renderPageImages — what a BYO parse provider leaves behind
    };
    const config = normalizeConfig({ classes: { policy: { keywords: ["declarations"] } } });
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("unknown");
    expect(out.reason).toContain("cannot render page images");
    expect(out.reason).toContain("no extractable text layer");
  });

  it("explains WHY it could not decide — model provider has no image support", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "" }], 1),
      classifyDocType: fakeDocType("scanned_pdf"),
      provider: { generate: vi.fn() } as unknown as ModelProvider,
      renderPageImages: vi.fn(async () => ["base64img"]),
    };
    const config = normalizeConfig({ classes: { policy: { keywords: ["declarations"] } } });
    const out = await runCascade(input, config, deps);
    expect(out.reason).toContain("does not support image input");
  });

  it("explains WHY it could not decide — the cost ceiling stopped short of vision", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "" }], 1),
      classifyDocType: fakeDocType("scanned_pdf"),
    };
    const config = normalizeConfig({
      classify: { max_tier: 3 },
      classes: { policy: { keywords: ["declarations"] } },
    });
    const out = await runCascade(input, config, deps);
    expect(out.reason).toContain("maxTier=3");
  });

  it("leaves no reason on a decided outcome", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "declarations page insuring agreement" }]),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const config = normalizeConfig({
      classes: { policy: { keywords: ["declarations", "insuring agreement"] } },
    });
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("policy");
    expect(out.reason).toBeUndefined();
  });

  it("includes deterministic scores in the outcome once the keyword tier ran", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "invoice amount due remit to" }]),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const config = normalizeConfig({
      classes: { invoice: { keywords: ["invoice", "amount due", "remit to"] } },
    });
    const out = await runCascade(input, config, deps);
    expect(out.scores?.[0]?.id).toBe("invoice");
    expect(out.label).toBe("invoice");
  });
});

describe("runCascade — non-PDF documents", () => {
  const config = normalizeConfig({
    classes: {
      invoice: { keywords: ["invoice", "amount due", "remit to"] },
      policy: { keywords: ["declarations"] },
    },
  });

  it("classifies a markdown document with no injected reader", async () => {
    // The bug: pdfjs rejects .md bytes, the cascade saw no text, and every doc
    // fell through to `unknown` — which routes a pipeline to its default edge.
    const md = {
      filename: "doc.md",
      mimeType: "text/markdown",
      fileBuffer: Buffer.from("# Bill\n\nINVOICE — amount due, please remit to Acme\n"),
    };
    const out = await runCascade(md, config, { classifyDocType: fakeDocType("digital_pdf") });

    expect(out.label).toBe("invoice");
    expect(out.method).toBe("keyword");
  });

  it("sniffs a text-like extension even when the mime type is octet-stream", async () => {
    const md = {
      filename: "doc.md",
      mimeType: "application/octet-stream",
      fileBuffer: Buffer.from("invoice — amount due, remit to Acme"),
    };
    const out = await runCascade(md, config, { classifyDocType: fakeDocType("digital_pdf") });
    expect(out.label).toBe("invoice");
  });

  it("falls back to caller-supplied text when the reader can't open the bytes", async () => {
    // A .docx: pdfjs can't open it (totalPages 0), but the pipeline parsed it.
    const deps: CascadeDeps = {
      getPageTexts: vi.fn(async () => ({ totalPages: 0, pages: [] })),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const docx = {
      filename: "doc.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileBuffer: Buffer.from("PK\x03\x04binary"),
      text: "invoice — amount due, remit to Acme",
    };
    const out = await runCascade(docx, config, deps);
    expect(out.label).toBe("invoice");
    expect(out.method).toBe("keyword");
  });

  it("does NOT hijack a scanned PDF with caller text — it still escalates to vision", async () => {
    // pdfjs opens a scanned PDF and reports pages that happen to be blank.
    // totalPages > 0, so the parsed text must not short-circuit the vision tier.
    const generateWithImage = vi.fn(async () => JSON.stringify({ label: "policy", confidence: 0.9 }));
    const renderPageImages = vi.fn(async () => ["base64img"]);
    const deps: CascadeDeps = {
      getPageTexts: vi.fn(async () => ({ totalPages: 3, pages: [{ page: 1, text: "" }] })),
      classifyDocType: fakeDocType("scanned_pdf"),
      provider: { generate: vi.fn(), generateWithImage } as unknown as ModelProvider,
      renderPageImages,
    };
    const scanned = {
      filename: "scan.pdf",
      mimeType: "application/pdf",
      fileBuffer: Buffer.from("%PDF-"),
      text: "invoice — amount due, remit to Acme", // would win the keyword tier if used
    };
    const out = await runCascade(scanned, normalizeConfig({ max_tier: 4, classes: { invoice: { keywords: ["invoice", "amount due"] }, policy: { keywords: ["declarations"] } } }), deps);

    expect(out.method).toBe("vision");
    expect(out.label).toBe("policy");
    expect(generateWithImage).toHaveBeenCalled();
  });

  it("ignores blank caller text", async () => {
    const deps: CascadeDeps = {
      getPageTexts: vi.fn(async () => ({ totalPages: 0, pages: [] })),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const out = await runCascade(
      { filename: "d.docx", mimeType: "application/octet-stream", fileBuffer: Buffer.from("x"), text: "   \n " },
      config,
      deps,
    );
    expect(out.label).toBe("unknown");
  });
});

describe("runCascade — disqualifying signals (exclude_keywords / exclude_patterns)", () => {
  it("keeps an excluded class from winning the keyword tier", async () => {
    // The doc has umbrella-ish text, but it also carries its own GL coverage
    // part — which disqualifies the standalone-umbrella class.
    const deps: CascadeDeps = {
      getPageTexts: fakePages([
        { page: 1, text: "commercial umbrella schedule of underlying insurance; commercial general liability coverage part limits" },
      ]),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const config = normalizeConfig({
      classes: {
        umbrella: {
          keywords: ["umbrella", "schedule of underlying"],
          exclude_keywords: ["general liability coverage part"],
        },
        package: { keywords: ["general liability coverage part"] },
      },
    });
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("package");
    expect(out.label).not.toBe("umbrella");
  });

  it("drops an excluded class from the LLM candidate set", async () => {
    // No keyword decides; the LLM would happily say 'umbrella', but it's excluded
    // and thus not offered — and can't be returned even if the model names it.
    const generate = vi.fn(async (_prompt: string, _json?: boolean) => JSON.stringify({ label: "umbrella", confidence: 0.9 }));
    const deps: CascadeDeps = {
      getPageTexts: fakePages([
        { page: 1, text: "this policy provides commercial property coverage part and general liability, plus a companion umbrella" },
      ]),
      classifyDocType: fakeDocType("digital_pdf"),
      provider: { generate } as unknown as ModelProvider,
    };
    const config = normalizeConfig({
      classes: {
        umbrella: { description: "standalone umbrella", exclude_keywords: ["commercial property coverage part"] },
        package: { description: "a package policy" },
      },
    });
    const out = await runCascade(input, config, deps);
    // 'umbrella' was excluded, so the model's 'umbrella' answer is rejected → unknown.
    expect(out.label).not.toBe("umbrella");
    // The prompt it saw must not have listed the excluded class.
    const promptArg = generate.mock.calls[0]?.[0] ?? "";
    expect(promptArg).toContain("package");
    expect(promptArg).not.toContain("standalone umbrella");
  });

  it("does not exclude when the disqualifying signal is absent", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "commercial umbrella schedule of underlying insurance excess each occurrence" }]),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const config = normalizeConfig({
      classes: {
        umbrella: {
          keywords: ["umbrella", "schedule of underlying"],
          exclude_keywords: ["general liability coverage part"],
        },
        package: { keywords: ["businessowners"] },
      },
    });
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("umbrella");
  });

  it("supports exclude_patterns (regex)", async () => {
    const deps: CascadeDeps = {
      getPageTexts: fakePages([{ page: 1, text: "umbrella policy — Limit of Insurance $1,000,000 each occurrence over underlying" }]),
      classifyDocType: fakeDocType("digital_pdf"),
    };
    const config = normalizeConfig({
      classes: {
        umbrella: {
          keywords: ["umbrella"],
          exclude_patterns: ["coverage part\\s+limits?"],
        },
        other: { keywords: ["nomatch"] },
      },
    });
    // pattern doesn't match → umbrella stays eligible and wins
    const out = await runCascade(input, config, deps);
    expect(out.label).toBe("umbrella");
  });
});
