/**
 * Digital-PDF parse provider — in-process pdfjs-dist extraction for PDFs that
 * already carry a text layer. No OCR, no native binaries, no sidecar — just
 * Mozilla's PDF.js engine plus our `spatialToMarkdown` reconstruction.
 *
 * Replaces the older LiteParse provider, which mis-ordered glyphs on iText-
 * produced commercial PDFs (Cincinnati CinciPak and similar carrier output)
 * and produced scrambled markdown that downstream extraction silently consumed.
 *
 * Scope: PDFs only. Non-PDF inputs (DOCX, HTML, PPTX, images) must be routed
 * to the heavy provider — the SmartParseProvider handles that.
 */

import type {
  ParseProvider,
  ParseResponse,
  TextMapSegment,
} from "./provider";
import {
  spatialToMarkdown,
  type ParsedPage,
  type TextItem,
} from "./spatial-to-markdown";
import { PositionalChunkCanonicalizer } from "./positional-chunks";

// pdfjs's TextContent items expose strings, dimensions, a 6-element transform
// matrix `[a, b, c, d, e, f]` (`(e, f)` is the position in PDF user space —
// y=0 at bottom), and an internal fontName id that resolves through the
// page's styles map.
interface PdfjsTextItem {
  str: string;
  dir?: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL?: boolean;
}

interface PdfjsTextStyle {
  fontFamily?: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

export class DigitalPdfProvider implements ParseProvider {
  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    // PDF-only — anything else should have been routed elsewhere by the
    // SmartParseProvider. Be explicit so a stray DOCX surfaces a clear error
    // rather than pdfjs's "InvalidPDFException".
    if (!isPdf(input.filename, input.mimeType)) {
      throw new Error(
        `DigitalPdfProvider only handles PDFs; got ${input.mimeType || "(no mime)"} for ${input.filename}`,
      );
    }

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(input.fileBuffer),
      // Suppress noisy console.warn from pdfjs about missing standard fonts.
      // We don't render anything visually; font widths come from embedded
      // CIDFontDict or the substitute pdfjs picks internally.
      verbosity: 0,
    }).promise;

    const pages: ParsedPage[] = [];
    const text_map: TextMapSegment[] = [];

    try {
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const styles = (content.styles ?? {}) as Record<string, PdfjsTextStyle>;

          const textItems: TextItem[] = [];
          for (const raw of content.items as PdfjsTextItem[]) {
            const item = toTextItem(raw, viewport.height, styles);
            if (item) textItems.push(item);
          }

          pages.push({
            pageNum,
            width: viewport.width,
            height: viewport.height,
            // `text` is used by spatialToMarkdown only as a fallback for pages
            // with zero textItems (e.g. cover images). Concatenating the
            // emitted strings is good enough for that fallback.
            text: textItems.map((t) => t.text).join(" "),
            textItems,
          });

          for (const item of textItems) {
            text_map.push({
              text: item.text,
              page: pageNum,
              x: viewport.width > 0 ? item.x / viewport.width : 0,
              y: viewport.height > 0 ? item.y / viewport.height : 0,
              w: viewport.width > 0 ? item.width / viewport.width : 0,
              h: viewport.height > 0 ? item.height / viewport.height : 0,
            });
          }
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await doc.destroy();
    }

    // Second consumer of the same positional structure: preserve pdfjs geometry
    // into provenance-carrying chunks (PB-6, digital-positional path). Additive
    // — the markdown above is unchanged; tables are reconstructed via
    // x-clustering so columns associate correctly with no cloud OCR.
    const chunks = new PositionalChunkCanonicalizer().toChunks(pages);

    return {
      markdown: spatialToMarkdown(pages),
      pages: pages.length,
      ocr_skipped: true,
      engine: "pdfjs",
      text_map,
      chunks,
    };
  }
}

function isPdf(filename: string, mimeType: string): boolean {
  if (mimeType === "application/pdf") return true;
  if (mimeType === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf")) return true;
  if (!mimeType && filename.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

function toTextItem(
  raw: PdfjsTextItem,
  pageHeight: number,
  styles: Record<string, PdfjsTextStyle>,
): TextItem | null {
  // pdfjs interleaves zero-width whitespace markers ("", w=0, h=0) between
  // real text runs to communicate inter-run spacing. spatialToMarkdown
  // already inserts spacing from x-gaps; these markers add noise.
  if (!raw.str) return null;
  if (raw.width === 0 && raw.height === 0) return null;

  // pdfjs always emits a 6-element matrix [a, b, c, d, e, f] but the
  // declared type is `number[]`. Guard the indices so TS doesn't widen to
  // undefined.
  const t = raw.transform;
  const a = t[0] ?? 0;
  const b = t[1] ?? 0;
  const e = t[4] ?? 0;
  const f = t[5] ?? 0;

  // For non-rotated text (the overwhelming majority), font size is the matrix
  // scale. For rotated text we still derive a reasonable value from the
  // diagonal magnitude; spatialToMarkdown uses this for body-size detection
  // only, not glyph metrics.
  const fontSize = Math.hypot(a, b) || raw.height || 12;

  // Convert from PDF user space (origin at bottom-left) to top-down y to
  // match spatialToMarkdown's convention.
  const topY = pageHeight - f;

  const style = styles[raw.fontName];
  // pdfjs internal names look like "g_d0_f5"; the real font family lives on
  // the style object. Fall back to the internal name if a style entry is
  // missing — spatialToMarkdown only uses this for bold detection.
  const fontName = style?.fontFamily || raw.fontName;

  return {
    text: raw.str,
    x: e,
    y: topY,
    width: raw.width,
    height: raw.height || fontSize,
    fontName,
    fontSize,
  };
}
