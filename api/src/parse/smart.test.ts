import { describe, it, expect, vi } from "vitest";
import { SmartParseProvider, detectCorruption } from "./smart";
import type { ParseProvider, ParseResponse } from "./provider";

vi.mock("./classify", () => ({
  classifyDocument: vi.fn(),
}));

import { classifyDocument } from "./classify";
const mockClassify = vi.mocked(classifyDocument);

function mockProvider(response: ParseResponse, methods?: Partial<ParseProvider>): ParseProvider {
  return {
    parse: vi.fn().mockResolvedValue(response),
    ...methods,
  };
}

// Realistic-looking markdown — passes the corruption check.
const cleanMarkdown =
  "# Invoice 12345\n\n" +
  "Issued to Acme Corporation on March 15, 2026. Total amount payable within thirty days. " +
  "Line items below detail the services rendered during the billing period from January to March. " +
  "Please remit payment via bank transfer or check made out to our accounts receivable department.";

const digitalResponse: ParseResponse = {
  markdown: cleanMarkdown,
  pages: 3,
  ocr_skipped: true,
  engine: "pdfjs",
};

const scannedResponse: ParseResponse = {
  markdown: "# Scanned PDF\n\nOCR content from a heavy provider with enough words to pass the corruption heuristic threshold of fifty tokens minimum across the whole document body.",
  pages: 5,
  ocr_skipped: false,
  engine: "docling",
};

describe("SmartParseProvider", () => {
  const input = {
    filename: "test.pdf",
    mimeType: "application/pdf",
    fileBuffer: Buffer.from("fake pdf"),
  };

  describe("routing", () => {
    it("routes digital_pdf to lite provider", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(lite.parse).toHaveBeenCalledWith(input);
      expect(heavy.parse).not.toHaveBeenCalled();
      expect(result.engine).toBe("pdfjs");
    });

    it("routes scanned_pdf to heavy provider", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(heavy.parse).toHaveBeenCalledWith(input);
      expect(lite.parse).not.toHaveBeenCalled();
      expect(result.ocr_skipped).toBe(false);
      expect(result.engine).toBe("docling");
    });

    it("routes image to heavy provider", async () => {
      mockClassify.mockResolvedValue("image");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      await smart.parse({ ...input, filename: "scan.jpg", mimeType: "image/jpeg" });

      expect(heavy.parse).toHaveBeenCalled();
      expect(lite.parse).not.toHaveBeenCalled();
    });

    it("routes other (docx, html) to heavy provider — pdfjs is PDF-only", async () => {
      mockClassify.mockResolvedValue("other");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      await smart.parse({ ...input, filename: "report.docx", mimeType: "application/vnd.openxmlformats" });

      expect(heavy.parse).toHaveBeenCalled();
      expect(lite.parse).not.toHaveBeenCalled();
    });
  });

  describe("fallback", () => {
    it("falls back to heavy provider when lite throws", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      const lite: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("InvalidPDFException")),
      };
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(lite.parse).toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalled();
      expect(result.engine).toBe("docling");
    });

    it("falls back to heavy when lite output looks corrupt", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      const corrupt: ParseResponse = {
        // Exact pattern from the Cincinnati CinciPak regression — fragments,
        // single chars, no real words. ~70 tokens; all 1-2 chars long.
        markdown: "M: FRO er: y numb Polic d: io y Per Polic rage a G or d / an bile mo uto t A ep exc es erag v l co Al ECP 035 30 58 EBA 035 30 58 FROM: TO: 10 01 24 27 25 a b c d e f g h i j k l m n o p q r s t u v w x y z",
        pages: 1,
        ocr_skipped: true,
        engine: "pdfjs",
      };
      const lite = mockProvider(corrupt);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(lite.parse).toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalled();
      expect(result.engine).toBe("docling");
    });

    it("does not fall back when lite output is clean", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      await smart.parse(input);

      expect(lite.parse).toHaveBeenCalled();
      expect(heavy.parse).not.toHaveBeenCalled();
    });

    it("does not fall back for scanned — goes directly to heavy", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      const lite: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("should not be called")),
      };
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      await smart.parse(input);

      expect(lite.parse).not.toHaveBeenCalled();
    });
  });

  describe("optional method proxying", () => {
    it("proxies extractCoordinates to heavy provider", async () => {
      const extractResult = { extracted: {}, has_text_layer: true };
      const heavy = mockProvider(scannedResponse, {
        extractCoordinates: vi.fn().mockResolvedValue(extractResult),
      });
      const lite = mockProvider(digitalResponse);
      const smart = new SmartParseProvider(lite, heavy);

      expect(smart.extractCoordinates).toBeDefined();
      const result = await smart.extractCoordinates!({
        fileBuffer: Buffer.alloc(0),
        mappings: {},
      });
      expect(result).toBe(extractResult);
    });

    it("proxies analyzePages to heavy provider", async () => {
      const analysisResult = { pages: 3, data: [] };
      const heavy = mockProvider(scannedResponse, {
        analyzePages: vi.fn().mockResolvedValue(analysisResult),
      });
      const lite = mockProvider(digitalResponse);
      const smart = new SmartParseProvider(lite, heavy);

      expect(smart.analyzePages).toBeDefined();
    });

    it("leaves optional methods undefined when heavy doesnt support them", async () => {
      const heavy = mockProvider(scannedResponse);
      const lite = mockProvider(digitalResponse);
      const smart = new SmartParseProvider(lite, heavy);

      expect(smart.extractCoordinates).toBeUndefined();
      expect(smart.renderRegion).toBeUndefined();
      expect(smart.pageHeaders).toBeUndefined();
      expect(smart.analyzePages).toBeUndefined();
      expect(smart.slicePdf).toBeUndefined();
    });
  });
});

describe("detectCorruption", () => {
  it("returns null for clean prose", () => {
    expect(detectCorruption(cleanMarkdown)).toBeNull();
  });

  it("returns null for short snippets (not enough signal)", () => {
    expect(detectCorruption("a b c d e")).toBeNull();
  });

  it("flags the Cincinnati-style fragmented output", () => {
    const fragmented =
      "M: FRO er: y numb Polic d: io y Per Polic rage a G or d / an bile mo uto t A ep exc es erag v l co Al ECP 035 30 58 EBA 035 30 58 FROM: TO: 10 01 24 27 25 a b c d e f g h i j k l m n o p q r s t u v w x y z";
    expect(detectCorruption(fragmented)).toMatch(/1-2 chars/);
  });

  it("does not flag dense tabular output (numeric columns)", () => {
    // A pure number table — 4-digit codes are fine, the heuristic looks for
    // 1-2 char fragments + low median length.
    const table = Array.from({ length: 80 }, (_, i) => `${1000 + i} ${2000 + i} ${3000 + i}`).join(" ");
    expect(detectCorruption(table)).toBeNull();
  });
});
