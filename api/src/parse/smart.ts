/**
 * Smart parse provider — routes documents to the best parser based on type.
 *
 * - Digital PDFs and other formats (docx, html, etc.) → LiteParse (fast, Rust)
 * - Scanned PDFs and images → heavy provider (Docling/Modal, OCR-capable)
 *
 * Falls back to the heavy provider if LiteParse fails (binary missing,
 * unsupported format, corrupt file). This guarantees zero regression —
 * every document that worked before still works.
 *
 * Optional methods (extractCoordinates, renderRegion, pageHeaders,
 * analyzePages, slicePdf) are proxied to the heavy provider.
 */

import type {
  ParseProvider,
  ParseResponse,
  CoordinateExtractionResult,
  PageAnalysis,
} from "./provider";
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
    // Proxy optional methods to the heavy provider (only it supports them)
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

    // Scanned content needs OCR — always use the heavy provider
    if (docType === "scanned_pdf" || docType === "image") {
      console.log(`[smart-parse] ${input.filename}: ${docType} → heavy provider`);
      return this.heavy.parse(input);
    }

    // Digital PDFs and other formats → try LiteParse first
    try {
      console.log(`[smart-parse] ${input.filename}: ${docType} → liteparse`);
      return await this.lite.parse(input);
    } catch (err) {
      console.warn(
        `[smart-parse] LiteParse failed for ${input.filename}, falling back to heavy provider:`,
        err instanceof Error ? err.message : err,
      );
      return this.heavy.parse(input);
    }
  }
}
