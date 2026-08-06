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
   * Best-effort TRUE page count, reconciled across up to three readings of the
   * document — see {@link reconcilePageCount}. Null when nothing could read it
   * (or the mime isn't PDF).
   */
  pageCount: number | null;
  /**
   * Whether {@link slicePdfPages} can carve these bytes **faithfully** — pdf-lib
   * both loads the document AND reaches every page. False in two distinct
   * cases, which callers handle identically (normalize via `pdf-normalize.ts`,
   * then re-probe):
   *
   * 1. **pdf-lib can't load it at all.** Owner-password encryption (empty user
   *    password) with a page tree in compressed object streams —
   *    `ignoreEncryption` skips decryption rather than performing it, so the
   *    object streams never inflate and the page tree is invisible (oss-377).
   * 2. **pdf-lib loads it but its page tree is incomplete** (oss-488). Hybrid-
   *    reference PDFs (a classic xref table plus an `/XRefStm` pointing at an
   *    xref stream) resolve some object numbers to the wrong objects under
   *    pdf-lib — nested `/Pages` kids come back as `/StructElem`, arrays, or
   *    nothing. pdf-lib's traversal silently skips what it can't interpret and
   *    returns a short count with NO error. Observed in production: a 76-page
   *    policy where `getPageCount()` returned 11 and a full
   *    `copyPages(getPageIndices())` round-trip preserved 19,875 of 179,112
   *    characters. Slicing that view is worse than failing — it yields a
   *    plausible parse that is missing 86% of the document.
   *
   * pdfjs decrypts and resolves both cases correctly, which is why
   * `pageCount` can be known while this is false.
   */
  pdfLibLoadable: boolean;
  /**
   * Whether the PDF declares a Standard security handler (`/Encrypt`). True even
   * for the ubiquitous owner-password / empty-user-password pattern that
   * carriers and law firms ship (readable without a password, but restricted).
   *
   * This matters independently of {@link pdfLibLoadable}: pdf-lib can *load* an
   * encrypted PDF whose page tree is NOT in compressed object streams (so
   * `pdfLibLoadable` is true), but {@link slicePdfPages} copies the still-
   * encrypted content streams into an unencrypted output — RC4/AES ciphertext
   * read as plaintext, i.e. garbage — so the sliced pages carry no extractable
   * text. Callers must decrypt (re-save via the parse service, see
   * `pdf-normalize.ts`) before slicing whenever this is true.
   */
  encrypted: boolean;
  /**
   * How many pages pdf-lib's own traversal reached, or null when pdf-lib
   * couldn't load the document. Diagnostic only — below {@link pageCount}
   * exactly when {@link pdfLibLoadable} is false for reason (2) above, which
   * is worth logging because it is otherwise completely silent.
   */
  pdfLibPageCount: number | null;
}

/**
 * The page count the document's own page tree declares (`/Pages` → `/Count`),
 * independent of whether pdf-lib can walk to every leaf. Free to read — the
 * document is already parsed — and it is the cheapest signal that a traversal
 * came up short. Null when the catalog is malformed enough that even this
 * can't be read.
 */
function declaredPageCount(doc: PDFDocument): number | null {
  try {
    const n = doc.catalog.Pages().Count().asNumber();
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Page count according to pdfjs — the independent second opinion. pdfjs
 * decrypts properly and resolves hybrid-reference (`/XRefStm`) files that
 * defeat pdf-lib, so it is the tie-breaker whenever the two disagree.
 *
 * Cheap enough to run unconditionally: measured at ~6ms on a 4.5MB/76-page
 * PDF against ~184ms for pdf-lib's own `load()`, and `loadPdfjs()` memoises
 * the (heavy) module import process-wide. Returns null rather than throwing —
 * a missing second opinion must never fail a probe that otherwise succeeded.
 */
async function pdfjsPageCount(fileBuffer: Buffer): Promise<number | null> {
  try {
    const pdfjsLib = await loadPdfjs();
    // `new Uint8Array(buf)` copies, so pdfjs can't detach the caller's Buffer.
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      verbosity: 0,
    }).promise;
    const pageCount = doc.numPages;
    await doc.destroy();
    return Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null;
  } catch {
    return null;
  }
}

/**
 * Settle the true page count from up to three readings of the same document.
 *
 * The three are not equally trustworthy, and the ordering matters:
 *
 *   - `traversed` — pdf-lib actually walking the page tree. The only reading
 *     that reflects what {@link slicePdfPages} can copy, but it fails *silently
 *     short* on the documents this function exists for.
 *   - `viaPdfjs` — an independent reader that resolves the encrypted and
 *     hybrid-xref structures pdf-lib mishandles. When present it **settles** the
 *     question: two real readers beat a declaration.
 *   - `declared` — the page tree's own `/Count`. A claim, not a reading; it can
 *     be stale in a hand-edited or incrementally-updated file. Used as a count
 *     only when no second reader is available, on the principle that
 *     undercounting is the dangerous direction — an over-estimate costs one
 *     wasted normalize + recount, an under-estimate silently drops pages.
 *
 * Exported for testing: this is the decision the outage turned on, and it is
 * worth pinning independently of any particular PDF's byte layout.
 */
export function reconcilePageCount(readings: {
  traversed: number;
  declared: number | null;
  viaPdfjs: number | null;
}): number | null {
  const { traversed, declared, viaPdfjs } = readings;
  const best =
    viaPdfjs !== null
      ? Math.max(traversed, viaPdfjs)
      : Math.max(traversed, declared ?? 0);
  return best > 0 ? best : null;
}

/**
 * Probe a PDF buffer for its true page count and for whether pdf-lib can slice
 * it faithfully.
 *
 * **A successful `PDFDocument.load` is not enough** (oss-488). pdf-lib reports
 * no error when its page-tree traversal comes up short, so a load-and-count is
 * indistinguishable from a load-and-undercount. Three readings are taken and
 * cross-checked:
 *
 *   - pdf-lib's traversal — the only one that reflects what `slicePdfPages`
 *     will actually be able to copy;
 *   - the page tree's declared `/Count` — free, from the same parse;
 *   - pdfjs — independent, and correct on the encrypted and hybrid-xref files
 *     that defeat pdf-lib.
 *
 * `pageCount` is the largest of the three. `pdfLibLoadable` is true only when
 * pdf-lib's own traversal reached that many pages, so any shortfall routes the
 * caller through normalization instead of a lossy slice.
 *
 * When pdf-lib can't load the bytes at all, pdfjs supplies the count alone:
 * callers then know the document's true size but must normalize (see
 * `pdf-normalize.ts`) before any pdf-lib slicing can succeed.
 */
export async function probePdf(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<PdfProbeResult> {
  if (!/pdf/i.test(mimeType))
    return { pageCount: null, pdfLibLoadable: false, encrypted: false, pdfLibPageCount: null };

  // Load AND traverse inside one try. `PDFDocument.load` succeeding proves
  // nothing on its own: the encrypted/object-stream class (oss-377) loads
  // cleanly and then throws from `getPageCount()`, because the page tree only
  // materializes when it is walked. Splitting the two would let that throw
  // escape the probe instead of falling through to pdfjs.
  let pdfLib: { traversed: number; declared: number | null; encrypted: boolean } | null = null;
  try {
    const doc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    pdfLib = {
      traversed: doc.getPageCount(),
      declared: declaredPageCount(doc),
      encrypted: doc.isEncrypted,
    };
  } catch {
    pdfLib = null; // fall through to the pdfjs-only path below
  }

  if (pdfLib) {
    const { traversed, declared } = pdfLib;
    // Pay for the independent reading only when the document is already
    // suspicious: its own `/Count` contradicts the traversal, or the catalog is
    // malformed enough that `/Count` can't be read. A `/Count` that agrees with
    // the traversal leaves a third opinion nothing to add, so the overwhelming
    // majority of documents stay at a single parse.
    //
    // The residual case — traversal AND `/Count` both short — would still slip
    // through here. That is the backstop's job: `google-docai.ts` catches Doc
    // AI's own PAGE_LIMIT_EXCEEDED and re-routes on the count Doc AI reports.
    const needsSecondOpinion = declared === null || declared > traversed;
    const viaPdfjs = needsSecondOpinion ? await pdfjsPageCount(fileBuffer) : null;

    const pageCount = reconcilePageCount({ traversed, declared, viaPdfjs });
    if (pageCount !== null && pageCount > traversed) {
      console.warn(
        `[pdf-slice] pdf-lib reached only ${traversed} of ${pageCount} pages ` +
          `(declared /Count ${declared ?? "?"}, pdfjs ${viaPdfjs ?? "?"}) — its page tree is ` +
          `incomplete, so these bytes cannot be sliced faithfully and must be normalized first.`,
      );
    }
    return {
      pageCount,
      pdfLibLoadable: pageCount !== null && traversed >= pageCount,
      encrypted: pdfLib.encrypted,
      pdfLibPageCount: traversed,
    };
  }

  // pdf-lib couldn't load the bytes — the common cause is exactly encryption
  // (an object-stream page tree that `ignoreEncryption` never inflates), so this
  // path is treated as encrypted-until-proven-otherwise: callers already
  // normalize when `pdfLibLoadable` is false, and marking it encrypted keeps
  // the decrypt-before-slice contract consistent.
  const viaPdfjs = await pdfjsPageCount(fileBuffer);
  if (viaPdfjs !== null) {
    return {
      pageCount: viaPdfjs,
      pdfLibLoadable: false,
      encrypted: true,
      pdfLibPageCount: null,
    };
  }

  // Neither library could read the bytes (corrupt / not really a PDF). Not
  // meaningfully "encrypted" — and unused anyway, since the decrypt-before-
  // slice path only fires when a page count is known.
  return { pageCount: null, pdfLibLoadable: false, encrypted: false, pdfLibPageCount: null };
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
