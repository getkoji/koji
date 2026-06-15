/**
 * Unit tests for `pickDocumentRenderer`.
 *
 * The picker is the part of DocumentViewer that decides whether to mount
 * PdfViewer, an `<img>`, or the unsupported fallback. Keep this in lockstep
 * with the type matrix in the function's docstring — every branch here is
 * load-bearing for the review queue's document preview.
 */

import { describe, it, expect } from "vitest";
import { pickDocumentRenderer } from "./DocumentViewer";

const URL = "/api/jobs/some-slug/documents/some-doc/preview?token=abc";

describe("pickDocumentRenderer", () => {
  describe("PDF routing", () => {
    it("renders application/pdf as pdf", () => {
      expect(pickDocumentRenderer("application/pdf", URL)).toBe("pdf");
    });

    it("renders application/x-pdf as pdf", () => {
      expect(pickDocumentRenderer("application/x-pdf", URL)).toBe("pdf");
    });

    it("renders null MIME as pdf (most likely a PDF in this codebase)", () => {
      expect(pickDocumentRenderer(null, URL)).toBe("pdf");
    });
  });

  describe("octet-stream routing (the regression that motivated this)", () => {
    it("renders application/octet-stream as pdf — most uploads land with this MIME", () => {
      expect(pickDocumentRenderer("application/octet-stream", URL)).toBe("pdf");
    });

    it("renders binary/octet-stream as pdf — the legacy alias S3 sometimes serves", () => {
      expect(pickDocumentRenderer("binary/octet-stream", URL)).toBe("pdf");
    });
  });

  describe("image routing", () => {
    it("renders image/png as image", () => {
      expect(pickDocumentRenderer("image/png", URL)).toBe("image");
    });

    it("renders image/jpeg as image", () => {
      expect(pickDocumentRenderer("image/jpeg", URL)).toBe("image");
    });

    it("renders image/webp as image", () => {
      expect(pickDocumentRenderer("image/webp", URL)).toBe("image");
    });

    it("renders image/tiff as image", () => {
      expect(pickDocumentRenderer("image/tiff", URL)).toBe("image");
    });

    it("renders any image/* subtype as image (forward-compat)", () => {
      expect(pickDocumentRenderer("image/avif", URL)).toBe("image");
      expect(pickDocumentRenderer("image/heic", URL)).toBe("image");
    });
  });

  describe("unsupported routing", () => {
    it("renders text/plain as unsupported (the PDF viewer can't handle it)", () => {
      expect(pickDocumentRenderer("text/plain", URL)).toBe("unsupported");
    });

    it("renders text/html as unsupported", () => {
      expect(pickDocumentRenderer("text/html", URL)).toBe("unsupported");
    });

    it("renders application/json as unsupported", () => {
      expect(pickDocumentRenderer("application/json", URL)).toBe("unsupported");
    });

    it("renders unknown application subtypes as unsupported (no guessing past octet-stream)", () => {
      expect(pickDocumentRenderer("application/zip", URL)).toBe("unsupported");
      expect(pickDocumentRenderer("application/vnd.ms-excel", URL)).toBe("unsupported");
    });
  });

  describe("URL guard", () => {
    it("returns unsupported when url is null even for a known PDF MIME", () => {
      expect(pickDocumentRenderer("application/pdf", null)).toBe("unsupported");
    });

    it("returns unsupported when url is null and MIME is null", () => {
      expect(pickDocumentRenderer(null, null)).toBe("unsupported");
    });
  });
});
