/**
 * ChunkedParseProvider — pdf-lib-unreadable PDFs (oss-377).
 *
 * Separate from chunked.test.ts because that file mocks pdf-lib module-wide;
 * these tests need the REAL pdf-lib against the encrypted fixtures (pdf-lib
 * genuinely fails on them, pdfjs counts them) to prove the normalize-then-
 * chunk path carves real slices. Global fetch is stubbed to play the parse
 * service's /normalize-pdf endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PDFDocument } from "pdf-lib";

import { ChunkedParseProvider } from "./chunked";
import type { ParseProvider, ParseResponse } from "./provider";
import {
  ENCRYPTED_OBJSTM_PDF_40,
  ENCRYPTED_OBJSTM_PDF_40_NORMALIZED,
} from "./encrypted-pdf.fixture";

function makeParseResponse(markdown: string): ParseResponse {
  return { markdown, pages: 1, ocr_skipped: false, engine: "docling" };
}

function makeInner(): ParseProvider {
  let n = 0;
  return {
    parse: vi.fn(async () => makeParseResponse(`chunk ${++n}`)),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChunkedParseProvider — encrypted/object-stream PDFs", () => {
  it("normalizes once, then chunks the normalized bytes into real slices", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          pdf_base64: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.toString("base64"),
          pages: 40,
          byte_size: ENCRYPTED_OBJSTM_PDF_40_NORMALIZED.length,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const inner = makeInner();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 15, threshold: 10 });
    const result = await chunked.parse({
      filename: "encrypted-policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
    });

    // One normalize round trip; 40pg / 15 → 3 chunk parses (NOT one whole-doc call).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/normalize-pdf");
    expect(inner.parse).toHaveBeenCalledTimes(3);

    // Each inner call received a genuinely sliced, pdf-lib-readable PDF.
    const spans: number[] = [];
    for (const call of (inner.parse as ReturnType<typeof vi.fn>).mock.calls) {
      const buf = (call[0] as { fileBuffer: Buffer }).fileBuffer;
      const doc = await PDFDocument.load(buf);
      spans.push(doc.getPageCount());
    }
    expect(spans).toEqual([15, 15, 10]);

    expect(result.markdown).toContain("chunk 1");
    expect(result.markdown).toContain("chunk 3");
  });

  it("falls back to ONE whole-document parse when normalization fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "normalize failed: boom" }), { status: 422 }),
    );

    const inner = makeInner();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 15, threshold: 10 });
    const result = await chunked.parse({
      filename: "encrypted-policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
    });

    expect(inner.parse).toHaveBeenCalledTimes(1);
    // The fallback must hand the inner provider the ORIGINAL bytes.
    const call = (inner.parse as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((call[0] as { fileBuffer: Buffer }).fileBuffer).toBe(ENCRYPTED_OBJSTM_PDF_40);
    expect(result.markdown).toBe("chunk 1");
  });

  it("does not normalize when the unreadable PDF is under the chunking threshold", async () => {
    const inner = makeInner();
    const chunked = new ChunkedParseProvider(inner, { chunkPages: 15, threshold: 80 });
    await chunked.parse({
      filename: "encrypted-policy.pdf",
      mimeType: "application/pdf",
      fileBuffer: ENCRYPTED_OBJSTM_PDF_40,
    });

    // 40pg ≤ threshold 80 → straight delegation, no service round trip.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inner.parse).toHaveBeenCalledTimes(1);
  });
});
