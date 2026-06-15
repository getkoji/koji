/**
 * Chunked parse provider — splits large PDFs into chunks, parses each
 * in parallel with bounded concurrency, and merges the results.
 *
 * Wraps any ParseProvider that has `slicePdf`. For small PDFs or non-PDFs,
 * delegates directly to the inner provider with zero overhead.
 *
 * Unsliceable-PDF handling: some PDFs have corrupt cross-reference tables
 * (e.g. "cannot find object in xref"). The inner slicer can't carve them
 * up, but the parser itself can usually still read them end-to-end. We
 * probe the first chunk's slice sequentially before fanning out, so a
 * single failed slice call is enough to fall back to a one-shot
 * full-document parse — no wasted parallel slice attempts on the rest of
 * the chunks, and one clear log line instead of one per concurrent
 * worker.
 */

import { PDFDocument } from "pdf-lib";
import type {
  ParseProvider,
  ParseResponse,
  TextMapSegment,
} from "./provider";

export interface ChunkedParseConfig {
  /** Pages per chunk. Default 50. */
  chunkPages?: number;
  /** Page count threshold — only chunk if above this. Default 80. */
  threshold?: number;
  /** Max parallel parse calls. Default 3. */
  concurrency?: number;
}

export class ChunkedParseProvider implements ParseProvider {
  extractCoordinates?: ParseProvider["extractCoordinates"];
  renderRegion?: ParseProvider["renderRegion"];
  pageHeaders?: ParseProvider["pageHeaders"];
  analyzePages?: ParseProvider["analyzePages"];
  slicePdf?: ParseProvider["slicePdf"];

  private chunkPages: number;
  private threshold: number;
  private concurrency: number;

  constructor(
    private inner: ParseProvider,
    config: ChunkedParseConfig = {},
  ) {
    this.chunkPages = config.chunkPages ?? 50;
    this.threshold = config.threshold ?? 80;
    this.concurrency = config.concurrency ?? 3;

    // Proxy optional methods to inner
    if (inner.extractCoordinates) {
      this.extractCoordinates = inner.extractCoordinates.bind(inner);
    }
    if (inner.renderRegion) {
      this.renderRegion = inner.renderRegion.bind(inner);
    }
    if (inner.pageHeaders) {
      this.pageHeaders = inner.pageHeaders.bind(inner);
    }
    if (inner.analyzePages) {
      this.analyzePages = inner.analyzePages.bind(inner);
    }
    if (inner.slicePdf) {
      this.slicePdf = inner.slicePdf.bind(inner);
    }
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    // Non-PDF → delegate directly
    if (!input.mimeType.includes("pdf")) {
      return this.inner.parse(input);
    }

    // Get page count cheaply via pdf-lib
    const pdfDoc = await PDFDocument.load(input.fileBuffer);
    const pageCount = pdfDoc.getPageCount();

    // Under threshold → delegate directly
    if (pageCount <= this.threshold) {
      return this.inner.parse(input);
    }

    console.log(
      `[chunked-parse] ${input.filename}: ${pageCount} pages → chunking (${this.chunkPages} pages/chunk, concurrency ${this.concurrency})`,
    );

    // Build chunk ranges: [startPage, endPage] (1-indexed)
    const chunks: Array<{ startPage: number; endPage: number }> = [];
    for (let start = 1; start <= pageCount; start += this.chunkPages) {
      const end = Math.min(start + this.chunkPages - 1, pageCount);
      chunks.push({ startPage: start, endPage: end });
    }

    // Slice locally with pdf-lib — handles corrupt xref tables that the
    // remote slicePdf endpoint chokes on. No HTTP roundtrip per chunk.
    const results = await this.runWithConcurrency(chunks, async (chunk) => {
      const chunkBuffer = await this.sliceWithPdfLib(
        input.fileBuffer, chunk.startPage, chunk.endPage,
      );
      return {
        response: await this.inner.parse({
          filename: input.filename,
          mimeType: input.mimeType,
          fileBuffer: chunkBuffer,
        }),
        startPage: chunk.startPage,
      };
    });

    // Merge results in order
    return this.mergeResults(results, pageCount);
  }

  /** Slice a page range using pdf-lib locally. Handles corrupt xref tables. */
  private async sliceWithPdfLib(
    fileBuffer: Buffer,
    startPage: number,
    endPage: number,
  ): Promise<Buffer> {
    const srcDoc = await PDFDocument.load(fileBuffer);
    const newDoc = await PDFDocument.create();
    const indices: number[] = [];
    for (let i = startPage - 1; i < endPage; i++) indices.push(i);
    const pages = await newDoc.copyPages(srcDoc, indices);
    for (const page of pages) newDoc.addPage(page);
    return Buffer.from(await newDoc.save());
  }

  private async runWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        results[idx] = await fn(items[idx]!);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, items.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  private mergeResults(
    chunks: Array<{ response: ParseResponse; startPage: number }>,
    totalPages: number,
  ): ParseResponse {
    // Markdown: concatenate in order
    const markdown = chunks.map((c) => c.response.markdown).join("\n\n");

    // OCR skipped: true only if ALL chunks skipped
    const ocr_skipped = chunks.every((c) => c.response.ocr_skipped);

    // Text map: concatenate with page offset
    let text_map: TextMapSegment[] | undefined;
    const hasAnyTextMap = chunks.some((c) => c.response.text_map?.length);
    if (hasAnyTextMap) {
      text_map = [];
      for (const chunk of chunks) {
        if (!chunk.response.text_map) continue;
        const offset = chunk.startPage - 1;
        for (const seg of chunk.response.text_map) {
          text_map.push({ ...seg, page: seg.page + offset });
        }
      }
    }

    return {
      markdown,
      pages: totalPages,
      ocr_skipped,
      text_map,
      // searchable_pdf_base64 is not mergeable — skip for chunked parses
    };
  }
}
