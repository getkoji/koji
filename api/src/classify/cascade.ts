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

import type { ClassifierConfig, ClassifierClass } from "./config";
import { classifyDocument, type DocumentType } from "../parse/classify";
import { readPdfWindow, readTextWindow, isTextLike, type GetPageTexts } from "./pdf-text";
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
  /**
   * Text already extracted from this document by the parse stage, when the
   * caller has it. Used only when the cheap reader can't open the bytes at all
   * (a .docx, an .xlsx) — a format the classifier would otherwise be blind to
   * even though the pipeline around it can read the document fine.
   *
   * NOT used for a scanned PDF: pdfjs opens those, reports its page count, and
   * returns blank pages, which is the cascade's cue to escalate to vision.
   */
  text?: string;
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

function validIdSet(classes: ClassifierClass[]): Set<string> {
  return new Set(classes.map((c) => c.id));
}

/**
 * Class ids ruled out by their own `excludeKeywords`/`excludePatterns` appearing
 * in the window text. An excluded class is a hard, deterministic gate: it can't
 * win the keyword tier and is dropped from the LLM/vision candidate list, so no
 * tier can pick it. Requires textual evidence — with no window text (a scanned
 * PDF headed for the vision tier) nothing is excluded, since there's nothing to
 * disqualify on. Generic: the engine matches the strings; which strings rule out
 * which class is entirely user config.
 */
function excludedClassIds(classes: ClassifierClass[], pages: PageText[]): Set<string> {
  const out = new Set<string>();
  if (pages.length === 0) return out;
  const hay = pages.map((p) => p.text).join("\n").toLowerCase();
  for (const c of classes) {
    const kwHit = (c.excludeKeywords ?? []).some((k) => {
      const kw = k.toLowerCase().trim();
      return kw.length > 0 && hay.includes(kw);
    });
    const patHit =
      !kwHit &&
      (c.excludePatterns ?? []).some((p) => {
        try {
          return new RegExp(p, "i").test(hay);
        } catch {
          return false; // rejected at config-compile time; ignore defensively
        }
      });
    if (kwHit || patHit) out.add(c.id);
  }
  return out;
}

export async function runCascade(
  input: DocumentInput,
  config: ClassifierConfig,
  deps: CascadeDeps = {},
): Promise<ClassifyOutcome> {
  // A text-like document's bytes ARE its text; pdfjs would simply reject them.
  const getPageTexts =
    deps.getPageTexts ?? (isTextLike(input.filename, input.mimeType) ? readTextWindow : readPdfWindow);
  const classifyDocType = deps.classifyDocType ?? classifyDocument;

  let deepestTier: TierValue = Tier.METADATA;
  /**
   * Why each tier that could have decided the label didn't get to run. Rolled
   * into the outcome's `reason` when nothing decides, so an `unknown` says
   * whether the classifier looked and couldn't tell or never got to look
   * (oss-489). Not populated once a tier returns a label — the answer is the
   * explanation.
   */
  const skipped: string[] = [];

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
    const { pages, totalPages } = await getPageTexts(input.fileBuffer, window, config.scan);
    // totalPages === 0 means the reader couldn't open the bytes as a document
    // at all (a .docx, an .xlsx). If the caller already parsed it, classify on
    // that text rather than going blind. A scanned PDF reports totalPages > 0
    // with blank pages, so it still escalates to vision as before.
    allWindowPages =
      totalPages === 0 && pages.length === 0 && input.text?.trim()
        ? [{ page: 1, text: input.text }]
        : pages;
    rankedPages = densityRank(allWindowPages);
  }

  const hasText = rankedPages.length > 0;
  if (!hasText && config.maxTier >= Tier.KEYWORD) {
    skipped.push("no extractable text layer, so the keyword and LLM tiers had nothing to read");
  }

  // Disqualify classes whose exclude signals appear in the window text. Computed
  // once from the window and applied to every tier below, so an excluded class
  // can't win by keyword, LLM, or vision.
  const excluded = excludedClassIds(config.classes, allWindowPages);
  const eligibleClasses =
    excluded.size > 0 ? config.classes.filter((c) => !excluded.has(c.id)) : config.classes;

  // Tier 2 — deterministic keyword/pattern match. Free; short-circuits when a
  // class clears the threshold AND beats the runner-up by the margin.
  let scores: ClassifyOutcome["scores"];
  if (config.maxTier >= Tier.KEYWORD && hasText) {
    deepestTier = Tier.KEYWORD;
    scores = scoreClasses(rankedPages, eligibleClasses, config.window);
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
  if (config.maxTier >= Tier.LLM && hasText && !deps.provider) {
    skipped.push("LLM tier skipped: no model provider");
  }
  if (config.maxTier >= Tier.LLM && deps.provider && hasText) {
    deepestTier = Tier.LLM;
    const prompt = buildClassifyPrompt(rankedPages, eligibleClasses);
    let raw: string | null = null;
    try {
      raw = await deps.provider.generate(prompt, true);
    } catch (err) {
      console.warn(
        `[classify] LLM tier failed for ${input.filename}:`,
        err instanceof Error ? err.message : err,
      );
    }
    const parsed = parseClassifyResponse(raw, validIdSet(eligibleClasses));
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
  // Every missing prerequisite is reported, not just the first one found: a
  // document that needs BOTH a vision-capable model and a renderer should say
  // so once, instead of sending the operator back for a second run to discover
  // the next thing that was also missing.
  if (config.maxTier < Tier.VISION) {
    skipped.push(`vision tier not allowed by maxTier=${config.maxTier}`);
  } else {
    const missing: string[] = [];
    if (!deps.provider) missing.push("no model provider");
    else if (!deps.provider.generateWithImage) {
      missing.push("the model provider does not support image input");
    }
    // The oss-489 failure: a BYO parse provider with no `pageImages`.
    if (!deps.renderPageImages) missing.push("the parse provider cannot render page images");
    if (missing.length > 0) skipped.push(`vision tier skipped: ${missing.join(" and ")}`);
  }
  if (
    config.maxTier >= Tier.VISION &&
    deps.provider?.generateWithImage &&
    deps.renderPageImages
  ) {
    deepestTier = Tier.VISION;
    const visionPages = allWindowPages.length
      ? allWindowPages.map((p) => p.page)
      : [1];
    const prompt = buildVisionClassifyPrompt(eligibleClasses);
    let images: string[] = [];
    try {
      images = await deps.renderPageImages(input.fileBuffer, visionPages);
    } catch (err) {
      console.warn(
        `[classify] vision render failed for ${input.filename}:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (images.length === 0) {
      skipped.push("vision tier produced no page images to classify");
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
      const parsed = parseClassifyResponse(raw, validIdSet(eligibleClasses));
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
    reason: skipped.length > 0 ? skipped.join("; ") : "no tier matched a class",
  };
}
