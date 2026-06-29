/**
 * Content-shape classifier — a *layout* signal, orthogonal to the source-type
 * signal that `classify.ts` produces (digital vs scanned vs image vs other).
 *
 * `classifyDocument` answers "which parser engine can read this file at all"
 * (pdfjs needs a text layer; OCR/docling handle the rest). This module answers
 * a different question used by `SmartParseProvider`'s doc-type routing: "is the
 * content table-heavy or text-heavy?" — so table-heavy docs can be steered to a
 * structured provider (Google Doc AI / Textract / positional) that preserves
 * row/column structure, while text-heavy docs go to the markdown/docling path.
 *
 * The signal is geometric, not lexical: we sample the PDF's text-item positions
 * via pdfjs and measure how much of the page reads as a grid (many rows that
 * each span several aligned columns) vs prose (rows that are one long run of
 * text). This is generic — it never inspects field names, document categories,
 * or any domain vocabulary; it only looks at where glyphs sit on the page.
 *
 * IMPORTANT (dormant cost): this is only invoked by `SmartParseProvider` when a
 * tenant has actually configured a *structured* parse provider. With no
 * structured provider configured (the default for every tenant today), routing
 * is unchanged and this classifier never runs — so it adds zero latency to the
 * production path.
 *
 * Conservative default: anything we can't sample geometrically (scanned PDFs
 * with no text layer, images, non-PDF formats, parse errors) is reported as
 * `text_heavy` so it routes to the existing markdown/docling path — i.e. the
 * current behaviour, never a surprise structured-provider call.
 */

export type ContentShape = "table_heavy" | "text_heavy";

/** A positioned text run sampled from a page (pdfjs item geometry). */
export interface ShapeItem {
  /** The text of the run (used only for cell-length signal). */
  str: string;
  /** Left edge, in PDF user-space points. */
  x: number;
  /** Baseline y, in PDF user-space points. */
  y: number;
  /** Run width, in points. */
  w: number;
}

/**
 * Tunables for {@link scoreTableDensity}. Defaults are deliberately
 * conservative — we only call a document table-heavy when a clear majority of
 * its lines read as multi-column grids.
 */
export interface TableDensityOptions {
  /** Lines with at least this many column clusters count as "tabular". */
  minColumnsForTabularRow?: number;
  /** Fraction of tabular rows at/above which the doc is "table_heavy". */
  tabularRowFraction?: number;
  /** Vertical tolerance (points) for grouping runs onto the same line. */
  rowTolerance?: number;
  /** Horizontal gap (points) above which two runs are distinct columns. */
  columnGap?: number;
  /** Ignore lines with fewer than this many runs when scoring. */
  minRunsPerRow?: number;
}

const DEFAULTS: Required<TableDensityOptions> = {
  minColumnsForTabularRow: 3,
  tabularRowFraction: 0.5,
  rowTolerance: 3,
  columnGap: 24,
  minRunsPerRow: 2,
};

/**
 * Pure scorer: given positioned text runs from one or more pages, decide
 * whether the layout is table-heavy. Exported so the geometry heuristic can be
 * unit-tested without standing up pdfjs or a real PDF.
 *
 * Algorithm:
 *  1. Bucket runs into lines by rounding `y` to `rowTolerance` bands.
 *  2. Within a line, cluster runs into columns whenever the horizontal gap
 *     between consecutive runs exceeds `columnGap`.
 *  3. A line is "tabular" when it has >= `minColumnsForTabularRow` columns and
 *     its cells are short (grids hold values/labels, not sentences).
 *  4. The document is `table_heavy` when the tabular-line fraction (over lines
 *     with enough runs to judge) meets `tabularRowFraction`.
 */
export function scoreTableDensity(
  items: ShapeItem[],
  opts: TableDensityOptions = {},
): ContentShape {
  const o = { ...DEFAULTS, ...opts };
  const usable = items.filter((it) => it.str.trim().length > 0);
  if (usable.length < 12) return "text_heavy"; // too little signal → prose-safe

  // 1. Group into lines by quantized y.
  const lines = new Map<number, ShapeItem[]>();
  for (const it of usable) {
    const band = Math.round(it.y / o.rowTolerance);
    const bucket = lines.get(band);
    if (bucket) bucket.push(it);
    else lines.set(band, [it]);
  }

  let judged = 0;
  let tabular = 0;
  for (const runs of lines.values()) {
    if (runs.length < o.minRunsPerRow) continue;
    judged++;

    // 2. Sort by x and split into column clusters on wide gaps.
    const sorted = [...runs].sort((a, b) => a.x - b.x);
    let columns = 1;
    let cellChars = sorted[0]!.str.trim().length;
    let cellCount = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const gap = cur.x - (prev.x + prev.w);
      if (gap > o.columnGap) {
        columns++;
        cellCount++;
        cellChars += cur.str.trim().length;
      } else {
        // same column, continuation of a run
        cellChars += cur.str.trim().length;
      }
    }
    const avgCellLen = cellChars / Math.max(cellCount, 1);

    // 3. Tabular line: enough columns and the cells are short-ish (grids carry
    //    values/labels, not full sentences). 40 chars is a generous ceiling.
    if (columns >= o.minColumnsForTabularRow && avgCellLen <= 40) {
      tabular++;
    }
  }

  if (judged === 0) return "text_heavy";
  return tabular / judged >= o.tabularRowFraction ? "table_heavy" : "text_heavy";
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|tiff?|bmp|webp|gif|heic|heif)$/i;

/**
 * Classify a document's content shape from its raw bytes. PDFs are sampled via
 * pdfjs geometry; everything else (images, DOCX/HTML/PPTX, scans with no text
 * layer, or any parse error) falls back to `text_heavy` — the safe, current
 * behaviour that keeps routing on the markdown/docling path.
 */
export async function classifyContentShape(
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
  opts?: TableDensityOptions,
): Promise<ContentShape> {
  // Images and non-PDF formats have no cheap pre-parse geometry signal.
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.test(filename)) {
    return "text_heavy";
  }
  const isPdf =
    mimeType === "application/pdf" ||
    (mimeType === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf")) ||
    filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "text_heavy";

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      verbosity: 0,
    }).promise;
    const sampled = Math.min(doc.numPages, 3);

    const items: ShapeItem[] = [];
    for (let i = 1; i <= sampled; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const raw of content.items as any[]) {
        const str = typeof raw.str === "string" ? raw.str : "";
        // transform = [a, b, c, d, e, f]; e = x, f = y in user space.
        const tr = raw.transform as number[] | undefined;
        const x = tr?.[4] ?? 0;
        const y = tr?.[5] ?? 0;
        const w = typeof raw.width === "number" ? raw.width : 0;
        items.push({ str, x, y, w });
      }
      page.cleanup();
    }
    await doc.destroy();

    return scoreTableDensity(items, opts);
  } catch {
    // Unparseable / encrypted / scanned-without-text → prose-safe default.
    return "text_heavy";
  }
}
