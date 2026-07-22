import { describe, it, expect, vi } from "vitest";
import { visionOcrPages } from "./vision-ocr";
import type { ModelProvider } from "../extract/providers";
import { DEFAULT_CONTEXT_TOKENS } from "../extract/context-budget";

function visionProvider(perPage: (img: string) => string): ModelProvider {
  return {
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    generate: vi.fn(),
    generateWithImage: vi.fn().mockImplementation(async (_prompt: string, img: string) => perPage(img)),
  };
}

describe("visionOcrPages", () => {
  it("transcribes each page and joins in order", async () => {
    const provider = visionProvider((img) => `text for ${img}`);
    const res = await visionOcrPages(["A", "B", "C"], provider, { concurrency: 2 });
    expect(res.pages).toBe(3);
    // Order preserved despite concurrency.
    expect(res.markdown).toBe("text for A\n\ntext for B\n\ntext for C");
    expect(provider.generateWithImage).toHaveBeenCalledTimes(3);
  });

  it("calls the vision model with jsonMode=false (raw transcription, not JSON)", async () => {
    const provider = visionProvider(() => "x");
    await visionOcrPages(["A"], provider);
    const call = (provider.generateWithImage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe("A"); // image
    expect(call[2]).toBe(false); // jsonMode off
  });

  it("returns empty for no pages", async () => {
    const provider = visionProvider(() => "x");
    const res = await visionOcrPages([], provider);
    expect(res).toEqual({ markdown: "", pages: 0 });
    expect(provider.generateWithImage).not.toHaveBeenCalled();
  });

  it("throws when the provider can't take images", async () => {
    const noVision: ModelProvider = { contextTokens: DEFAULT_CONTEXT_TOKENS, generate: vi.fn() };
    await expect(visionOcrPages(["A"], noVision)).rejects.toThrow(/does not support image/);
  });

  it("propagates a page failure (caller falls back to original parse)", async () => {
    const provider: ModelProvider = {
      contextTokens: DEFAULT_CONTEXT_TOKENS,
      generate: vi.fn(),
      generateWithImage: vi.fn().mockRejectedValue(new Error("vision 500")),
    };
    await expect(visionOcrPages(["A", "B"], provider)).rejects.toThrow("vision 500");
  });

  it("trims per-page output", async () => {
    const provider = visionProvider(() => "  padded text  \n");
    const res = await visionOcrPages(["A"], provider);
    expect(res.markdown).toBe("padded text");
  });
});
