/**
 * Legibility detection — judge whether parsed document text is coherent or
 * garbled by a bad scan (missing letters, jumbled/nonsense words, run-together
 * text, OCR noise).
 *
 * This is distinct from the `/uniXXXX` glyph-garble detector in the parse
 * service: that catches a font-decoding failure deterministically. This catches
 * *content* quality — a genuinely low-resolution / skewed / noisy scan that OCR
 * couldn't read cleanly — which is only judgeable semantically, so it's one
 * cheap LLM call over a sample of the parsed markdown.
 *
 * When a document is flagged illegible AND a fallback parse model is configured,
 * the ingestion pipeline escalates to a more capable (vision) parse — see the
 * escalation flow in ingestion/process.ts. The check is opt-in (gated by
 * pipeline config) so normal parses pay nothing.
 *
 * Fails open: if the LLM call errors or returns garbage, the document is treated
 * as legible. A flaky judge must never block ingestion.
 */

import type { ModelProvider } from "../extract/providers";

/** How much parsed text to sample for the judgement. The opening of a document
 *  is a strong signal; sampling the whole thing just burns tokens. */
const SAMPLE_CHARS = 1500;

/** Below this confidence-of-legibility, the document is considered a bad scan. */
export const DEFAULT_LEGIBILITY_THRESHOLD = 0.6;

export interface LegibilityVerdict {
  /** True when the text reads as coherent (or the check failed open). */
  legible: boolean;
  /** Model's confidence that the text is legible, 0–1. */
  confidence: number;
  /** Short human-readable explanation. */
  reason: string | null;
  /** Whether the check itself errored (and therefore failed open to legible). */
  errored: boolean;
}

export function buildLegibilityPrompt(sample: string): string {
  return `The text below was extracted from a scanned document by OCR. Judge whether it is
legible and coherent, or garbled by a poor scan — missing or wrong letters, jumbled or
nonsense words, run-together text, or heavy noise. Ignore layout, spacing, and formatting;
judge only whether the *words and characters* came through readably.

Respond with ONLY a JSON object:
{"legible": true or false, "confidence": <0.0-1.0, your confidence the text is legible>, "reason": "<one short sentence>"}

--- EXTRACTED TEXT ---
${sample}
--- END ---`;
}

/**
 * Parse the judge's JSON. Fails open (legible) on anything unparseable — a
 * malformed response must not flag a good document as a bad scan.
 */
export function parseLegibilityResponse(raw: string): { legible: boolean; confidence: number; reason: string | null } {
  const failOpen = { legible: true, confidence: 1, reason: "judge response unparseable; failing open" };
  if (!raw) return failOpen;
  const text = raw.trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return failOpen;
    try {
      data = JSON.parse(match[0]);
    } catch {
      return failOpen;
    }
  }
  if (!data || typeof data !== "object" || !("legible" in data)) return failOpen;
  const d = data as Record<string, unknown>;
  const legible = Boolean(d.legible);
  let confidence = typeof d.confidence === "number" ? d.confidence : legible ? 1 : 0;
  if (!Number.isFinite(confidence)) confidence = legible ? 1 : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return { legible, confidence, reason: typeof d.reason === "string" ? d.reason : null };
}

/**
 * Run the legibility judge over a sample of `markdown` using `provider` (the
 * tenant's configured LLM — use the cheapest one). Returns a verdict; never
 * throws (fails open to legible on any error).
 */
export async function checkLegibility(markdown: string, provider: ModelProvider): Promise<LegibilityVerdict> {
  const sample = (markdown ?? "").slice(0, SAMPLE_CHARS);
  // Almost-empty parse output is itself a failure signal, but that's the
  // parser's domain (zero-page / empty-file guards) — here we only judge text
  // that exists. Empty sample → nothing to judge → legible.
  if (sample.trim().length === 0) {
    return { legible: true, confidence: 1, reason: "no text to judge", errored: false };
  }
  let raw: string;
  try {
    raw = await provider.generate(buildLegibilityPrompt(sample), true);
  } catch (e) {
    return { legible: true, confidence: 1, reason: `legibility check failed: ${String(e)}`, errored: true };
  }
  const { legible, confidence, reason } = parseLegibilityResponse(raw);
  return { legible, confidence, reason, errored: false };
}

/** A document is a "bad scan" when the judge's legibility confidence is below the
 *  threshold. (errored checks fail open and are never flagged.) */
export function isBadScan(verdict: LegibilityVerdict, threshold: number = DEFAULT_LEGIBILITY_THRESHOLD): boolean {
  return !verdict.errored && (!verdict.legible || verdict.confidence < threshold);
}
