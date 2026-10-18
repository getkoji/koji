/**
 * The page contract of parse markdown.
 *
 * Every parse returns ONE shape: the markdown of a document with N pages is N
 * page pieces joined by {@link PAGE_SEPARATOR}, piece i being page i. A page
 * with no text is an empty piece — it still holds its place, so the k-th piece
 * is always page k (citations, page estimation, and splitting a bundle by page
 * all count pieces). A one-page document has no separator.
 *
 * Before this contract, only the in-process digital path (pdfjs) marked pages;
 * every OCR path (Google Document AI, Textract, Mistral, Azure, vision OCR)
 * joined pages with a blank line, so a scanned or OCR-routed multi-page
 * document came back as one block of text and every citation landed on page 1.
 */

/** The page break between two pages of parse markdown. */
export const PAGE_SEPARATOR = "\n\n---\n\n";

/**
 * Join per-page markdown into one document. Page text is kept byte for byte;
 * empty pages keep their slot. The result is never trimmed as a whole — a
 * leading empty page is a leading separator. When no page has text the result
 * is the empty string.
 */
export function joinPages(pages: readonly string[]): string {
  const texts = pages.map((p) => p ?? "");
  // A document with no text at all has empty markdown, not a run of page
  // breaks — callers test `markdown.trim()` for "nothing was read".
  if (texts.every((p) => p.trim().length === 0)) return "";
  return texts.join(PAGE_SEPARATOR);
}

/** Split parse markdown back into its pages (the inverse of {@link joinPages}). */
export function splitPages(markdown: string): string[] {
  return markdown.split(PAGE_SEPARATOR);
}

/**
 * Group page-numbered pieces of text into pages 1..pageCount and join them.
 * `pageCount` defaults to the highest page seen; pieces on a page beyond it
 * still land on their own page (the count grows rather than dropping text).
 * Pieces on the same page are joined with a blank line, in the given order.
 */
export function pagesFromPieces(
  pieces: ReadonlyArray<{ page: number; text: string }>,
  pageCount?: number | null,
): string {
  let max = pageCount && pageCount > 0 ? Math.floor(pageCount) : 0;
  for (const p of pieces) if (p.page > max) max = p.page;
  if (max <= 0) return "";
  const pages: string[][] = Array.from({ length: max }, () => []);
  for (const p of pieces) {
    const idx = Math.max(1, Math.floor(p.page)) - 1;
    pages[idx]!.push(p.text);
  }
  return joinPages(pages.map((blocks) => blocks.join("\n\n")));
}

/**
 * The markdown with its page breaks removed and empty pages dropped — the
 * pre-contract shape. Used to prove a re-paged markdown carries exactly the
 * text of an unpaged one.
 */
export function withoutPageBreaks(markdown: string): string {
  return splitPages(markdown)
    .filter((p) => p.trim().length > 0)
    .join("\n\n");
}
