/**
 * Serve a cached parse in the page shape (`parse/pages.ts`).
 *
 * Parses cached before every provider marked pages hold their markdown as one
 * block (or, for the digital path, without slots for blank pages). When the
 * cache entry also kept its parse spine — every structured provider caches its
 * `chunks`, each carrying its page — the paged markdown is re-projected from
 * that spine: no new parse, no OCR cost.
 *
 * The re-projection is used only when it carries exactly the cached text: with
 * page breaks and empty pages set aside, it must equal the cached markdown. If
 * anything differs (an escalated re-parse overwrote the markdown, a spine from
 * an older canonicalizer), the cached markdown is served unchanged. Parsed text
 * is never dropped or altered here — only page breaks are added.
 */

import { spineToMarkdown, type ParseUnit } from "./chunk";
import { withoutPageBreaks } from "./pages";

export interface CachedParsePayload {
  markdown?: string;
  pages?: number | null;
  chunks?: ParseUnit[];
}

export function pagedCachedMarkdown(payload: CachedParsePayload): string {
  const markdown = payload.markdown ?? "";
  const chunks = payload.chunks;
  if (!markdown || !Array.isArray(chunks) || chunks.length === 0) return markdown;
  if (!chunks.every((c) => c && typeof c.text === "string" && Number.isFinite(c.page))) return markdown;

  const paged = spineToMarkdown(chunks, payload.pages ?? null);
  if (paged === markdown) return markdown;
  return withoutPageBreaks(paged) === withoutPageBreaks(markdown) ? paged : markdown;
}
