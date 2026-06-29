/**
 * Shared PDF page-slicing + bounded-concurrency helpers.
 *
 * Extracted from `chunked.ts` so the chunked-parse provider and the BYO-parse
 * drivers (Google Doc AI's slice→parallel→merge path) share ONE slicer rather
 * than each carrying its own pdf-lib page-extraction copy. Slicing at page
 * boundaries is quality-neutral for page-local OCR and lets a large document be
 * fanned out across several smaller parse calls.
 */

import { PDFDocument } from "pdf-lib";

/**
 * Slice a 1-indexed, inclusive page range `[startPage, endPage]` out of a PDF
 * into a new single-purpose PDF buffer, using pdf-lib locally.
 *
 * `ignoreEncryption: true` is important: many customer PDFs ship with an
 * owner-password / no-print restriction dictionary but no real content
 * encryption (insurance carriers and law firms do this routinely). pdf-lib
 * refuses to load them by default; with the flag set the page tree is still
 * readable. The resulting PDF is renumbered from page 1 (it's a fresh document),
 * so callers that need global page numbers must track the source offset
 * themselves.
 *
 * Throws when the PDF can't be loaded or the range can't be copied (e.g. a
 * corrupt cross-reference table) — callers decide whether to fall back to a
 * whole-document parse or surface the failure.
 */
export async function slicePdfPages(
  fileBuffer: Buffer,
  startPage: number,
  endPage: number,
): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();
  const indices: number[] = [];
  for (let i = startPage - 1; i < endPage; i++) indices.push(i);
  const pages = await newDoc.copyPages(srcDoc, indices);
  for (const page of pages) newDoc.addPage(page);
  return Buffer.from(await newDoc.save());
}

/**
 * Map `fn` over `items` with at most `concurrency` calls in flight at once,
 * preserving input order in the result array. A worker pool pulls the next
 * index until the list is drained — bounded parallelism without a dependency.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]!, idx);
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: poolSize }, () => worker());
  await Promise.all(workers);
  return results;
}
