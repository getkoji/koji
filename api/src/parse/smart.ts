/**
 * Smart parse provider — routes documents to the best parser based on type.
 *
 * Source-type routing (always on):
 * - Digital PDFs → in-process pdfjs (`DigitalPdfProvider`)
 * - Scanned PDFs, images, and non-PDF formats (DOCX, HTML, …) → heavy
 *   provider (Docling via Docker sidecar or Modal)
 *
 * Doc-type routing (PB-10, opt-in): when a tenant has configured a *structured*
 * parse provider (one that preserves row/column structure — Google Doc AI,
 * Textract, positional), table-heavy documents are steered to it instead of the
 * markdown/docling path, because flattening a dec page / schedule / grid to
 * markdown scrambles column association. Text-heavy documents keep the
 * markdown/docling path. The table-heavy vs text-heavy decision is a geometric
 * signal (`content-shape.ts`), not a domain classifier.
 *
 * Dormant by default: with no structured provider configured (every tenant
 * today), `structured` is null and routing is byte-for-byte the previous
 * behaviour — the content-shape classifier is never even invoked, so the hot
 * path pays nothing.
 *
 * Two safety nets so a bad lite-provider parse can't silently poison
 * extraction:
 *
 * 1. Hard fail: if the lite provider throws, fall back to heavy.
 * 2. Soft fail: if the lite provider returns markdown that *looks* corrupt
 *    (mostly 1-2 character fragments, heavy fragmentation), fall back to
 *    heavy. This caught the Cincinnati CinciPak regression where LiteParse
 *    returned text items with scrambled positions and the model silently
 *    consumed the resulting garbage.
 *
 * The structured path has the same safety net: if it throws, we fall through
 * to the source-type routing below (digital → pdfjs, otherwise → heavy).
 *
 * Optional methods (extractCoordinates, renderRegion, pageHeaders,
 * analyzePages, slicePdf) are proxied to the heavy provider.
 */

import type { ParseProvider, ParseResponse } from "./provider";
import { classifyDocument } from "./classify";
import { classifyContentShape } from "./content-shape";
import { resolveMimeType } from "../ingestion/mime";

export class SmartParseProvider implements ParseProvider {
  extractCoordinates?: ParseProvider["extractCoordinates"];
  renderRegion?: ParseProvider["renderRegion"];
  pageImages?: ParseProvider["pageImages"];
  pageHeaders?: ParseProvider["pageHeaders"];
  analyzePages?: ParseProvider["analyzePages"];
  slicePdf?: ParseProvider["slicePdf"];

  constructor(
    private lite: ParseProvider,
    private heavy: ParseProvider,
    /**
     * Optional structured provider for table-heavy docs. Null/undefined (the
     * default) disables doc-type routing entirely — behaviour is identical to
     * pre-PB-10. When set, table-heavy docs route here; text-heavy docs and any
     * structured-path failure fall back to the source-type routing below.
     */
    private structured: ParseProvider | null = null,
  ) {
    if (heavy.extractCoordinates) {
      this.extractCoordinates = heavy.extractCoordinates.bind(heavy);
    }
    if (heavy.renderRegion) {
      this.renderRegion = heavy.renderRegion.bind(heavy);
    }
    if (heavy.pageImages) {
      this.pageImages = heavy.pageImages.bind(heavy);
    }
    if (heavy.pageHeaders) {
      this.pageHeaders = heavy.pageHeaders.bind(heavy);
    }
    if (heavy.analyzePages) {
      this.analyzePages = heavy.analyzePages.bind(heavy);
    }
    if (heavy.slicePdf) {
      this.slicePdf = heavy.slicePdf.bind(heavy);
    }
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    // Normalize the MIME once, centrally, before any provider sees it. A bare
    // or invalid stored MIME (e.g. "pdf" instead of "application/pdf") would
    // otherwise hard-fail strict upstream APIs like Google Doc AI's
    // `rawDocument.mime_type` (400 INVALID_ARGUMENT → wrapped as a 502). We
    // upgrade from the claimed value → filename extension → magic bytes, so
    // every downstream provider (pdfjs, docling, Doc AI, Textract, Mistral …)
    // receives a real MIME.
    const resolvedMime = resolveMimeType(
      input.mimeType,
      input.filename,
      input.fileBuffer,
    );
    if (resolvedMime !== input.mimeType) {
      console.log(
        `[smart-parse] ${input.filename}: normalized mimeType "${input.mimeType}" → "${resolvedMime}"`,
      );
      input = { ...input, mimeType: resolvedMime };
    }

    const docType = await classifyDocument(
      input.filename,
      input.mimeType,
      input.fileBuffer,
    );

    // ── Doc-type routing (only when a structured provider is configured) ─────
    // Table-heavy docs go to the structured provider, which preserves cell
    // structure instead of flattening grids to markdown. This block is skipped
    // entirely (no classifier call) when `structured` is null — the default.
    if (this.structured) {
      let shape: "table_heavy" | "text_heavy" = "text_heavy";
      try {
        shape = await classifyContentShape(
          input.filename,
          input.mimeType,
          input.fileBuffer,
        );
      } catch (err) {
        console.warn(
          `[smart-parse] content-shape classification failed for ${input.filename}, treating as text-heavy:`,
          err instanceof Error ? err.message : err,
        );
      }

      if (shape === "table_heavy") {
        console.log(`[smart-parse] ${input.filename}: ${docType}/table_heavy → structured provider`);
        try {
          return await this.structured.parse(input);
        } catch (err) {
          console.warn(
            `[smart-parse] structured provider failed for ${input.filename}, falling back to source-type routing:`,
            err instanceof Error ? err.message : err,
          );
          // fall through to the source-type routing below
        }
      }
    }

    // ── Source-type routing (always on) ──────────────────────────────────────
    // Scanned content, images, and non-PDF formats → heavy (Docling handles
    // OCR + DOCX/HTML/PPTX natively). pdfjs is PDF-only.
    if (docType !== "digital_pdf") {
      console.log(`[smart-parse] ${input.filename}: ${docType} → heavy provider`);
      return this.heavy.parse(input);
    }

    // Digital PDFs → pdfjs first, fall back to heavy on error or on output
    // that looks corrupt.
    console.log(`[smart-parse] ${input.filename}: digital_pdf → pdfjs`);
    let liteResult: ParseResponse;
    try {
      liteResult = await this.lite.parse(input);
    } catch (err) {
      console.warn(
        `[smart-parse] pdfjs failed for ${input.filename}, falling back to heavy provider:`,
        err instanceof Error ? err.message : err,
      );
      return this.heavy.parse(input);
    }

    const corruption = detectCorruption(liteResult.markdown);
    if (corruption) {
      console.warn(
        `[smart-parse] pdfjs output for ${input.filename} looks corrupt (${corruption}), falling back to heavy provider`,
      );
      return this.heavy.parse(input);
    }

    return liteResult;
  }
}

/**
 * Heuristic: does the markdown look like the parser scrambled it?
 *
 * Returns a short reason string when the output looks unusable, or null when
 * it looks fine. Tuned to be quiet on real documents and loud on the kind of
 * fragmentation we saw from the LiteParse regression — output like
 * `"M: FRO er: y numb Polic rage a G or d / an bile mo uto t A ep …"` where
 * most "words" are 1-2 character chunks.
 *
 * - `tokenCount < 50`: too little signal to judge — assume OK (one-page
 *   receipts, mostly-image PDFs with sparse text).
 * - `shortRatio > 0.6 && medianLen < 3`: most tokens are fragments. Real
 *   prose sits around medianLen 4-6 with shortRatio < 0.4.
 */
export function detectCorruption(markdown: string): string | null {
  const stripped = markdown.replace(/[#*`|>\-_]/g, " ");
  const tokens = stripped.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t));
  if (tokens.length < 50) return null;

  const lengths = tokens.map((t) => t.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const shortRatio = tokens.filter((t) => t.length <= 2).length / tokens.length;

  if (shortRatio > 0.6 && median < 3) {
    return `${(shortRatio * 100).toFixed(0)}% tokens are 1-2 chars (median len ${median})`;
  }
  return null;
}
