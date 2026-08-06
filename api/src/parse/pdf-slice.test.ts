/**
 * probePdf tests (oss-377, oss-488) — page counting for PDFs pdf-lib can and
 * cannot read.
 *
 * Two production failure classes are covered:
 *   - oss-377: owner-password encryption (empty user password) + object-stream
 *     page trees, where pdf-lib throws outright but pdfjs counts fine.
 *   - oss-488: a page tree pdf-lib loads but only partially traverses, so it
 *     returns a short count with NO error. The probe has to catch this by
 *     cross-checking, because nothing about the pdf-lib result looks wrong.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";

import { probePdf, slicePdfPages, reconcilePageCount } from "./pdf-slice";
import {
  ENCRYPTED_OBJSTM_PDF_40,
  ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
  ENCRYPTED_LOADABLE_PDF_20,
} from "./encrypted-pdf.fixture";

async function makePdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/**
 * A PDF that really holds `reachable` pages but whose page tree *declares*
 * `declared` — a stale `/Count`, the benign half of the oss-488 signal.
 *
 * This is the case the probe must escalate on but must NOT act on: `/Count`
 * disagrees with the traversal, so a second opinion is fetched, and pdfjs
 * confirms pdf-lib. The document is genuinely sliceable and must not be sent
 * for a pointless normalize.
 *
 * The malignant half — a traversal that is short because pdf-lib mis-resolved
 * a hybrid-reference (`/XRefStm`) page tree, where pdfjs disagrees and wins —
 * cannot be synthesized without pinning the test to a pdf-lib parsing quirk.
 * It is covered at the decision level in the `reconcilePageCount` block below,
 * using the exact readings taken from the production document.
 */
async function makeStaleCountPdf(reachable: number, declared: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < reachable; i++) doc.addPage([612, 792]);
  doc.catalog.Pages().set(PDFName.of("Count"), PDFNumber.of(declared));
  return Buffer.from(await doc.save());
}

describe("probePdf", () => {
  it("counts a clean PDF via pdf-lib and reports it sliceable and unencrypted", async () => {
    const probe = await probePdf(await makePdf(7), "application/pdf");
    expect(probe).toEqual({ pageCount: 7, pdfLibLoadable: true, encrypted: false, pdfLibPageCount: 7 });
  });

  it("falls back to pdfjs for the encrypted/object-stream PDF pdf-lib can't read", async () => {
    // Sanity: this fixture really is pdf-lib-unreadable — load() resolves but
    // the page tree is invisible (encrypted object streams), so counting
    // throws "Expected instance of PDFDict, but got instance of undefined".
    await expect(
      PDFDocument.load(ENCRYPTED_OBJSTM_PDF_40, { ignoreEncryption: true }).then(
        (d) => d.getPageCount(),
      ),
    ).rejects.toThrow(/PDFDict/);

    const probe = await probePdf(ENCRYPTED_OBJSTM_PDF_40, "application/pdf");
    expect(probe).toEqual({ pageCount: 40, pdfLibLoadable: false, encrypted: true, pdfLibPageCount: null });
  });

  it("reports the normalized (re-saved) fixture as sliceable and unencrypted again", async () => {
    const probe = await probePdf(
      ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
      "application/pdf",
    );
    expect(probe).toEqual({ pageCount: 40, pdfLibLoadable: true, encrypted: false, pdfLibPageCount: 40 });

    // And slicePdfPages actually works on it.
    const slice = await slicePdfPages(ENCRYPTED_OBJSTM_PDF_40_NORMALIZED, 1, 3);
    const sliced = await PDFDocument.load(slice);
    expect(sliced.getPageCount()).toBe(3);
  });

  it("slicePdfPages still throws on the encrypted fixture (why normalize exists)", async () => {
    await expect(slicePdfPages(ENCRYPTED_OBJSTM_PDF_40, 1, 3)).rejects.toThrow();
  });

  it("returns null/unsliceable for non-PDF mime types", async () => {
    expect(await probePdf(Buffer.from("PNG"), "image/png")).toEqual({
      pageCount: null,
      pdfLibLoadable: false,
      encrypted: false,
      pdfLibPageCount: null,
    });
  });

  it("returns null/unsliceable when neither pdf-lib nor pdfjs can read it", async () => {
    expect(await probePdf(Buffer.from("not a pdf"), "application/pdf")).toEqual({
      pageCount: null,
      pdfLibLoadable: false,
      encrypted: false,
      pdfLibPageCount: null,
    });
  });

  it("flags an encrypted-but-loadable PDF (empty user password, no object streams)", async () => {
    // The production trap (oss-448): pdf-lib CAN load this PDF's page tree
    // (it's not in compressed object streams), so `pdfLibLoadable` is true — but
    // it is encrypted, so slicing it copies still-encrypted content streams into
    // an unencrypted output and Doc AI receives blank pages. probePdf must flag
    // it so google-docai decrypts before slicing.
    const probe = await probePdf(ENCRYPTED_LOADABLE_PDF_20, "application/pdf");
    expect(probe).toEqual({ pageCount: 20, pdfLibLoadable: true, encrypted: true, pdfLibPageCount: 20 });
  });

  it("does not normalize a sliceable PDF just because /Count is stale (oss-488)", async () => {
    // `/Count` claims 76, the tree really holds 11, and pdfjs agrees with the
    // tree. The declaration alone must not condemn a perfectly sliceable file:
    // acting on it would send every stale-/Count document through a needless
    // parse-service round-trip.
    const probe = await probePdf(await makeStaleCountPdf(11, 76), "application/pdf");
    expect(probe).toEqual({
      pageCount: 11,
      pdfLibLoadable: true,
      encrypted: false,
      pdfLibPageCount: 11,
    });
  });
});

describe("reconcilePageCount — which reading wins (oss-488)", () => {
  it("takes pdfjs over a short pdf-lib traversal: the production failure", () => {
    // The exact readings from the document that caused the outage: a 76-page
    // policy pdf-lib walked only 11 pages of, with no error. Trusting pdf-lib
    // routed it to a single online Doc AI call (11 <= 15) that Doc AI rejected
    // with PAGE_LIMIT_EXCEEDED — and slicing pdf-lib's view would have been
    // worse, keeping 19,875 of the document's 179,112 characters.
    expect(reconcilePageCount({ traversed: 11, declared: 76, viaPdfjs: 76 })).toBe(76);
  });

  it("lets pdfjs clear a stale /Count instead of over-counting", () => {
    // Two real readers agree the document holds 11 pages; only the declaration
    // says otherwise. Believing `/Count` here would force a pointless normalize.
    expect(reconcilePageCount({ traversed: 11, declared: 76, viaPdfjs: 11 })).toBe(11);
  });

  it("falls back to /Count when no second reader is available", () => {
    // pdfjs unavailable and the traversal is short of the document's own claim.
    // Prefer the larger: an over-estimate costs a wasted normalize + recount,
    // an under-estimate silently drops pages from the parse.
    expect(reconcilePageCount({ traversed: 11, declared: 76, viaPdfjs: null })).toBe(76);
  });

  it("never lets a lower second opinion shrink the count below what pdf-lib walked", () => {
    // pdf-lib reached 40 pages, so at least 40 exist regardless of what any
    // other reader claims — a slice plan must not be built for fewer.
    expect(reconcilePageCount({ traversed: 40, declared: 12, viaPdfjs: 12 })).toBe(40);
    expect(reconcilePageCount({ traversed: 40, declared: null, viaPdfjs: null })).toBe(40);
  });

  it("agrees with the common case in one reading", () => {
    expect(reconcilePageCount({ traversed: 7, declared: 7, viaPdfjs: null })).toBe(7);
  });

  it("returns null when every reading is empty", () => {
    expect(reconcilePageCount({ traversed: 0, declared: null, viaPdfjs: null })).toBeNull();
    expect(reconcilePageCount({ traversed: 0, declared: 0, viaPdfjs: 0 })).toBeNull();
  });
});
