import { describe, it, expect, vi, beforeEach } from "vitest";
import { SmartParseProvider, detectCorruption } from "./smart";
import type { ParseProvider, ParseResponse } from "./provider";

vi.mock("./classify", () => ({
  classifyDocument: vi.fn(),
}));
vi.mock("./content-shape", () => ({
  classifyContentShape: vi.fn(),
}));

import { classifyDocument } from "./classify";
import { classifyContentShape } from "./content-shape";
const mockClassify = vi.mocked(classifyDocument);
const mockShape = vi.mocked(classifyContentShape);

beforeEach(() => {
  vi.clearAllMocks();
  // Safe default for content-shape so the existing two-arg routing tests never
  // touch the (unconfigured) structured path even if it were consulted.
  mockShape.mockResolvedValue("text_heavy");
});

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

  // ── PB-10 doc-type routing ────────────────────────────────────────────────
  describe("doc-type routing (structured provider)", () => {
    const structuredResponse: ParseResponse = {
      markdown: "# Structured\n\nrow/col preserving output from a structured provider.",
      pages: 2,
      ocr_skipped: false,
      engine: "docling",
      chunks: [],
    };

    it("DORMANT: never classifies content shape when no structured provider is configured", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const smart = new SmartParseProvider(lite, heavy); // no 3rd arg

      await smart.parse(input);

      // The whole doc-type routing block is skipped — zero added cost/behavior.
      expect(mockShape).not.toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalledWith(input);
    });

    it("routes table-heavy docs to the structured provider", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      mockShape.mockResolvedValue("table_heavy");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured = mockProvider(structuredResponse);
      const smart = new SmartParseProvider(lite, heavy, structured);

      const result = await smart.parse(input);

      expect(structured.parse).toHaveBeenCalledWith(input);
      expect(heavy.parse).not.toHaveBeenCalled();
      expect(lite.parse).not.toHaveBeenCalled();
      expect(result).toBe(structuredResponse);
    });

    it("routes table-heavy digital PDFs to the structured provider (not pdfjs)", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      mockShape.mockResolvedValue("table_heavy");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured = mockProvider(structuredResponse);
      const smart = new SmartParseProvider(lite, heavy, structured);

      const result = await smart.parse(input);

      expect(structured.parse).toHaveBeenCalledWith(input);
      expect(lite.parse).not.toHaveBeenCalled();
      expect(result).toBe(structuredResponse);
    });

    it("routes text-heavy scanned docs to the markdown/heavy path", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      mockShape.mockResolvedValue("text_heavy");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured = mockProvider(structuredResponse);
      const smart = new SmartParseProvider(lite, heavy, structured);

      const result = await smart.parse(input);

      expect(heavy.parse).toHaveBeenCalledWith(input);
      expect(structured.parse).not.toHaveBeenCalled();
      expect(result.engine).toBe("docling");
    });

    it("routes text-heavy digital PDFs to pdfjs (unchanged)", async () => {
      mockClassify.mockResolvedValue("digital_pdf");
      mockShape.mockResolvedValue("text_heavy");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured = mockProvider(structuredResponse);
      const smart = new SmartParseProvider(lite, heavy, structured);

      const result = await smart.parse(input);

      expect(lite.parse).toHaveBeenCalledWith(input);
      expect(structured.parse).not.toHaveBeenCalled();
      expect(heavy.parse).not.toHaveBeenCalled();
      expect(result.engine).toBe("pdfjs");
    });

    it("falls back to source-type routing when the structured provider throws", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      mockShape.mockResolvedValue("table_heavy");
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("vendor 500")),
      };
      const smart = new SmartParseProvider(lite, heavy, structured);

      const result = await smart.parse(input);

      expect(structured.parse).toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalledWith(input); // scanned → heavy fallback
      expect(result.engine).toBe("docling");
    });

    it("treats a content-shape classification error as text-heavy (no structured call)", async () => {
      mockClassify.mockResolvedValue("scanned_pdf");
      mockShape.mockRejectedValue(new Error("pdfjs blew up"));
      const lite = mockProvider(digitalResponse);
      const heavy = mockProvider(scannedResponse);
      const structured = mockProvider(structuredResponse);
      const smart = new SmartParseProvider(lite, heavy, structured);

      await smart.parse(input);

      expect(structured.parse).not.toHaveBeenCalled();
      expect(heavy.parse).toHaveBeenCalledWith(input);
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

  it("flags space-mangled output (Type-3 long-token signature)", () => {
    // Whole phrases collapsed into single tokens, as pdfjs emits on Type-3 /
    // custom-encoded fonts. ~21% of tokens are >=20 chars (matches the failing
    // Catawba doc) — well over the 10% threshold.
    const mashed = [
      "STATEFARMFIREANDCASUALTYCOMPANY",
      "ASTOCKCOMPANYWITHHOMEOFFICESINBLOOMINGTONILLINOIS",
      "AUTOMATICRENEWALIFTHEPOLICYPERIODISSHOWNAS12MONTHS",
      "THISPOLICYWILLBERENEWEDAUTOMATICALLYSUBJECTTOTHEPREMIUMS",
      "FORMSINEFFECTFOREACHSUCCEEDINGPOLICYPERIOD",
      "COMPLIANCEWITHTHEPOLICYPROVISIONSORASREQUIREDBYLAW",
    ];
    const shorts = Array.from({ length: 46 }, (_, i) => `w${i}`);
    const md = [...mashed, ...mashed, ...shorts].join(" ");
    expect(detectCorruption(md)).toMatch(/space-mangled/);
  });

  it("does not flag prose with occasional long tokens (URLs)", () => {
    // A handful of long URLs among normal prose stays under the 10% threshold,
    // so a legitimately long-token-dense doc is not mistaken for mangled.
    const prose = Array.from({ length: 90 }, (_, i) =>
      i % 15 === 0 ? "https://example.com/very/long/path/segment" : "word",
    ).join(" ");
    expect(detectCorruption(prose)).toBeNull();
  });
});
