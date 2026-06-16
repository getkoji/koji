import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseProvider, ParseResponse, TextMapSegment } from "./provider";

// ── Mock pdf-lib ────────────────────────────────────────────────────

let __pageCount = 50;
const mockPage = {};

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    load: vi.fn(async () => ({
      getPageCount: () => __pageCount,
    })),
    create: vi.fn(async () => ({
      copyPages: vi.fn(async (_src: unknown, indices: number[]) =>
        indices.map(() => mockPage),
      ),
      addPage: vi.fn(),
      save: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    })),
  },
}));

import { ChunkedParseProvider } from "./chunked";

// ── Helpers ──────────────────────────────────────────────────────────

function makeParseResponse(overrides: Partial<ParseResponse> = {}): ParseResponse {
  return {
    markdown: overrides.markdown ?? "# Page content",
    pages: overrides.pages ?? 1,
    ocr_skipped: overrides.ocr_skipped ?? false,
    text_map: overrides.text_map,
  };
}

const PDF_BUFFER = Buffer.from("fake-pdf");

function makeMockProvider(opts: {
  parseResponses?: ParseResponse[];
  sliceDelay?: number;
} = {}): ParseProvider {
  const { parseResponses, sliceDelay = 0 } = opts;
  let parseCallIndex = 0;

  const provider: ParseProvider = {
    parse: vi.fn(async () => {
      if (sliceDelay > 0) await new Promise((r) => setTimeout(r, sliceDelay));
      const responses = parseResponses ?? [makeParseResponse()];
      const idx = Math.min(parseCallIndex++, responses.length - 1);
      return responses[idx]!;
    }),
  };

  provider.extractCoordinates = vi.fn(async () => ({ extracted: {}, text_map: [] }));
  provider.renderRegion = vi.fn(async () => ({ image_base64: "abc" }));

  return provider;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ChunkedParseProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // 1. Small PDF bypass
  it("delegates to inner.parse for small PDFs (under threshold)", async () => {
    __pageCount = 50;
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { threshold: 80 });

    await chunked.parse({ filename: "small.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    expect(inner.parse).toHaveBeenCalledTimes(1);
  });

  // 2. Non-PDF bypass
  it("delegates to inner.parse for non-PDF files", async () => {
    __pageCount = 200;
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { threshold: 80 });

    await chunked.parse({ filename: "doc.docx", mimeType: "application/vnd.openxmlformats", fileBuffer: PDF_BUFFER });

    expect(inner.parse).toHaveBeenCalledTimes(1);
  });

  // 3. Chunking triggers for large PDFs
  it("chunks a 150-page PDF into 3 chunks of 50", async () => {
    __pageCount = 150;
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    // 3 chunks → 3 parse calls (slicing done locally via pdf-lib)
    expect(inner.parse).toHaveBeenCalledTimes(3);
  });

  // 4. Markdown merge
  it("concatenates markdown from chunks in order", async () => {
    __pageCount = 150;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "# Part 1" }),
        makeParseResponse({ markdown: "# Part 2" }),
        makeParseResponse({ markdown: "# Part 3" }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    expect(result.markdown).toBe("# Part 1\n\n# Part 2\n\n# Part 3");
  });

  // 5. Text map offset
  it("offsets text_map page numbers for each chunk", async () => {
    __pageCount = 100;
    const seg = (page: number): TextMapSegment => ({
      text: `page ${page}`, page, x: 0, y: 0, w: 1, h: 1,
    });
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ text_map: [seg(1), seg(2)] }),
        makeParseResponse({ text_map: [seg(1), seg(2)] }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    // Chunk 1 pages unchanged, chunk 2 pages offset by 50
    expect(result.text_map![0]!.page).toBe(1);
    expect(result.text_map![1]!.page).toBe(2);
    expect(result.text_map![2]!.page).toBe(51);
    expect(result.text_map![3]!.page).toBe(52);
  });

  // 6. OCR skip merge
  it("sets ocr_skipped true only when ALL chunks skip OCR", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ ocr_skipped: true }),
        makeParseResponse({ ocr_skipped: true }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });
    expect(result.ocr_skipped).toBe(true);
  });

  it("sets ocr_skipped false when any chunk did OCR", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ ocr_skipped: true }),
        makeParseResponse({ ocr_skipped: false }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });
    expect(result.ocr_skipped).toBe(false);
  });

  // 7. Parse failure propagates
  it("fails the entire parse if any chunk fails", async () => {
    __pageCount = 100;
    const inner = makeMockProvider();
    let callCount = 0;
    (inner.parse as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("chunk 2 exploded");
      return makeParseResponse({ markdown: `chunk${callCount}` });
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    await expect(
      chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER }),
    ).rejects.toThrow("chunk 2 exploded");
  });

  // 8. Concurrency
  it("limits concurrent parses to the configured concurrency", async () => {
    __pageCount = 300; // 6 chunks
    let active = 0;
    let maxActive = 0;

    const inner = makeMockProvider();
    (inner.parse as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return makeParseResponse();
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80, concurrency: 3 });

    await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(inner.parse).toHaveBeenCalledTimes(6);
  });

  // 9. Pages set to original count
  it("sets pages to the original page count", async () => {
    __pageCount = 150;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ pages: 50 }),
        makeParseResponse({ pages: 50 }),
        makeParseResponse({ pages: 50 }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });
    expect(result.pages).toBe(150);
  });

  // 10. searchable_pdf_base64 omitted
  it("sets searchable_pdf_base64 to undefined for chunked parses", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse(),
        makeParseResponse(),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });

    const result = await chunked.parse({ filename: "big.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });
    expect(result.searchable_pdf_base64).toBeUndefined();
  });

  // 11. Encrypted-PDF handling — owner-password / no-print restrictions
  //     are common in customer documents. pdf-lib refuses to load them
  //     unless we pass ignoreEncryption:true. Confirm the option is
  //     actually forwarded so a regression doesn't silently revert.
  it("passes ignoreEncryption to PDFDocument.load", async () => {
    __pageCount = 150;
    const { PDFDocument } = await import("pdf-lib");
    const loadSpy = PDFDocument.load as ReturnType<typeof vi.fn>;
    loadSpy.mockClear();

    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });
    await chunked.parse({ filename: "encrypted.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    // Both the page-count detection and every slice call must opt into
    // ignoreEncryption — without the flag set on the slice path we'd
    // succeed at counting pages but fail at slicing.
    expect(loadSpy).toHaveBeenCalled();
    for (const call of loadSpy.mock.calls) {
      expect(call[1]).toMatchObject({ ignoreEncryption: true });
    }
  });

  // 12. Truly un-loadable PDF: pdf-lib can't even count pages → fall back
  //     to whole-doc parse (the inner provider's recovery heuristics may
  //     still handle it).
  it("falls back to single parse when PDFDocument.load throws on page-count", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const loadSpy = PDFDocument.load as ReturnType<typeof vi.fn>;
    loadSpy.mockClear();
    loadSpy.mockRejectedValueOnce(new Error("Input document is encrypted"));

    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { threshold: 80 });
    const result = await chunked.parse({ filename: "encrypted.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    expect(result.markdown).toBeDefined();
    // Single fallback call — no chunked workers fired.
    expect(inner.parse).toHaveBeenCalledTimes(1);
  });

  // 13. Slice failure (encrypted content stream, malformed page tree)
  //     after a successful page-count read also falls back — but parse
  //     errors from the inner provider after a successful slice MUST NOT
  //     fall back, they should propagate.
  it("falls back to single parse when sliceWithPdfLib throws mid-stream", async () => {
    __pageCount = 150;
    const { PDFDocument } = await import("pdf-lib");
    const loadSpy = PDFDocument.load as ReturnType<typeof vi.fn>;
    loadSpy.mockClear();
    // First call (page-count) succeeds; subsequent calls (slice path) throw.
    loadSpy.mockImplementationOnce(async () => ({ getPageCount: () => 150 }));
    loadSpy.mockRejectedValue(new Error("encrypted content stream"));

    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 50, threshold: 80 });
    const result = await chunked.parse({ filename: "encrypted.pdf", mimeType: "application/pdf", fileBuffer: PDF_BUFFER });

    expect(result.markdown).toBeDefined();
    // Inner.parse called exactly once for the fallback — no per-chunk
    // calls succeeded because slice always threw.
    expect(inner.parse).toHaveBeenCalledTimes(1);
  });

  // 14. Proxy methods
  it("proxies extractCoordinates to inner", async () => {
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, {});
    await chunked.extractCoordinates!({ fileBuffer: PDF_BUFFER, field: "test", page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 } });
    expect(inner.extractCoordinates).toHaveBeenCalledTimes(1);
  });

  it("proxies renderRegion to inner", async () => {
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, {});
    await chunked.renderRegion!({ fileBuffer: PDF_BUFFER, page: 1, bbox: { x: 0, y: 0, w: 1, h: 1 } });
    expect(inner.renderRegion).toHaveBeenCalledTimes(1);
  });
});
