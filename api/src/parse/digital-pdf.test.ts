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
