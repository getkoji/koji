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

    it("keeps the corrupt-looking lite parse when heavy ALSO fails (oss-488)", async () => {
      // The heavy provider is an upgrade attempt, not a requirement: we already
      // hold text. Rethrowing its failure discarded a usable parse and left the
      // pipeline reporting "the document produced no extractable text" — false,
      // and it buried the real cause (Doc AI PAGE_LIMIT_EXCEEDED on a 76pg PDF).
      mockClassify.mockResolvedValue("digital_pdf");
      const corrupt: ParseResponse = {
        markdown:
          "M: FRO er: y numb Polic d: io y Per Polic rage a G or d / an bile mo uto t A ep exc es erag v l co Al ECP 035 30 58 EBA 035 30 58 FROM: TO: 10 01 24 27 25 a b c d e f g h i j k l m n o p q r s t u v w x y z",
        pages: 1,
        ocr_skipped: true,
        engine: "pdfjs",
      };
      const lite = mockProvider(corrupt);
      const heavy: ParseProvider = {
        parse: vi.fn().mockRejectedValue(
          new Error("google-docai process 400: Document pages exceed the limit: 30 got 76"),
        ),
      };
      const smart = new SmartParseProvider(lite, heavy);

      const result = await smart.parse(input);

      expect(heavy.parse).toHaveBeenCalled();
      expect(result).toBe(corrupt);
      expect(result.markdown.length).toBeGreaterThan(0);
    });

    it("still surfaces the heavy failure when there is no lite parse to keep", async () => {
      // Distinct from the case above: pdfjs itself threw, so nothing was
      // salvaged and the error must propagate rather than yield a silent empty.
      mockClassify.mockResolvedValue("digital_pdf");
      const lite: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("pdfjs exploded")),
      };
      const heavy: ParseProvider = {
        parse: vi.fn().mockRejectedValue(new Error("docling unreachable")),
      };
      const smart = new SmartParseProvider(lite, heavy);

      await expect(smart.parse(input)).rejects.toThrow(/docling unreachable/);
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

    it("leaves optional methods undefined when neither heavy nor the platform fallback supports them", async () => {
      const heavy = mockProvider(scannedResponse);
      const lite = mockProvider(digitalResponse);
      const smart = new SmartParseProvider(lite, heavy);

      expect(smart.extractCoordinates).toBeUndefined();
      expect(smart.renderRegion).toBeUndefined();
      expect(smart.pageHeaders).toBeUndefined();
      expect(smart.analyzePages).toBeUndefined();
      expect(smart.slicePdf).toBeUndefined();
      expect(smart.pageImages).toBeUndefined();
    });

    // oss-489: a tenant's BYO parse provider replaces text extraction only. No
    // BYO driver implements the optional platform capabilities, so binding them
    // from `heavy` alone silently disabled page rendering (the classifier's
    // vision tier), split detection, slicing, and provenance bboxes for every
    // tenant with a parse endpoint configured.
    it("falls back to the platform provider for capabilities the BYO heavy provider lacks", async () => {
      const images = { images: ["b64page1"] };
      const byoHeavy = mockProvider(scannedResponse); // a Doc AI / Textract-shaped driver
      const platform = mockProvider(scannedResponse, {
        pageImages: vi.fn().mockResolvedValue(images),
        analyzePages: vi.fn().mockResolvedValue({ pages: 3, data: [] }),
        slicePdf: vi.fn().mockResolvedValue({ fileBuffer: Buffer.alloc(0) }),
        extractCoordinates: vi.fn().mockResolvedValue({ extracted: {}, has_text_layer: false }),
      });
      const smart = new SmartParseProvider(mockProvider(digitalResponse), byoHeavy, null, platform);

      expect(smart.pageImages).toBeDefined();
      expect(smart.analyzePages).toBeDefined();
      expect(smart.slicePdf).toBeDefined();
      expect(smart.extractCoordinates).toBeDefined();

      const result = await smart.pageImages!({
        fileBuffer: Buffer.alloc(0),
        filename: "scan.pdf",
        mimeType: "application/pdf",
        maxPages: 1,
      });
      expect(result).toBe(images);
      expect(platform.pageImages).toHaveBeenCalledOnce();
    });

    it("prefers the heavy provider's own capability over the platform fallback", async () => {
      const heavyImages = { images: ["from-heavy"] };
      const heavy = mockProvider(scannedResponse, {
        pageImages: vi.fn().mockResolvedValue(heavyImages),
      });
      const platform = mockProvider(scannedResponse, {
        pageImages: vi.fn().mockResolvedValue({ images: ["from-platform"] }),
      });
      const smart = new SmartParseProvider(mockProvider(digitalResponse), heavy, null, platform);

      const result = await smart.pageImages!({
        fileBuffer: Buffer.alloc(0),
        filename: "scan.pdf",
        mimeType: "application/pdf",
        maxPages: 1,
      });
      expect(result).toBe(heavyImages);
      expect(platform.pageImages).not.toHaveBeenCalled();
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
    // real-world regression doc) — well over the 10% threshold.
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

  it("flags an undecodable text layer (control-byte garbage)", () => {
    // A broken ToUnicode CMap makes pdfjs emit raw glyph ids — C0 control bytes
    // and 0xFF — instead of characters. This slips past the fragmentation and
    // space-mangle arms (the failing doc measured shortRatio 0.54, longRatio
    // 0.06 — just under each threshold), so it needs the non-printable arm.
    const garbage = "\x00\x02\x03\x04\x05\x06\x07\x08\x0b\x0e\x0f\x10\x11\x12\x13\xff".repeat(200);
    expect(detectCorruption(garbage)).toMatch(/non-printable|undecodable/);
  });

  it("does not flag prose containing legitimate accented/Unicode text", () => {
    // Real non-ASCII (accents, em dashes, currency, smart quotes) is not
    // control-byte garbage and must not trip the non-printable arm.
    const text = "Café Müller — naïve résumé €50 “quoted” façade Zürich policy terms apply. ".repeat(50);
    expect(detectCorruption(text)).toBeNull();
  });

  // A verbatim dec-page header pdfjs mangled on a real digital PDF (Cincinnati
  // Pillar policy). The words are split into 1-2 char fragments with stranded
  // single letters ("C", "o", "m", "i") — the localized-mangle signature.
  const mangledDecHeader =
    "The Ci nc i nn at i I n su ra nc e C o m pa ny " +
    "A Sto ck In su r a n ce C o m p an y " +
    "Head qu ar ter s : 62 00 S. G il mor e Ro ad, Fa irf ield , O H 4 50 14 - 514 1 " +
    "Mai ling ad dr es s : P.O . Box 14 54 96, Cinc in na ti, O H 452 50 - 549 6 " +
    "www.c infi n.c om n 513 - 870 - 200 0";

  it("flags a concentrated space-mangle (caught by any arm)", () => {
    // In isolation the mangled block is dense enough to trip the document-level
    // shortRatio arm; the point of the windowed arm is the *diluted* case below.
    expect(detectCorruption(mangledDecHeader)).not.toBeNull();
  });

  it("flags a localized mangle buried in a mostly-clean document", () => {
    // The regression this arm exists for: one scrambled dec page inside an
    // otherwise-clean multi-page policy. The document-level arms (shortRatio,
    // longRatio) wash out below threshold; the windowed single-letter arm still
    // catches the bad span. ~1500 clean tokens dwarf the ~90 mangled ones.
    const cleanPara =
      "Your insurance premium is being paid directly to us rather than to your insurance agency. " +
      "We appreciate your prompt payment of the premium and the trust you place in our coverage. ";
    const buried = cleanPara.repeat(40) + " " + mangledDecHeader + " " + cleanPara.repeat(40);
    // Specifically the windowed arm — the doc-level arms are washed out here.
    expect(detectCorruption(buried)).toMatch(/single-letter/);
  });

  it("does not flag short-token tables (state-code lists)", () => {
    // Insurance docs are full of legitimate short-token runs — state-abbrev fee
    // schedules like "$25 AL, AZ, AR, CA ...". These are uppercase 2-char codes,
    // never stranded single lowercase letters, so the single-letter arm ignores
    // them. Repeated to clear the 50-token floor.
    const stateList =
      "$25 AL, AZ, AR, CA, CO, CT, DE, DC, GA, HI, ID, IL, IN, IA, KS, LA, ME, MI, MN, MS, " +
      "MO, NE, NV, NH, NM, ND, OH, OK, OR, PA, SD, TN, TX, UT, VT, VA, WA, WI, WV and WY. ";
    expect(detectCorruption(stateList.repeat(4))).toBeNull();
  });

  it("does not flag ACORD certificate tables (uppercase insurer-row markers)", () => {
    // A real ACORD COI packs legitimate single letters: insurer-row codes
    // (A/B/C/D) and Y/N checkbox flags. They are UPPERCASE, so the lowercase-only
    // fragment rule ignores them. This washed out a false positive on real COIs.
    const coi =
      "COMBINED SINGLE LIMIT 1,000,000 B ANY AUTO ANY AUTO Y Y BAP8088033 00 01/01/2019 " +
      "BODILY INJURY B AUTOS ONLY OWNED AUTOS ONLY Y Y BAP8088033 00 PROPERTY DAMAGE " +
      "C UMBRELLA LIAB OCCUR EX00A6019 EACH OCCURRENCE D WORKERS COMPENSATION Y N ";
    expect(detectCorruption(coi.repeat(4))).toBeNull();
  });

  it("does not flag decorative single-letter glyph runs (bullets/daggers)", () => {
    // Skills-matrix and footnote tables render Wingdings bullets as a repeated
    // letter ("l l l l l l"). It is a single distinct letter, so the >=4-distinct
    // guard ignores it — unlike a mangled span, which spans the alphabet. Embedded
    // in surrounding prose as in the real filing, so the document-level arms stay
    // quiet and this isolates the windowed arm's diversity guard.
    const prose =
      "The board evaluates director qualifications across the skills relevant to our strategy. ";
    const bulletRow =
      "Financial expertise l l l l l l l l l l l l l l l l l l l l l l l l ";
    const bullets = prose.repeat(20) + bulletRow.repeat(6) + prose.repeat(20);
    expect(detectCorruption(bullets)).toBeNull();
  });

  it("does not flag prose with occasional middle initials", () => {
    // Middle initials ("John B Smith") are legitimate single letters, but sparse
    // — a member roster stays well under the 15%-per-window threshold.
    const roster = Array.from({ length: 120 }, (_, i) =>
      `Director ${["John", "Mary", "Peter", "Susan"][i % 4]} ${String.fromCharCode(66 + (i % 20))} Thompson served the association board`,
    ).join(". ");
    expect(detectCorruption(roster)).toBeNull();
  });
});
