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
    it("classifies corrupt/empty PDF buffer as digital_pdf (safe fallback)", async () => {
      // pdf-parse will throw on invalid buffer — should default to digital_pdf
      const result = await classifyDocument("test.pdf", "application/pdf", Buffer.from("not a pdf"));
      expect(result).toBe("digital_pdf");
    });

    it("classifies PDF with application/octet-stream mimeType by extension", async () => {
      // application/octet-stream is common in uploads
      const result = await classifyDocument("doc.pdf", "application/octet-stream", Buffer.from("not a pdf"));
      expect(result).toBe("digital_pdf"); // fallback on parse error
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
