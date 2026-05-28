/**
 * Document type classifier — determines whether a document is a digital PDF
 * (has text layer), scanned PDF (needs OCR), image, or other format.
 *
 * Used by SmartParseProvider to route documents to the appropriate parser:
 * - digital_pdf / other → LiteParse (fast, Rust, no OCR)
 * - scanned_pdf / image → Docling/Modal (OCR-capable)
 *
 * The heuristic matches services/parse/main.py get_pdf_info() exactly:
 * average < 50 chars/page over the first 3 pages → scanned.
 */

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

  // Check text layer using pdf-parse
  // Same heuristic as services/parse/main.py get_pdf_info():
  // average < 50 chars/page over first 3 pages → scanned
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) }).promise;
    const pageCount = doc.numPages;
    const sampled = Math.min(pageCount, 3);

    let totalChars = 0;
    for (let i = 1; i <= sampled; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => item.str ?? "").join("");
      totalChars += text.trim().length;
    }
    doc.destroy();

    const charsPerPage = totalChars / sampled;
    return charsPerPage < 50 ? "scanned_pdf" : "digital_pdf";
  } catch {
    // If we can't parse the PDF header, assume digital (safe fallback —
    // LiteParse will try and the SmartParseProvider catches errors)
    return "digital_pdf";
  }
}
