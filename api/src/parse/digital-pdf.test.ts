import { describe, it, expect } from "vitest";
import { DigitalPdfProvider } from "./digital-pdf";

/** Build a single-page PDF with an embedded text layer. */
async function makeDigitalPdf(lines: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font });
    y -= 20;
  }
  return Buffer.from(await pdf.save());
}

describe("DigitalPdfProvider", () => {
  it("extracts text from a digital PDF via pdfjs (no DOMMatrix crash)", async () => {
    // Regression for oss-300: pdfjs's Node build references DOMMatrix at import
    // time. If the serverless-safe polyfill (pdfjs-loader) regresses, this
    // throws "DOMMatrix is not defined" instead of extracting text.
    const buf = await makeDigitalPdf([
      "Invoice total due on receipt.",
      "Account number 12345 — thank you for your business.",
    ]);

    const provider = new DigitalPdfProvider();
    const result = await provider.parse({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });

    expect(result.engine).toBe("pdfjs");
    expect(result.pages).toBe(1);
    expect(result.ocr_skipped).toBe(true);
    expect(result.markdown).toContain("Invoice total due on receipt");
    expect(result.markdown).toContain("Account number 12345");
    expect(result.text_map?.length ?? 0).toBeGreaterThan(0);
  });

  it("emits text_map in the canonical normalized [0,1] top-left convention", async () => {
    // Text is drawn near the TOP of the page (y=720 of 792 in PDF bottom-left
    // user space). A correct flip to top-left origin makes the normalized y
    // SMALL (~0.09), proving the y-axis is flipped and coords are normalized.
    const buf = await makeDigitalPdf(["Top line", "Second line"]);
    const provider = new DigitalPdfProvider();
    const result = await provider.parse({
      filename: "coords.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });

    const segs = result.text_map ?? [];
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(s.page).toBe(1); // 1-indexed
      for (const v of [s.x, s.y, s.w, s.h]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(s.x + s.w).toBeLessThanOrEqual(1 + 1e-6);
      expect(s.y + s.h).toBeLessThanOrEqual(1 + 1e-6);
    }
    // First word ("Top") sits in the top ~15% of the page under a top-left origin.
    const top = segs.find((s) => s.text.includes("Top"));
    expect(top).toBeDefined();
    expect(top!.y).toBeLessThan(0.15);
  });

  it("stamps md_offset/md_length that slice back to each word in the markdown", async () => {
    // L3 deterministic provenance: every text_map segment the serializer placed
    // must point at its own text in the emitted markdown, so provenance can
    // resolve bboxes by offset instead of fuzzy matching.
    const buf = await makeDigitalPdf([
      "Invoice total due on receipt.",
      "Account number 12345 — thank you for your business.",
    ]);

    const provider = new DigitalPdfProvider();
    const result = await provider.parse({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });

    const md = result.markdown;
    const segs = result.text_map ?? [];
    const annotated = segs.filter((s) => s.md_offset != null);
    // The overwhelming majority of digital words should carry offsets.
    expect(annotated.length).toBeGreaterThan(0);

    // Each annotated segment slices back to its own text at its offset.
    for (const s of annotated) {
      expect(md.slice(s.md_offset!, s.md_offset! + s.md_length!)).toBe(s.text);
    }

    // A value-bearing token (however pdfjs tokenized the run) is annotated and
    // its offset slices back to that token's exact text.
    const acct = annotated.find((s) => s.text.includes("12345"));
    expect(acct).toBeDefined();
    expect(md.slice(acct!.md_offset!, acct!.md_offset! + acct!.md_length!)).toBe(acct!.text);
  });

  it("rejects non-PDF input with a clear error", async () => {
    const provider = new DigitalPdfProvider();
    await expect(
      provider.parse({
        filename: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileBuffer: Buffer.from("x"),
      }),
    ).rejects.toThrow(/only handles PDFs/);
  });
});
