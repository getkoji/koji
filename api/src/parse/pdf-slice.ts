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

import { loadPdfjs } from "./pdfjs-loader";

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

/** What {@link probePdf} learned about a PDF buffer. */
export interface PdfProbeResult {
  /**
   * Best-effort page count: pdf-lib's when it can load the document, pdfjs's
   * when it can't, null when neither can read it (or the mime isn't PDF).
   */
  pageCount: number | null;
  /**
   * Whether pdf-lib could load the document — i.e. whether
   * {@link slicePdfPages} will work on these bytes. False for the documents
   * pdf-lib can't read: the common real-world case is owner-password
   * encryption (empty user password) combined with a page tree stored in
   * compressed object streams — `ignoreEncryption` skips decryption rather
   * than performing it, so the encrypted object streams never inflate and the
   * page tree is invisible. pdfjs decrypts that case properly, which is why
   * `pageCount` can be known while this is false.
   */
  pdfLibLoadable: boolean;
}

/**
 * Probe a PDF buffer for page count and local (pdf-lib) sliceability.
 *
 * pdf-lib first — when it loads, its count is authoritative for slicing.
 * When it throws, fall back to pdfjs for the count alone: callers then know
 * the document's true size but must normalize the bytes (see
 * `pdf-normalize.ts`) before any pdf-lib slicing can succeed.
 */
export async function probePdf(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<PdfProbeResult> {
  if (!/pdf/i.test(mimeType)) return { pageCount: null, pdfLibLoadable: false };

  try {
    const doc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    return { pageCount: doc.getPageCount(), pdfLibLoadable: true };
  } catch {
    // fall through to pdfjs
  }

  try {
    const pdfjsLib = await loadPdfjs();
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      verbosity: 0,
    }).promise;
    const pageCount = doc.numPages;
    await doc.destroy();
    return { pageCount, pdfLibLoadable: false };
  } catch {
    return { pageCount: null, pdfLibLoadable: false };
  }
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
