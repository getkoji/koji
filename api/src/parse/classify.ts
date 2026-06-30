/**
 * Document type classifier — determines whether a document is a digital PDF
 * (has text layer), scanned PDF (needs OCR), image, or other format.
 *
 * Used by SmartParseProvider to route documents to the appropriate parser:
 * - digital_pdf → DigitalPdfProvider (in-process pdfjs-dist, no OCR)
 * - scanned_pdf / image / other → Docling (OCR + DOCX/HTML/PPTX support)
 *
 * The heuristic matches services/parse/main.py get_pdf_info() exactly:
 * average < 50 chars/page over the first 3 pages → scanned.
 */

import { loadPdfjs } from "./pdfjs-loader";

export type DocumentType = "digital_pdf" | "scanned_pdf" | "image" | "other";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|tiff?|bmp|webp|gif|heic|heif)$/i;

export async function classifyDocument(
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): Promise<DocumentType> {
  // Image detection by mime or extension
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.test(filename)) {
    return "image";
  }

  // Only classify PDFs — everything else is "other" (docx, html, pptx, etc.)
  const isPdf =
    mimeType === "application/pdf" ||
    mimeType === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf") ||
    filename.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return "other";
  }

  // Check text layer using pdfjs
  // Same heuristic as services/parse/main.py get_pdf_info():
  // average < 50 chars/page over first 3 pages → scanned
  try {
    // `loadPdfjs` installs the serverless-safe DOMMatrix/ImageData/Path2D
    // polyfills before importing pdfjs. Without it, pdfjs's Node build throws
    // "DOMMatrix is not defined" at import time on Vercel (the native
    // `@napi-rs/canvas` polyfill source can't load), which used to land us in
    // the catch below and silently classify every scan as `digital_pdf`
    // (oss-300 → oss-301). See pdfjs-loader.ts.
    const pdfjsLib = await loadPdfjs();
    // `verbosity: 0` suppresses pdfjs's console.warn output. Matches the same
    // option DigitalPdfProvider uses.
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      verbosity: 0,
    }).promise;
    const pageCount = doc.numPages;
    const sampled = Math.min(pageCount, 3);

    let totalChars = 0;
    for (let i = 1; i <= sampled; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str ?? "").join("");
      totalChars += text.trim().length;
      page.cleanup();
    }
    await doc.destroy();

    const charsPerPage = totalChars / sampled;
    return charsPerPage < 50 ? "scanned_pdf" : "digital_pdf";
  } catch (err) {
    // We could not determine the text layer (corrupt header, encrypted,
    // unexpected pdfjs failure). Treat "can't tell" CONSERVATIVELY as
    // `scanned_pdf` so SmartParseProvider routes to the heavy provider, which
    // reads BOTH scanned and digital PDFs correctly (Docling handles text
    // layers too). The previous default was `digital_pdf`, which sent the doc
    // to pdfjs — and a real scan yields empty text that detectCorruption can't
    // catch (too few tokens), so we'd ship empty markdown instead of OCR
    // output. Defaulting to heavy on uncertainty never produces empty output;
    // worst case a digital PDF pays for the heavy path it would have paid for
    // anyway when the lite path was unavailable (oss-301).
    //
    // The only in-repo caller is SmartParseProvider. (Platform's OCR-overlay
    // Inngest function does its own re-probe and does not rely on this default.)
    console.warn(
      `[classify] could not determine text layer for ${filename}, defaulting to scanned_pdf (→ heavy):`,
      err instanceof Error ? err.message : err,
    );
    return "scanned_pdf";
  }
}
