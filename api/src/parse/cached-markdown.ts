/**
 * Serve a cached parse in the page shape (`parse/pages.ts`).
 *
 * Parses cached before every provider marked pages hold their markdown in an
 * older shape, and each is brought to the page shape here with no new parse:
 *
 * - **One block, with a cached spine.** Every structured provider (Document
 *   AI, Textract) caches its `chunks`, each carrying its page, so the paged
 *   markdown is re-projected from that spine.
 * - **Pages without blank-page slots, with a word map.** The digital path
 *   (pdfjs) used to drop pages with no text, so piece k was not page k. Its
 *   cached `text_map` places every word on its page and at its markdown offset,
 *   so each piece is put back on its page and blank pages get their empty
 *   slots. The word map's offsets are moved with their piece.
 *
 * A re-projection is used only when it carries exactly the cached text: with
 * page breaks and empty pages set aside, it must equal the cached markdown. If
 * anything differs, the cached markdown is served unchanged. Parsed text is
 * never dropped or altered here — only page breaks are added.
 */

import { spineToMarkdown, type ParseUnit } from "./chunk";
import { PAGE_SEPARATOR, joinPages, splitPages, withoutPageBreaks } from "./pages";

/** A cached word-map segment, as the parse cache stores it (flat). */
export interface CachedTextMapSegment {
  page: number;
  md_offset?: number;
  md_length?: number;
  [key: string]: unknown;
}

export interface CachedParsePayload {
  markdown?: string;
  pages?: number | null;
  chunks?: ParseUnit[];
  text_map?: CachedTextMapSegment[];
}

export interface PagedCachedParse {
  markdown: string;
  /** The word map, its `md_offset`s moved to the returned markdown. */
  textMap: CachedTextMapSegment[] | undefined;
}

export function pagedCachedParse(payload: CachedParsePayload): PagedCachedParse {
  const markdown = payload.markdown ?? "";
  const textMap = Array.isArray(payload.text_map) ? payload.text_map : undefined;
  const unchanged = { markdown, textMap };
  if (!markdown) return unchanged;

  const fromSpine = reprojectSpine(markdown, payload.chunks, payload.pages ?? null);
  if (fromSpine !== null) return { markdown: fromSpine, textMap };

  return reslotPages(markdown, payload.pages ?? null, textMap) ?? unchanged;
}

/** The markdown only — for readers that don't use the word map. */
export function pagedCachedMarkdown(payload: CachedParsePayload): string {
  return pagedCachedParse(payload).markdown;
}

function sameText(paged: string, markdown: string): boolean {
  return withoutPageBreaks(paged) === withoutPageBreaks(markdown);
}

function reprojectSpine(markdown: string, chunks: ParseUnit[] | undefined, pages: number | null): string | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  if (!chunks.every((c) => c && typeof c.text === "string" && Number.isFinite(c.page))) return null;
  const paged = spineToMarkdown(chunks, pages);
  if (paged === markdown || !sameText(paged, markdown)) return null;
  return paged;
}

/**
 * Put each page piece back on its page using the word map, giving pages with
 * no text an empty slot. Null when the pieces already number the pages, or
 * when any piece can't be placed with certainty.
 */
function reslotPages(
  markdown: string,
  pageCount: number | null,
  textMap: CachedTextMapSegment[] | undefined,
): PagedCachedParse | null {
  if (!pageCount || pageCount < 2 || !textMap || textMap.length === 0) return null;
  const pieces = splitPages(markdown);
  if (pieces.length >= pageCount) return null;

  // Where each piece starts in the cached markdown.
  const starts: number[] = [];
  let pos = 0;
  for (const piece of pieces) {
    starts.push(pos);
    pos += piece.length + PAGE_SEPARATOR.length;
  }
  const pieceAt = (offset: number): number => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= offset) i++;
    return i;
  };

  // Each piece's page: the page every one of its located words is on.
  const pageOf: Array<number | null> = pieces.map(() => null);
  for (const seg of textMap) {
    if (typeof seg.md_offset !== "number" || !Number.isFinite(seg.page)) continue;
    const i = pieceAt(seg.md_offset);
    if (pageOf[i] === null) pageOf[i] = seg.page;
    else if (pageOf[i] !== seg.page) return null; // a piece spanning pages: not the old shape
  }
  let prev = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pageOf[i] ?? null;
    if (p === null || p <= prev || p > pageCount || pieces[i]!.trim().length === 0) return null;
    prev = p;
  }

  const slots: string[] = Array.from({ length: pageCount }, () => "");
  pieces.forEach((piece, i) => {
    slots[pageOf[i]! - 1] = piece;
  });
  const paged = joinPages(slots);
  if (!sameText(paged, markdown)) return null;

  // Move each word's offset with its piece.
  const newStarts: number[] = [];
  let at = 0;
  for (let k = 0; k < slots.length; k++) {
    newStarts.push(at);
    at += slots[k]!.length + PAGE_SEPARATOR.length;
  }
  const shift = pieces.map((_, i) => newStarts[pageOf[i]! - 1]! - starts[i]!);
  const moved = textMap.map((seg) =>
    typeof seg.md_offset === "number" ? { ...seg, md_offset: seg.md_offset + shift[pieceAt(seg.md_offset)]! } : seg,
  );
  return { markdown: paged, textMap: moved };
}
