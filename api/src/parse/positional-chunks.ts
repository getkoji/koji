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
 *
 * Two canonicalizers share that reconstruction, differing only in granularity
 * inside a table region:
 *
 *   - {@link PositionalChunkCanonicalizer} — one unit per table *row*. The
 *     default digital-PDF view (`DigitalPdfProvider`), unchanged.
 *   - {@link PositionalCellCanonicalizer} — one unit per table *cell*, carrying
 *     `role: "table_cell"`, `table: { tableId, row, col }` and the cell's own
 *     box. The credential-free structured view (`PositionalStructuredProvider`),
 *     i.e. the same cell shape the JSON-native vendors emit, with no cloud call.
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
  /**
   * Per-cell bounding boxes, same length and order as {@link cells}, in
   * normalized page coordinates. `undefined` for a column the row has no text
   * in (a blank cell has no geometry) or when the page reports no usable size.
   * This is what lets a consumer address an individual (row, col) cell by its
   * own box rather than the whole row's.
   */
  cellBoxes: (BBox | undefined)[];
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
 * preserved), a per-cell box array in the same order, and a normalized row
 * bbox.
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
    // One box per column slot: the union of the boxes of the items that landed
    // in that slot. An empty slot has no geometry, so it stays undefined rather
    // than borrowing the row's box.
    const cellBoxes = buckets.map((items) =>
      unionBBox(
        items.map((i) => itemBox(i, page)).filter((b): b is BBox => b !== undefined),
      ),
    );
    rows.push({ cells, cellBoxes, bbox: lineBBox(line, page) });
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

/**
 * Cell-granular canonicalizer for the digital-positional path — the
 * credential-free structured parse view.
 *
 * Same geometry source and the same x-clustering as
 * {@link PositionalChunkCanonicalizer}, but it emits **one unit per table
 * cell** instead of one per table row: `role: "table_cell"`,
 * `table: { tableId, row, col }`, and the cell's own bounding box. That is the
 * shape a consumer needs to address a value at a known (row, col) and resolve
 * it to an exact box — the same shape the JSON-native vendors (Google Document
 * AI, AWS Textract) produce, reached without a cloud call.
 *
 * `tableId` is parse-scoped (`p<page>-t<index>`), `row`/`col` are 1-based, and
 * the first row of a detected table region is conventionally the header. Cells
 * of one table are emitted as a contiguous run in row-major order, so
 * `spineToMarkdown` reassembles exactly that grid. Blank column slots carry no
 * text and no geometry, so no unit is emitted for them — the grid projection
 * re-inserts them as empty cells from the surviving `row`/`col` numbers.
 *
 * Non-table lines are emitted exactly as the row-granular canonicalizer emits
 * them (`role: "line"` with the line's box), so the two differ only inside
 * table regions.
 */
export class PositionalCellCanonicalizer
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
      let tableIndex = 0;

      let i = 0;
      while (i < lines.length) {
        const line = lines[i]!;
        if (!line.text) {
          i++;
          continue;
        }

        const tableEnd = detectTableRegion(lines, i, page.width);
        if (tableEnd > i + 1) {
          const tableLines = lines.slice(i, tableEnd + 1);
          const { columns, rows } = reconstructTable(tableLines, page);
          if (columns.length >= 2) {
            const tableId = `p${page.pageNum}-t${tableIndex++}`;
            rows.forEach((row, rowIdx) => {
              row.cells.forEach((text, colIdx) => {
                if (!text) return; // blank slot: no text, no geometry, no unit
                drafts.push({
                  text,
                  page: page.pageNum,
                  bbox: row.cellBoxes[colIdx],
                  role: "table_cell",
                  table: { tableId, row: rowIdx + 1, col: colIdx + 1 },
                });
              });
            });
            i = tableEnd + 1;
            continue;
          }
        }

        drafts.push({
          text: line.text,
          page: page.pageNum,
          bbox: lineBBox(line, page),
          role: "line",
        });
        i++;
      }
    }

    return assignUnitIds(drafts);
  }
}
