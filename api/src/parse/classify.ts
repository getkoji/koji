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
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // `verbosity: 0` suppresses pdfjs's console.warn output. In some
    // serverless runtimes (Vercel functions, certain Node builds) those
    // warnings are bridged through `console.error` and a downstream
    // handler can turn them into a thrown exception — which would land
    // us in the catch block below and silently return "digital_pdf" for
    // a scan. Matches the same option DigitalPdfProvider uses.
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
  } catch {
    // If we can't parse the PDF header, assume digital (safe fallback —
    // pdfjs will try and the SmartParseProvider falls back to heavy on
    // error). NOTE: this default is wrong for OCR overlay decisions —
    // see the re-probe in platform's OCR overlay Inngest function
    // (platform-127). Don't change this default without auditing every
    // caller of classifyDocument.
    return "digital_pdf";
  }
}
