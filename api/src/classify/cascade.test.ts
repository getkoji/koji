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
