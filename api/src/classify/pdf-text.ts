/**
 * Cheap windowed page-text extraction (Tier 1).
 *
 * Pulls embedded text for just the selected page window via pdfjs — no OCR, no
 * sidecar, no paid provider. This is the free signal the deterministic and LLM
 * tiers run on. Scanned pages (no text layer) come back empty, which is the
 * cascade's cue to escalate to the vision tier.
 *
 * Mirrors the sampling in parse/classify.ts and services/parse/main.py, but
 * returns per-page text for a caller-chosen window rather than a single
 * digital/scanned verdict.
 */

import type { ScanStrategy } from "./config";
import type { PageText } from "./types";
import { selectWindow } from "./window";
import { loadPdfjs } from "../parse/pdfjs-loader";

export interface WindowResult {
  totalPages: number;
  pages: PageText[];
}

/** Injected-dependency shape the cascade uses to read text. */
export type GetPageTexts = (
  fileBuffer: Buffer,
  window: number,
  scan: ScanStrategy,
) => Promise<WindowResult>;

/**
 * Open the PDF, decide the window from (window, scan), and extract text for
 * exactly those pages. Returns an empty page list (with a best-effort total)
 * when the document can't be read as a PDF — the cascade treats that as "no
 * cheap text available" and falls through to the paid tiers.
 */
export async function readPdfWindow(
  fileBuffer: Buffer,
  window: number,
  scan: ScanStrategy,
): Promise<WindowResult> {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(fileBuffer), verbosity: 0 }).promise;
  } catch {
    // Not a readable PDF (image, corrupt, encrypted). No cheap text.
    return { totalPages: 0, pages: [] };
  }

  try {
    const totalPages = doc.numPages;
    const wanted = selectWindow(totalPages, window, scan);
    const pages: PageText[] = [];

    for (const pageNum of wanted) {
      const page = await doc.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        // pdfjs items are TextItem | TextMarkedContent; only the former has
        // `str`. Match parse/classify.ts and coerce via any.
        const text = content.items.map((it: any) => it.str ?? "").join(" ");
        pages.push({ page: pageNum, text });
      } finally {
        page.cleanup();
      }
    }
    return { totalPages, pages };
  } finally {
    await doc.destroy();
  }
}
