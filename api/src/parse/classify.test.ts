import { describe, it, expect } from "vitest";
import { classifyDocument, type DocumentType } from "./classify";

describe("classifyDocument", () => {
  describe("image detection", () => {
    it("detects image by mimeType", async () => {
      expect(await classifyDocument("photo.jpg", "image/jpeg", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("scan.png", "image/png", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("doc.tiff", "image/tiff", Buffer.alloc(0))).toBe("image");
    });

    it("detects image by extension when mimeType is generic", async () => {
      expect(await classifyDocument("photo.jpg", "application/octet-stream", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("scan.png", "application/octet-stream", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("page.tif", "application/octet-stream", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("photo.webp", "application/octet-stream", Buffer.alloc(0))).toBe("image");
      expect(await classifyDocument("photo.bmp", "application/octet-stream", Buffer.alloc(0))).toBe("image");
    });
  });

  describe("non-PDF non-image detection", () => {
    it("classifies docx as other", async () => {
      expect(await classifyDocument("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.alloc(0))).toBe("other");
    });

    it("classifies html as other", async () => {
      expect(await classifyDocument("page.html", "text/html", Buffer.alloc(0))).toBe("other");
    });

    it("classifies pptx as other", async () => {
      expect(await classifyDocument("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", Buffer.alloc(0))).toBe("other");
    });
  });

  describe("PDF classification", () => {
    it("classifies corrupt/unparseable PDF buffer as scanned_pdf (conservative → heavy)", async () => {
      // pdfjs throws on an invalid buffer — "can't tell" must route to the
      // heavy provider (reads both scanned and digital), NEVER pdfjs, which on
      // a real scan would yield empty markdown. See classify.ts catch (oss-301).
      const result = await classifyDocument("test.pdf", "application/pdf", Buffer.from("not a pdf"));
      expect(result).toBe("scanned_pdf");
    });

    it("classifies unparseable application/octet-stream PDF as scanned_pdf by extension", async () => {
      // application/octet-stream is common in uploads
      const result = await classifyDocument("doc.pdf", "application/octet-stream", Buffer.from("not a pdf"));
      expect(result).toBe("scanned_pdf"); // conservative fallback on parse error
    });

    it("classifies a digital PDF with a text layer as digital_pdf (pdfjs, no DOMMatrix crash)", async () => {
      const buf = await makeDigitalPdf(
        "This is a digital PDF with a real, extractable text layer. " +
          "It carries well over fifty characters so the heuristic reads digital.",
      );
      const result = await classifyDocument("digital.pdf", "application/pdf", buf);
      expect(result).toBe("digital_pdf");
    });

    it("classifies an image-only / no-text-layer PDF as scanned_pdf (→ heavy)", async () => {
      const buf = await makeImageOnlyPdf();
      const result = await classifyDocument("scan.pdf", "application/pdf", buf);
      expect(result).toBe("scanned_pdf");
    });
  });

  describe("routing implications", () => {
    it("image always routes to heavy provider", async () => {
      const type = await classifyDocument("scan.jpg", "image/jpeg", Buffer.alloc(0));
      expect(type === "image").toBe(true);
    });

    it("other (docx etc) routes to lite provider", async () => {
      const type = await classifyDocument("doc.docx", "application/vnd.openxmlformats", Buffer.alloc(0));
      expect(type === "other").toBe(true);
    });
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Build a single-page PDF with an embedded text layer. */
async function makeDigitalPdf(text: string): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 12, font, maxWidth: 500 });
  return Buffer.from(await pdf.save());
}

/**
 * Build a single-page PDF with NO text layer — a vector rectangle only, the
 * digital analogue of an image-only scan (zero extractable characters).
 */
async function makeImageOnlyPdf(): Promise<Buffer> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawRectangle({ x: 50, y: 50, width: 500, height: 700, color: rgb(0.5, 0.5, 0.5) });
  return Buffer.from(await pdf.save());
}
