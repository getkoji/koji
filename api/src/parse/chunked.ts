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

import type {
  ParseProvider,
  ParseResponse,
  TextMapSegment,
} from "./provider";
import { slicePdfPages, mapWithConcurrency, probePdf } from "./pdf-slice";
import { normalizePdfViaService } from "./pdf-normalize";

/**
 * Sentinel for pdf-lib slice failures. Wrapping these distinguishes
 * "PDF can't be sliced, fall back to whole-doc parse" from "the inner
 * parse provider failed on a chunk, propagate the real error". The
 * outer catch only swallows SliceFailedError; anything else bubbles.
 */
class SliceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SliceFailedError";
  }
}

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
  pageImages?: ParseProvider["pageImages"];
  pageHeaders?: ParseProvider["pageHeaders"];
  analyzePages?: ParseProvider["analyzePages"];
  slicePdf?: ParseProvider["slicePdf"];
  dispatchParse?: ParseProvider["dispatchParse"];
  pollParse?: ParseProvider["pollParse"];

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
    if (inner.pageImages) {
      this.pageImages = inner.pageImages.bind(inner);
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
    if (inner.dispatchParse) {
      this.dispatchParse = inner.dispatchParse.bind(inner);
    }
    if (inner.pollParse) {
      this.pollParse = inner.pollParse.bind(inner);
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

    // Get the page count cheaply. `probePdf` tries pdf-lib first
    // (`ignoreEncryption: true` handles the common owner-password / no-print
    // restriction where the page tree is still plaintext) and falls back to
    // pdfjs for the count when pdf-lib can't read the file at all — the
    // notable real-world case being owner-password encryption combined with
    // a page tree in compressed object streams (oss-377). When neither can
    // read it, parse the whole document with the inner provider — the parse
    // service has its own recovery heuristics that work where pdf-lib can't.
    const probe = await probePdf(input.fileBuffer, input.mimeType);
    if (probe.pageCount === null) {
      console.warn(
        `[chunked-parse] ${input.filename}: could not determine page count (pdf-lib and pdfjs both failed to read the document). ` +
          `Parsing as a single unit — chunking and per-chunk provenance unavailable for this document.`,
      );
      return this.inner.parse(input);
    }
    let pageCount = probe.pageCount;

    // Under threshold → delegate directly
    if (pageCount <= this.threshold) {
      return this.inner.parse(input);
    }

    // Over threshold but not locally sliceable → normalize once through the
    // parse service (a PDFium/MuPDF re-save that pdf-lib can read, see
    // pdf-normalize.ts) and chunk the normalized bytes. If normalization
    // fails, keep the old behavior: one whole-document parse by the inner
    // provider.
    if (!probe.pdfLibLoadable) {
      try {
        const normalized = await normalizePdfViaService(input.fileBuffer, input.filename);
        const renormalized = await probePdf(normalized, input.mimeType);
        if (renormalized.pageCount === null || !renormalized.pdfLibLoadable) {
          throw new Error("normalized PDF is still not readable by pdf-lib");
        }
        console.log(
          `[chunked-parse] ${input.filename}: pdf-lib cannot read this PDF; ` +
            `normalized via parse service (${pageCount} → ${renormalized.pageCount}pg) for chunking.`,
        );
        input = { ...input, fileBuffer: normalized };
        pageCount = renormalized.pageCount;
        if (pageCount <= this.threshold) {
          return this.inner.parse(input);
        }
      } catch (err) {
        console.warn(
          `[chunked-parse] ${input.filename}: pdf-lib cannot read this ${pageCount}pg PDF and normalization failed ` +
            `(${err instanceof Error ? err.message : String(err)}). ` +
            `Parsing as a single unit — chunking and per-chunk provenance unavailable for this document.`,
        );
        return this.inner.parse(input);
      }
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
    // The slice itself is wrapped in a sentinel so we can distinguish
    // "this PDF is unsliceable, fall back to whole-doc" from "the inner
    // parse provider failed, real error, propagate". Parse errors after
    // a successful slice should bubble up unchanged.
    let results;
    try {
      results = await mapWithConcurrency(chunks, this.concurrency, async (chunk) => {
        let chunkBuffer: Buffer;
        try {
          chunkBuffer = await slicePdfPages(
            input.fileBuffer, chunk.startPage, chunk.endPage,
          );
        } catch (err) {
          throw new SliceFailedError(err instanceof Error ? err.message : String(err));
        }
        return {
          response: await this.inner.parse({
            filename: input.filename,
            mimeType: input.mimeType,
            fileBuffer: chunkBuffer,
          }),
          startPage: chunk.startPage,
        };
      });
    } catch (err) {
      if (err instanceof SliceFailedError) {
        console.warn(
          `[chunked-parse] ${input.filename}: pdf-lib slice failed mid-stream (${err.message}). ` +
            `Falling back to single-document parse.`,
        );
        return this.inner.parse(input);
      }
      throw err;
    }

    // Merge results in order
    return this.mergeResults(results, pageCount);
  }

  private mergeResults(
    chunks: Array<{ response: ParseResponse; startPage: number }>,
    totalPages: number,
  ): ParseResponse {
    // Markdown: concatenate in order
    const markdown = chunks.map((c) => c.response.markdown).join("\n\n");

    // OCR skipped: true only if ALL chunks skipped
    const ocr_skipped = chunks.every((c) => c.response.ocr_skipped);

    // Engine: if every chunk reports the same engine, pass it through.
    // Mixed (rare: e.g. one chunk fell back to heavy via SmartParseProvider)
    // collapses to "docling" since heavy is always the fallback.
    const engines = new Set(chunks.map((c) => c.response.engine));
    const engine = engines.size === 1
      ? chunks[0]!.response.engine
      : "docling";

    // Text map: concatenate with page offset. When a chunk carries L3 offset
    // annotations (md_offset), those are relative to that chunk's own markdown,
    // so they must also shift by the chunk's start position in the concatenated
    // markdown (cumulative prior lengths + the "\n\n" separators). mdCursor
    // advances for every chunk — even those without a text_map — because the
    // markdown join above includes every chunk's markdown.
    let text_map: TextMapSegment[] | undefined;
    const hasAnyTextMap = chunks.some((c) => c.response.text_map?.length);
    if (hasAnyTextMap) {
      text_map = [];
      let mdCursor = 0;
      for (const chunk of chunks) {
        const mdBase = mdCursor;
        const offset = chunk.startPage - 1;
        for (const seg of chunk.response.text_map ?? []) {
          const shifted: TextMapSegment = { ...seg, page: seg.page + offset };
          if (seg.md_offset != null) shifted.md_offset = seg.md_offset + mdBase;
          text_map.push(shifted);
        }
        mdCursor += chunk.response.markdown.length + 2; // +2 for the "\n\n" join
      }
    }

    return {
      markdown,
      pages: totalPages,
      ocr_skipped,
      engine,
      text_map,
    };
  }
}
