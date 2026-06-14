import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ParseProvider, ParseResponse, TextMapSegment } from "./provider";

// ── Mock pdf-lib before importing the module under test ──────────────

let __pageCount = 50;

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    load: vi.fn(async () => ({
      getPageCount: () => __pageCount,
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
    searchable_pdf_base64: overrides.searchable_pdf_base64,
  };
}

function makeMockProvider(opts: {
  parseResponses?: ParseResponse[];
  hasSlicePdf?: boolean;
  sliceDelay?: number;
} = {}): ParseProvider {
  const { parseResponses, hasSlicePdf = true, sliceDelay = 0 } = opts;
  let parseCallIndex = 0;

  const provider: ParseProvider = {
    parse: vi.fn(async () => {
      if (sliceDelay > 0) {
        await new Promise((r) => setTimeout(r, sliceDelay));
      }
      const responses = parseResponses ?? [makeParseResponse()];
      const idx = Math.min(parseCallIndex++, responses.length - 1);
      return responses[idx]!;
    }),
  };

  if (hasSlicePdf) {
    provider.slicePdf = vi.fn(async (input) => ({
      pdf_base64: Buffer.from("chunk-pdf").toString("base64"),
      pages: input.endPage - input.startPage + 1,
      byte_size: 1000,
    }));
  }

  // Add optional proxy methods for coverage
  provider.extractCoordinates = vi.fn(async () => ({
    extracted: {},
    has_text_layer: true,
  }));
  provider.renderRegion = vi.fn(async () => ({
    image_base64: "abc",
    width: 100,
    height: 100,
  }));

  return provider;
}

const PDF_BUFFER = Buffer.from("fake-pdf");

// ── Tests ────────────────────────────────────────────────────────────

describe("ChunkedParseProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    __pageCount = 50;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Small PDF bypass
  it("delegates to inner.parse for small PDFs (under threshold)", async () => {
    __pageCount = 50;
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner, { threshold: 80 });

    const result = await chunked.parse({
      filename: "small.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(inner.parse).toHaveBeenCalledTimes(1);
    expect(inner.slicePdf).not.toHaveBeenCalled();
    expect(result.markdown).toBe("# Page content");
  });

  // 2. Non-PDF bypass
  it("delegates to inner.parse for non-PDF files", async () => {
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner);

    const result = await chunked.parse({
      filename: "doc.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileBuffer: Buffer.from("docx-content"),
    });

    expect(inner.parse).toHaveBeenCalledTimes(1);
    expect(inner.slicePdf).not.toHaveBeenCalled();
    expect(result.markdown).toBe("# Page content");
  });

  // 3. Large PDF chunking
  it("chunks a 150-page PDF into 3 chunks of 50", async () => {
    __pageCount = 150;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "chunk1", pages: 50 }),
        makeParseResponse({ markdown: "chunk2", pages: 50 }),
        makeParseResponse({ markdown: "chunk3", pages: 50 }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(inner.slicePdf).toHaveBeenCalledTimes(3);
    expect(inner.parse).toHaveBeenCalledTimes(3);

    // Verify chunk ranges
    const sliceCalls = (inner.slicePdf as ReturnType<typeof vi.fn>).mock.calls;
    expect(sliceCalls[0]![0]).toMatchObject({ startPage: 1, endPage: 50 });
    expect(sliceCalls[1]![0]).toMatchObject({ startPage: 51, endPage: 100 });
    expect(sliceCalls[2]![0]).toMatchObject({ startPage: 101, endPage: 150 });
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
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.markdown).toBe("# Part 1\n\n# Part 2\n\n# Part 3");
  });

  // 5. Text map page offset
  it("offsets text_map page numbers for each chunk", async () => {
    __pageCount = 100;
    const seg = (page: number, text: string): TextMapSegment => ({
      text,
      page,
      x: 0,
      y: 0,
      w: 100,
      h: 20,
    });
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({
          markdown: "c1",
          text_map: [seg(1, "hello"), seg(2, "world")],
        }),
        makeParseResponse({
          markdown: "c2",
          text_map: [seg(1, "foo"), seg(3, "bar")],
        }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.text_map).toHaveLength(4);
    // Chunk 1 pages stay at 1, 2 (offset 0)
    expect(result.text_map![0]!.page).toBe(1);
    expect(result.text_map![1]!.page).toBe(2);
    // Chunk 2 pages offset by 50: 1→51, 3→53
    expect(result.text_map![2]!.page).toBe(51);
    expect(result.text_map![3]!.page).toBe(53);
  });

  // 6. OCR skip merge
  it("sets ocr_skipped true only when ALL chunks skip OCR", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "c1", ocr_skipped: true }),
        makeParseResponse({ markdown: "c2", ocr_skipped: true }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.ocr_skipped).toBe(true);
  });

  it("sets ocr_skipped false when any chunk did OCR", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "c1", ocr_skipped: true }),
        makeParseResponse({ markdown: "c2", ocr_skipped: false }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.ocr_skipped).toBe(false);
  });

  // 7. No slicePdf on inner → fallback
  it("falls back to single parse when inner has no slicePdf", async () => {
    __pageCount = 150;
    const inner = makeMockProvider({ hasSlicePdf: false });
    const chunked = new ChunkedParseProvider(inner, { threshold: 80 });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(inner.parse).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe("# Page content");
  });

  // 8. Partial failure → whole parse fails
  it("fails the entire parse if any chunk fails", async () => {
    __pageCount = 100;
    const inner = makeMockProvider();
    let callCount = 0;
    (inner.parse as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("chunk 2 exploded");
      return makeParseResponse({ markdown: `chunk${callCount}` });
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    await expect(
      chunked.parse({
        filename: "big.pdf",
        mimeType: "application/pdf",
        fileBuffer: PDF_BUFFER,
      }),
    ).rejects.toThrow("chunk 2 exploded");
  });

  // 9. Concurrency — verify max 3 concurrent parses
  it("limits concurrent parses to the configured concurrency", async () => {
    __pageCount = 300; // 6 chunks of 50
    let activeConcurrency = 0;
    let maxObservedConcurrency = 0;

    const inner = makeMockProvider();
    (inner.parse as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      activeConcurrency++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrency);
      // Simulate some async work
      await new Promise((r) => setTimeout(r, 20));
      activeConcurrency--;
      return makeParseResponse({ markdown: "chunk" });
    });

    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
      concurrency: 3,
    });

    await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(inner.parse).toHaveBeenCalledTimes(6);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(3);
    // Should actually use concurrency (not just serial)
    expect(maxObservedConcurrency).toBeGreaterThan(1);
  });

  // Proxy methods
  it("proxies extractCoordinates to inner", async () => {
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner);

    expect(chunked.extractCoordinates).toBeDefined();
    const result = await chunked.extractCoordinates!({
      fileBuffer: PDF_BUFFER,
      mappings: {},
    });
    expect(result.has_text_layer).toBe(true);
    expect(inner.extractCoordinates).toHaveBeenCalledTimes(1);
  });

  it("proxies renderRegion to inner", async () => {
    const inner = makeMockProvider();
    const chunked = new ChunkedParseProvider(inner);

    expect(chunked.renderRegion).toBeDefined();
    const result = await chunked.renderRegion!({
      fileBuffer: PDF_BUFFER,
      page: 1,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(result.image_base64).toBe("abc");
  });

  // Pages count in merged result
  it("sets pages to the original page count", async () => {
    __pageCount = 150;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "c1", pages: 50 }),
        makeParseResponse({ markdown: "c2", pages: 50 }),
        makeParseResponse({ markdown: "c3", pages: 50 }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.pages).toBe(150);
  });

  // searchable_pdf_base64 is null for chunked
  it("sets searchable_pdf_base64 to undefined for chunked parses", async () => {
    __pageCount = 100;
    const inner = makeMockProvider({
      parseResponses: [
        makeParseResponse({ markdown: "c1", searchable_pdf_base64: "abc" }),
        makeParseResponse({ markdown: "c2", searchable_pdf_base64: "def" }),
      ],
    });
    const chunked = new ChunkedParseProvider(inner, {
      chunkPages: 50,
      threshold: 80,
    });

    const result = await chunked.parse({
      filename: "big.pdf",
      mimeType: "application/pdf",
      fileBuffer: PDF_BUFFER,
    });

    expect(result.searchable_pdf_base64).toBeUndefined();
  });
});
