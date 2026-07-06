/**
 * probePdf tests (oss-377) — page counting for PDFs pdf-lib can and cannot
 * read. The encrypted fixtures reproduce the production failure class:
 * owner-password encryption (empty user password) + object-stream page trees,
 * where pdf-lib throws but pdfjs counts fine.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";

import { probePdf, slicePdfPages } from "./pdf-slice";
import {
  ENCRYPTED_OBJSTM_PDF_40,
  ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
} from "./encrypted-pdf.fixture";

async function makePdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe("probePdf", () => {
  it("counts a clean PDF via pdf-lib and reports it sliceable", async () => {
    const probe = await probePdf(await makePdf(7), "application/pdf");
    expect(probe).toEqual({ pageCount: 7, pdfLibLoadable: true });
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
    expect(probe).toEqual({ pageCount: 40, pdfLibLoadable: false });
  });

  it("reports the normalized (re-saved) fixture as sliceable again", async () => {
    const probe = await probePdf(
      ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
      "application/pdf",
    );
    expect(probe).toEqual({ pageCount: 40, pdfLibLoadable: true });

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
    });
  });

  it("returns null/unsliceable when neither pdf-lib nor pdfjs can read it", async () => {
    expect(await probePdf(Buffer.from("not a pdf"), "application/pdf")).toEqual({
      pageCount: null,
      pdfLibLoadable: false,
    });
  });
});
