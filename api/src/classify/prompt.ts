/**
 * Tier-3 LLM classification: prompt builder + tolerant response parser.
 *
 * Whole-document, single-label classification (distinct from the packet
 * splitter's contiguous-range multi-section prompt). The prompt is deliberately
 * generic — class ids and descriptions come from config — and asks the model to
 * name the page it keyed on so a cover-sheet miss stays debuggable.
 */

import type { ClassifierClass } from "./config";
import { UNKNOWN_LABEL } from "./types";
import type { PageText } from "./types";

const PAGE_PREVIEW_CHARS = 2000;

export function buildClassifyPrompt(pages: PageText[], classes: ClassifierClass[]): string {
  const classLines = classes
    .map((c) => `- ${c.id}: ${(c.description ?? "").trim() || c.id}`)
    .join("\n");

  const pageBlock = pages
    .map((p) => `--- page ${p.page} ---\n${p.text.slice(0, PAGE_PREVIEW_CHARS)}`)
    .join("\n\n");

  return `You are classifying a single document into exactly one class.

Some documents have an unrelated cover sheet, fax header, or routing slip on the first page — ignore those and classify the actual document.

Classes:
${classLines}
- ${UNKNOWN_LABEL}: none of the classes above fit.

Return JSON in this exact shape, nothing else:
{"label": "<class id or ${UNKNOWN_LABEL}>", "confidence": 0.0, "evidence_page": <page number the label is based on>}

Document pages:

${pageBlock}
`;
}

/**
 * Vision-tier prompt (Tier 4): no embedded text to show, so the model reads the
 * rendered page image directly. Same output contract as the text prompt.
 */
export function buildVisionClassifyPrompt(classes: ClassifierClass[]): string {
  const classLines = classes
    .map((c) => `- ${c.id}: ${(c.description ?? "").trim() || c.id}`)
    .join("\n");

  return `You are classifying a single document into exactly one class, from a page image.

Some documents have an unrelated cover sheet, fax header, or routing slip on the first page — ignore those and classify the actual document.

Classes:
${classLines}
- ${UNKNOWN_LABEL}: none of the classes above fit.

Return JSON in this exact shape, nothing else:
{"label": "<class id or ${UNKNOWN_LABEL}>", "confidence": 0.0, "evidence_page": <page number the label is based on>}
`;
}

export interface ParsedClassifyResponse {
  label: string;
  confidence: number;
  evidencePage: number | null;
}

/**
 * Parse the model response. Tolerates markdown fences and stray prose. Coerces
 * an unrecognized label to {@link UNKNOWN_LABEL} and clamps confidence to
 * [0,1]. Returns null when no JSON object is recoverable.
 */
export function parseClassifyResponse(
  raw: string | null,
  validIds: Set<string>,
): ParsedClassifyResponse | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        obj = JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const labelRaw = obj.label;
  let label = typeof labelRaw === "string" ? labelRaw.trim() : UNKNOWN_LABEL;
  if (label !== UNKNOWN_LABEL && !validIds.has(label)) {
    label = UNKNOWN_LABEL;
  }

  let confidence = typeof obj.confidence === "number" ? obj.confidence : parseFloat(String(obj.confidence));
  if (Number.isNaN(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const pageRaw = obj.evidence_page;
  const evidencePage =
    typeof pageRaw === "number" && Number.isFinite(pageRaw) && pageRaw > 0
      ? Math.floor(pageRaw)
      : null;

  return { label, confidence, evidencePage };
}
