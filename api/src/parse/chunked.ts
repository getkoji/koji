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

type SliceResult = { pdf_base64: string; pages: number; byte_size: number };

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

    // Under threshold or inner lacks slicePdf → delegate directly
    if (pageCount <= this.threshold || !this.inner.slicePdf) {
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

    // Probe the first chunk sequentially. A corrupt-xref PDF will fail
    // here in ~200ms; cheaper than fanning out and watching every parallel
    // worker fail the same way. If the probe succeeds, the result is
    // handed to chunk 0's worker so we don't re-slice the same range.
    let probeSlice: SliceResult;
    try {
      probeSlice = await this.inner.slicePdf!({
        fileBuffer: input.fileBuffer,
        startPage: chunks[0]!.startPage,
        endPage: chunks[0]!.endPage,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[chunked-parse] ${input.filename}: cannot slice (${reason}). ` +
          `Parsing the full ${pageCount}-page document as a single unit ` +
          `— provenance/text_map will not be per-chunk.`,
      );
      return this.inner.parse(input);
    }

    // Probe succeeded → run all chunks with bounded concurrency. Chunk 0
    // reuses the probe result. After-probe slice failures are real errors
    // (e.g. transient network) — propagate them rather than silently
    // re-parsing the whole document.
    type ChunkWork = {
      chunk: { startPage: number; endPage: number };
      prefetchedSlice?: SliceResult;
    };
    const chunkWork: ChunkWork[] = chunks.map((chunk, i) => ({
      chunk,
      prefetchedSlice: i === 0 ? probeSlice : undefined,
    }));

    const results = await this.runWithConcurrency(chunkWork, async (work) => {
      const sliceResult =
        work.prefetchedSlice ??
        (await this.inner.slicePdf!({
          fileBuffer: input.fileBuffer,
          startPage: work.chunk.startPage,
          endPage: work.chunk.endPage,
        }));
      const chunkBuffer = Buffer.from(sliceResult.pdf_base64, "base64");
      return {
        response: await this.inner.parse({
          filename: input.filename,
          mimeType: input.mimeType,
          fileBuffer: chunkBuffer,
        }),
        startPage: work.chunk.startPage,
      };
    });

    // Merge results in order
    return this.mergeResults(results, pageCount);
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
