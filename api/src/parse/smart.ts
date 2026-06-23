/**
 * Smart parse provider — routes documents to the best parser based on type.
 *
 * - Digital PDFs → in-process pdfjs (`DigitalPdfProvider`)
 * - Scanned PDFs, images, and non-PDF formats (DOCX, HTML, …) → heavy
 *   provider (Docling via Docker sidecar or Modal)
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
 * Optional methods (extractCoordinates, renderRegion, pageHeaders,
 * analyzePages, slicePdf) are proxied to the heavy provider.
 */

import type { ParseProvider, ParseResponse } from "./provider";
import { classifyDocument } from "./classify";

export class SmartParseProvider implements ParseProvider {
  extractCoordinates?: ParseProvider["extractCoordinates"];
  renderRegion?: ParseProvider["renderRegion"];
  pageHeaders?: ParseProvider["pageHeaders"];
  analyzePages?: ParseProvider["analyzePages"];
  slicePdf?: ParseProvider["slicePdf"];

  constructor(
    private lite: ParseProvider,
    private heavy: ParseProvider,
  ) {
    if (heavy.extractCoordinates) {
      this.extractCoordinates = heavy.extractCoordinates.bind(heavy);
    }
    if (heavy.renderRegion) {
      this.renderRegion = heavy.renderRegion.bind(heavy);
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
    const docType = await classifyDocument(
      input.filename,
      input.mimeType,
      input.fileBuffer,
    );

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
