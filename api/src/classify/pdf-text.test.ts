import { describe, it, expect } from "vitest";
import { readPdfWindow } from "./pdf-text";
import { runCascade } from "./cascade";
import { normalizeConfig } from "./config";

/** Build a multi-page digital PDF; each page gets its own lines. */
async function makePdf(pages: string[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    let y = 720;
    for (const line of lines) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 20;
    }
  }
  return Buffer.from(await pdf.save());
}

describe("readPdfWindow (real pdfjs)", () => {
  it("extracts text for only the head window", async () => {
    const buf = await makePdf([
      ["Page one content alpha"],
      ["Page two content bravo"],
      ["Page three content charlie"],
    ]);
    const { totalPages, pages } = await readPdfWindow(buf, 2, "head");
    expect(totalPages).toBe(3);
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0].text).toContain("alpha");
    expect(pages[1].text).toContain("bravo");
  });

  it("extracts head and tail pages for head_and_tail", async () => {
    const buf = await makePdf([["alpha"], ["bravo"], ["charlie"], ["delta"]]);
    const { pages } = await readPdfWindow(buf, 2, "head_and_tail");
    expect(pages.map((p) => p.page)).toEqual([1, 4]);
    expect(pages[1].text).toContain("delta");
  });

  it("returns no pages for a non-PDF buffer", async () => {
    const { totalPages, pages } = await readPdfWindow(Buffer.from("not a pdf"), 3, "head");
    expect(totalPages).toBe(0);
    expect(pages).toEqual([]);
  });
});

describe("cascade over a real PDF (deterministic path, no model)", () => {
  it("classifies via the free tiers with a cover page stapled on top", async () => {
    // Page 1 is a sparse routing slip; the real invoice is on page 2.
    const buf = await makePdf([
      ["ROUTING SLIP", "please deliver"],
      [
        "INVOICE 00042",
        "amount due 1200.00",
        "remit to Acme Supply Co",
        "net 30 terms",
      ],
    ]);
    const config = normalizeConfig({
      classes: {
        invoice: { keywords: ["invoice", "amount due", "remit to"] },
        policy: { keywords: ["declarations", "insuring agreement"] },
      },
    });
    // No provider / renderer: only Tiers 0–2 can run. This proves the free
    // deterministic path works end-to-end on real pdfjs output.
    const out = await runCascade(
      { filename: "packet.pdf", mimeType: "application/pdf", fileBuffer: buf },
      config,
    );
    expect(out.label).toBe("invoice");
    expect(out.method).toBe("keyword");
    expect(out.tierUsed).toBe(2);
    expect(out.evidencePage).toBe(2); // the real doc, not the routing slip
  });
});
