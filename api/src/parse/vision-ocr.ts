/**
 * Vision-OCR re-parse — the bad-scan escalation fallback.
 *
 * When the legibility check flags a document as a bad scan AND the pipeline has
 * a vision-capable fallback model configured, the ingestion pipeline renders the
 * pages to images (parse service `/page-images`) and transcribes each with the
 * vision model here. A vision model reads faded / skewed / noisy scans far
 * better than traditional OCR — validated on real bad scans where docling/OCR
 * produced garbage and the vision model produced clean text.
 *
 * One LLM call per page, so this is intentionally gated behind the legibility
 * check: normal documents never reach it.
 */

import type { ModelProvider } from "../extract/providers";

const PAGE_PROMPT = `You are transcribing a scanned document page. Output ALL text exactly as it appears,
preserving reading order and structure as Markdown (headings, lists, and tables where present).
Do not summarize, correct, translate, or add commentary. If a word is genuinely unreadable, write
[illegible]. Output only the transcription.`;

const PAGE_SEPARATOR = "\n\n";

export interface VisionOcrResult {
  markdown: string;
  pages: number;
}

/**
 * Transcribe page images to markdown with a vision model. Pages run with bounded
 * concurrency. Throws if the provider can't take images or if any page fails —
 * the caller falls back to the original parse on error (a partial transcription
 * is worse than the known-garbled-but-complete original).
 */
export async function visionOcrPages(
  images: string[],
  provider: ModelProvider,
  opts: { concurrency?: number } = {},
): Promise<VisionOcrResult> {
  if (typeof provider.generateWithImage !== "function") {
    throw new Error("configured fallback parse model does not support image input");
  }
  if (images.length === 0) {
    return { markdown: "", pages: 0 };
  }

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, images.length));
  const out: string[] = new Array(images.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= images.length) return;
      // generateWithImage is verified above; non-null asserted for the closure.
      const text = await provider.generateWithImage!(PAGE_PROMPT, images[i]!, false);
      out[i] = (text ?? "").trim();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { markdown: out.join(PAGE_SEPARATOR).trim(), pages: images.length };
}
