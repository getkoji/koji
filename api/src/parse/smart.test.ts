import { describe, it, expect, vi } from "vitest";
import { SmartParseProvider } from "./smart";
import type { ParseProvider, ParseResponse } from "./provider";

// Mock the classify module
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

const digitalResponse: ParseResponse = {
  markdown: "# Digital PDF\n\nContent here.",
  pages: 3,
  ocr_skipped: true,
};

const scannedResponse: ParseResponse = {
  markdown: "# Scanned PDF\n\nOCR content.",
  pages: 5,
  ocr_skipped: false,
  searchable_pdf_base64: "base64data",
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
      expect(result.markdown).toBe("# Digital PDF\n\nContent here.");
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

    it("routes other (docx, html) to lite provider", async () => {
      mockClassify.mockResolvedValue("other");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      await smart.parse({ ...input, filename: "report.docx", mimeType: "application/vnd.openxmlformats" });

      expect(lite.parse).toHaveBeenCalled();
      expect(heavy.parse).not.toHaveBeenCalled();
    });
  });

  describe("fallback", () => {
    it("falls back to heavy provider when lite throws", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      const lite: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("LiteParse binary not found")),
      };
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(lite.parse).toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalled();
      expect(result.markdown).toBe("# Scanned PDF\n\nOCR content.");
    });

    it("does not fall back for scanned — goes directly to heavy", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      const lite: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("should not be called")),
      };
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(lite.parse).not.toHaveBeenCalled();
      expect(result.markdown).toContain("OCR content");
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
      const heavy = mockProvider(scannedResponse); // no optional methods
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
