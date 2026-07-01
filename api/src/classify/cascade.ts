/**
 * The classifier cost cascade.
 *
 * Runs a document through increasingly expensive tiers and stops at the first
 * confident label:
 *
 *   Tier 0 METADATA — doc type (digital/scanned/image) for routing.
 *   Tier 1 TEXT     — cheap windowed page text (no OCR).
 *   Tier 2 KEYWORD  — deterministic keyword/pattern match; free.
 *   Tier 3 LLM      — model classify over the windowed text.
 *   Tier 4 VISION   — model classify over rendered page images (scanned tail).
 *
 * All I/O is injected so the orchestration is unit-testable without pdfjs, a
 * model provider, or a renderer. `config.maxTier` is a hard ceiling — the
 * cascade never spends past it and returns "unknown" if the allowed tiers can't
 * decide. Nothing here is domain-specific.
 */

import type { ClassifierConfig } from "./config";
import { classifyDocument, type DocumentType } from "../parse/classify";
import { readPdfWindow, type GetPageTexts } from "./pdf-text";
import { densityRank, effectiveWindow } from "./window";
import { scoreClasses } from "./keyword-match";
import { buildClassifyPrompt, buildVisionClassifyPrompt, parseClassifyResponse } from "./prompt";
import type { ModelProvider } from "../extract/providers";
import { Tier, UNKNOWN_LABEL } from "./types";
import type { ClassifyOutcome, PageText, TierValue } from "./types";

export interface DocumentInput {
  filename: string;
  mimeType: string;
  fileBuffer: Buffer;
}

/** Renders the given pages to base64 PNG/JPEG images for the vision tier. */
export type RenderPageImages = (fileBuffer: Buffer, pageNumbers: number[]) => Promise<string[]>;

export interface CascadeDeps {
  /** Cheap windowed text extractor. Defaults to the pdfjs implementation. */
  getPageTexts?: GetPageTexts;
  /** Doc-type classifier (Tier 0). Defaults to parse/classify. */
  classifyDocType?: (filename: string, mimeType: string, fileBuffer: Buffer) => Promise<DocumentType>;
  /** LLM provider for Tiers 3/4. When absent, those tiers are skipped. */
  provider?: ModelProvider;
  /** Page renderer for Tier 4 vision. When absent, the vision tier is skipped. */
  renderPageImages?: RenderPageImages;
}

function validIdSet(config: ClassifierConfig): Set<string> {
  return new Set(config.classes.map((c) => c.id));
}

export async function runCascade(
  input: DocumentInput,
  config: ClassifierConfig,
  deps: CascadeDeps = {},
): Promise<ClassifyOutcome> {
  const getPageTexts = deps.getPageTexts ?? readPdfWindow;
  const classifyDocType = deps.classifyDocType ?? classifyDocument;

  let deepestTier: TierValue = Tier.METADATA;

  // Tier 0 — metadata / doc type. Informs routing (does the cheap text path
  // even apply?) but never produces a class label on its own.
  const docType = await classifyDocType(input.filename, input.mimeType, input.fileBuffer);

  // Tier 1 — cheap windowed text. Skip entirely if the ceiling is below TEXT.
  const window = effectiveWindow(
    config.window,
    config.classes.map((c) => c.window),
  );
  let allWindowPages: PageText[] = [];
  let rankedPages: PageText[] = [];
  if (config.maxTier >= Tier.TEXT) {
    deepestTier = Tier.TEXT;
    const { pages } = await getPageTexts(input.fileBuffer, window, config.scan);
    allWindowPages = pages;
    rankedPages = densityRank(pages);
  }

  const hasText = rankedPages.length > 0;

  // Tier 2 — deterministic keyword/pattern match. Free; short-circuits when a
  // class clears the threshold AND beats the runner-up by the margin.
  let scores: ClassifyOutcome["scores"];
  if (config.maxTier >= Tier.KEYWORD && hasText) {
    deepestTier = Tier.KEYWORD;
    scores = scoreClasses(rankedPages, config.classes, config.window);
    const top = scores[0];
    const second = scores[1];
    if (
      top &&
      top.total > 0 &&
      top.score >= config.keywordThreshold &&
      (!second || top.score - second.score >= config.keywordMargin)
    ) {
      return {
        label: top.id,
        confidence: top.score,
        method: "keyword",
        tierUsed: Tier.KEYWORD,
        evidencePage: top.evidencePage,
        scores,
      };
    }
  }

  // Tier 3 — LLM over the windowed text.
  if (config.maxTier >= Tier.LLM && deps.provider && hasText) {
    deepestTier = Tier.LLM;
    const prompt = buildClassifyPrompt(rankedPages, config.classes);
    let raw: string | null = null;
    try {
      raw = await deps.provider.generate(prompt, true);
    } catch (err) {
      console.warn(
        `[classify] LLM tier failed for ${input.filename}:`,
        err instanceof Error ? err.message : err,
      );
    }
    const parsed = parseClassifyResponse(raw, validIdSet(config));
    if (parsed && parsed.label !== UNKNOWN_LABEL) {
      return {
        label: parsed.label,
        confidence: parsed.confidence,
        method: "llm",
        tierUsed: Tier.LLM,
        evidencePage: parsed.evidencePage,
        scores,
      };
    }
  }

  // Tier 4 — vision over rendered page images. The scanned/image tail: no text
  // layer, so deterministic and text-LLM tiers found nothing.
  if (
    config.maxTier >= Tier.VISION &&
    deps.provider?.generateWithImage &&
    deps.renderPageImages
  ) {
    deepestTier = Tier.VISION;
    const visionPages = allWindowPages.length
      ? allWindowPages.map((p) => p.page)
      : [1];
    const prompt = buildVisionClassifyPrompt(config.classes);
    let images: string[] = [];
    try {
      images = await deps.renderPageImages(input.fileBuffer, visionPages);
    } catch (err) {
      console.warn(
        `[classify] vision render failed for ${input.filename}:`,
        err instanceof Error ? err.message : err,
      );
    }
    for (let i = 0; i < images.length; i++) {
      let raw: string | null = null;
      try {
        raw = await deps.provider.generateWithImage(prompt, images[i]!, true);
      } catch (err) {
        console.warn(
          `[classify] vision tier failed for ${input.filename} page ${visionPages[i]}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const parsed = parseClassifyResponse(raw, validIdSet(config));
      if (parsed && parsed.label !== UNKNOWN_LABEL) {
        return {
          label: parsed.label,
          confidence: parsed.confidence,
          method: "vision",
          tierUsed: Tier.VISION,
          evidencePage: parsed.evidencePage ?? visionPages[i] ?? null,
          scores,
        };
      }
    }
  }

  // Nothing decided within the cost ceiling. `on_unknown: reject` is enforced by
  // the caller (route boundary) so the engine stays a total function.
  return {
    label: UNKNOWN_LABEL,
    confidence: 0,
    method: "unknown",
    tierUsed: deepestTier,
    evidencePage: null,
    scores,
  };
}
