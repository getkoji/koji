/**
 * Digital-positional path (PB-6) — turn pdfjs geometry into provenance-carrying
 * chunks WITHOUT cloud OCR.
 *
 * `DigitalPdfProvider` already extracts every text run's exact position (x, y,
 * width, height in top-down page units) into `ParsedPage[]`. Today that geometry
 * is consumed only by `spatialToMarkdown` and then discarded — the markdown
 * string keeps the words but loses their coordinates. This module is the second
 * consumer of the *same* positional structure: it canonicalizes `ParsedPage[]`
 * into {@link ParseChunk}s with populated `bbox`, so the digital path carries
 * provenance for free (see `docs/parse-strategy.md`).
 *
 * The high-leverage piece is **table reconstruction via x-coordinate
 * clustering**. Reading-order serialization (what a naive markdown flatten does)
 * loses column association the moment a row skips a cell: the surviving values
 * slide left under the wrong header. By clustering text-run x-positions into
 * columns and assigning every run to its nearest column, a value stays under its
 * own header even when neighbouring cells are blank. Each reconstructed row
 * becomes one chunk whose text places the cells in fixed column slots (empties
 * preserved), so column association survives into the chunk stream — and the
 * row's bounding box rides along as provenance.
 *
 * This reuses the line-grouping and column-clustering primitives already proven
 * by `spatialToMarkdown` (one x-clustering implementation, not two). It is
 * additive: the markdown output of the digital path is unchanged; chunks are an
 * extra, parallel view on `ParseResponse.chunks`.
 */

import {
  unionBBox,
  normalizeBBox,
  assignUnitIds,
  type BBox,
  type ParseChunk,
  type ParseUnitDraft,
  type ChunkCanonicalizer,
} from "./chunk";
import {
  buildLines,
  detectColumns,
  detectTableRegion,
  findColumn,
  type Line,
  type ParsedPage,
  type TextItem,
} from "./spatial-to-markdown";

/** Page dimensions in the same (absolute, top-down) units as the text items. */
interface PageDims {
  width: number;
  height: number;
}

/** A single reconstructed table row: cells placed in fixed column slots. */
export interface ReconstructedRow {
  /**
   * One entry per detected column (in left-to-right order). A blank string
   * marks a column the row has no text in — preserved so later rows don't slide
   * under the wrong header.
   */
  cells: string[];
  /** Bounding box enclosing the row's text, in normalized page coordinates. */
  bbox?: BBox;
}

/** A table reconstructed from positional text via x-coordinate clustering. */
export interface ReconstructedTable {
  /** Column centroid x-positions (absolute page units), left to right. */
  columns: number[];
  /** Rows in top-to-bottom reading order; first row is conventionally the header. */
  rows: ReconstructedRow[];
}

/** Normalized box for a single text item, or undefined if the page has no size. */
function itemBox(item: TextItem, page: PageDims): BBox | undefined {
  // `item.y` is the glyph baseline (top-down), where the text sits — not the
  // top of its box. Glyphs extend upward from the baseline, so the box top is
  // one glyph height above it. Using the raw baseline as the top drops the
  // provenance box a full line below the text.
  return normalizeBBox(
    { x: item.x, y: Math.max(0, item.y - item.height), w: item.width, h: item.height },
    page.width,
    page.height,
  );
}

/** Union of every text item's normalized box on a line. */
function lineBBox(line: Line, page: PageDims): BBox | undefined {
  const boxes = line.items
    .map((i) => itemBox(i, page))
    .filter((b): b is BBox => b !== undefined);
  return unionBBox(boxes);
}

/**
 * Reconstruct a table from a contiguous run of lines using x-coordinate
 * clustering. Each text run is assigned to its nearest detected column, so a
 * value lands under its own header even when adjacent cells are blank — the fix
 * for the wrong-column failure on dec pages and similar grids.
 *
 * Returns columns plus per-row cell arrays (length === columns.length, blanks
 * preserved) and a normalized row bbox.
 */
export function reconstructTable(
  tableLines: Line[],
  page: PageDims,
): ReconstructedTable {
  const columns = detectColumns(tableLines, page.width);

  const rows: ReconstructedRow[] = [];
  for (const line of tableLines) {
    // One bucket of text items per column; items keep their left-to-right order
    // because createLine already sorted each line's items by x.
    const buckets: TextItem[][] = columns.map(() => []);
    for (const item of line.items) {
      const col = findColumn(item.x, columns);
      if (col >= 0) buckets[col]!.push(item);
    }
    const cells = buckets.map((items) =>
      items
        .map((t) => t.text)
        .join(" ")
        .trim(),
    );
    rows.push({ cells, bbox: lineBBox(line, page) });
  }

  return { columns, rows };
}

/** Render a reconstructed row as a markdown table row, preserving empty cells. */
function renderRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/**
 * Canonicalizes the digital-PDF positional structure (`ParsedPage[]`, the exact
 * shape `DigitalPdfProvider` already builds from pdfjs) into ordered
 * chunks-with-provenance.
 *
 * - Table regions (detected by the same heuristic the markdown path uses) are
 *   reconstructed via x-clustering and emitted one chunk per row, so column
 *   association is preserved in the chunk text and a row-level bbox rides along.
 * - Every other line becomes one chunk carrying its own bbox.
 * - Pages with no text items fall back to the page's raw text with no bbox.
 *
 * Chunks are emitted in natural reading order; `bbox` is left undefined only
 * when the page reports a non-positive size (no usable geometry).
 */
export class PositionalChunkCanonicalizer
  implements ChunkCanonicalizer<ParsedPage[]>
{
  toChunks(pages: ParsedPage[]): ParseChunk[] {
    const drafts: ParseUnitDraft[] = [];

    for (const page of pages) {
      if (page.textItems.length === 0) {
        const fallback = page.text.trim();
        if (fallback) drafts.push({ text: fallback, page: page.pageNum, role: "line" });
        continue;
      }

      const lines = buildLines(page.textItems, page.height);

      let i = 0;
      while (i < lines.length) {
        const line = lines[i]!;
        if (!line.text) {
          i++;
          continue;
        }

        // Table region? detectTableRegion returns the index of the last table
        // line; a span of >= 3 lines (end > start + 1) is a real table.
        const tableEnd = detectTableRegion(lines, i, page.width);
        if (tableEnd > i + 1) {
          const tableLines = lines.slice(i, tableEnd + 1);
          const { columns, rows } = reconstructTable(tableLines, page);
          if (columns.length >= 2) {
            for (const row of rows) {
              const text = renderRow(row.cells);
              if (text.replace(/[|\s]/g, "")) {
                // Row-granular reconstruction, not true cells — the positional
                // path has no cell identity, so `role`/`table` are left off
                // (best-effort per Decision 2). The row text and bbox still ride
                // along as an addressable line-level unit.
                drafts.push({ text, page: page.pageNum, bbox: row.bbox });
              }
            }
            i = tableEnd + 1;
            continue;
          }
        }

        // Plain line → one unit with its own bbox.
        drafts.push({
          text: line.text,
          page: page.pageNum,
          bbox: lineBBox(line, page),
          role: "line",
        });
        i++;
      }
    }

    // Stamp parse-scoped, reading-order ids in one deterministic pass.
    return assignUnitIds(drafts);
  }
}
