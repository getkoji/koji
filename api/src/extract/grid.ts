/**
 * Grid extraction (oss-537 / D1) — the 2D view of a table, for extraction.
 *
 * Why this exists
 * ---------------
 * Granular array data — the per-row values of a schedule or an itemized table —
 * is the engine's weakest field class, and the cause is structural rather than model
 * quality: **the pipeline destroys 2D structure before extraction.** The router
 * scores chunks, flattens their text to markdown, and hands a model a string —
 * then asks it to rebuild a nested object from it. Row<->column identity is
 * already gone by the time the prompt is written, so "which value belongs to
 * which row" is a reconstruction problem instead of a lookup.
 *
 * The geometry to avoid that already exists. `PositionalStructuredProvider`
 * (oss-536) emits one {@link ParseUnit} per table cell carrying
 * `table: { tableId, row, col }` and the cell's own bbox, and `provenance.ts`
 * already reads those coordinates — but only *after* extraction, to locate a
 * value a model had already guessed. This module makes the same coordinates
 * available *as* the extraction surface.
 *
 * What a grid is
 * --------------
 * A {@link Grid} is a dense, rectangular `rows[r][c]` of {@link GridCell}s with
 * blanks preserved, one header row, and whatever provenance its source could
 * supply. Two sources fill it, and the difference is only the provenance rung:
 *
 *   - **`cells`** — a run of `role: "table_cell"` units sharing a `tableId`.
 *     Every cell carries a real bbox, so a value read at (row, col) resolves to
 *     exact page geometry with no string matching. This is the path a digital
 *     PDF takes under `KOJI_PARSE_STRUCTURED=positional`.
 *   - **`markdown`** — a GFM pipe table in the markdown projection. No
 *     geometry, but exact character offsets, so provenance is still a real span
 *     and the capability is reachable for every parse path (and for markdown
 *     corpora, which have no geometry at all).
 *
 * `cells` is strictly better and is always preferred when the spine has a table
 * covering the same content. Nothing downstream branches on which one answered
 * beyond the provenance rung it stamps.
 *
 * Column counts are NOT logical
 * -----------------------------
 * The positional path infers columns by x-coordinate clustering
 * (`detectColumns`), and it over-splits: a six-column schedule routinely
 * reports fourteen, with phantom all-blank columns between real ones. What is
 * reliable is **column identity** — every value in one logical column lands on
 * the same index as its header, run after run. So this module, and everything
 * built on it, addresses cells by identity (header <-> value share an index)
 * and never assumes `columnCount` means anything. A phantom column simply has
 * an empty header, maps to no sub-field, and is skipped.
 *
 * Engine-generic: a grid is rows, columns and text. No document category, no
 * field name, no domain vocabulary appears here or in anything it returns.
 */

import type { BBox, ParseChunk } from "../parse/chunk";

/** One addressable cell. `row`/`col` are 1-based, matching `ParseUnit.table`. */
export interface GridCell {
  /** Cell text, trimmed. Empty string for a blank slot. */
  text: string;
  /** 1-based row index within its grid. */
  row: number;
  /** 1-based column index within its grid. */
  col: number;
  /** 1-based page, when the source knows it. */
  page?: number;
  /** Normalized `[0,1]` top-left box, present only on the `cells` source. */
  bbox?: BBox;
  /** Character offset of `text` in the source markdown, when known. */
  offset?: number;
  /** Character length of `text` in the source markdown, when known. */
  length?: number;
  /** The originating `ParseUnit.id`, on the `cells` source. */
  unitId?: string;
}

/** Where a grid's cells came from, and therefore what provenance it can offer. */
export type GridSource = "cells" | "markdown";

/** A dense table: `rows[r][c]`, blanks preserved, one header row. */
export interface Grid {
  /**
   * Stable within one build. `tableId` for the `cells` source (`p<page>-t<n>`),
   * `md-t<n>` for the markdown source.
   */
  id: string;
  source: GridSource;
  /** 1-based page the grid starts on, when known. */
  page?: number;
  /**
   * 0-based index into {@link rows} of the header row, or `-1` when the grid
   * has no header (every row is data).
   */
  headerRow: number;
  /** Dense rows; every row has exactly {@link columnCount} cells. */
  rows: GridCell[][];
  /**
   * Physical column count. **Not a logical count** — see the module note. Use
   * it to iterate, never to reason about the table's shape.
   */
  columnCount: number;
}

/** The header row's cells, or an empty array when the grid has no header. */
export function headerCells(grid: Grid): GridCell[] {
  if (grid.headerRow < 0) return [];
  return grid.rows[grid.headerRow] ?? [];
}

/**
 * The rows below the header, in document order, paired with their 0-based index
 * in {@link Grid.rows} so a caller can address back into the grid.
 */
export function dataRows(grid: Grid): Array<{ index: number; cells: GridCell[] }> {
  const out: Array<{ index: number; cells: GridCell[] }> = [];
  grid.rows.forEach((cells, index) => {
    if (index <= grid.headerRow) return;
    out.push({ index, cells });
  });
  return out;
}

/**
 * The cell at a 0-based row index and 1-based column, or `undefined` when the
 * address is outside the grid. The deterministic read in `grid-tables.ts` goes
 * through here and nowhere else.
 */
export function cellAt(grid: Grid, rowIndex: number, col: number): GridCell | undefined {
  const row = grid.rows[rowIndex];
  if (!row) return undefined;
  return row[col - 1];
}

/** How many cells in a column carry text. Used to break ties between two
 *  physical columns that map to the same sub-field. */
export function columnFill(grid: Grid, col: number): number {
  let n = 0;
  grid.rows.forEach((row, i) => {
    if (i === grid.headerRow) return;
    if ((row[col - 1]?.text ?? "").length > 0) n += 1;
  });
  return n;
}

// ---------------------------------------------------------------------------
// Source 1 — the parse spine's table cells
// ---------------------------------------------------------------------------

/**
 * Build one {@link Grid} per `tableId` in the spine.
 *
 * Cells of one table are emitted as a contiguous run in row-major order by
 * every structured canonicalizer, but this does not rely on that: it groups by
 * `tableId` and squares the result to the largest `row`/`col` seen, re-inserting
 * the blank slots the canonicalizer dropped (a blank cell has no text and no
 * geometry, so no unit is emitted for it — the grid restores its slot from the
 * surviving coordinates). That is what keeps a value under its own header when
 * a row skips a cell.
 */
export function gridsFromSpine(units: readonly ParseChunk[] | undefined): Grid[] {
  if (!units || units.length === 0) return [];

  const byTable = new Map<string, ParseChunk[]>();
  const order: string[] = [];
  for (const u of units) {
    if (u.role !== "table_cell" || !u.table) continue;
    const id = u.table.tableId;
    let bucket = byTable.get(id);
    if (!bucket) {
      bucket = [];
      byTable.set(id, bucket);
      order.push(id);
    }
    bucket.push(u);
  }

  const grids: Grid[] = [];
  for (const id of order) {
    const cells = byTable.get(id)!;
    let maxRow = 0;
    let maxCol = 0;
    for (const u of cells) {
      if (u.table!.row > maxRow) maxRow = u.table!.row;
      if (u.table!.col > maxCol) maxCol = u.table!.col;
    }
    if (maxRow < 1 || maxCol < 1) continue;

    const rows: GridCell[][] = [];
    for (let r = 1; r <= maxRow; r++) {
      const row: GridCell[] = [];
      for (let c = 1; c <= maxCol; c++) row.push({ text: "", row: r, col: c });
      rows.push(row);
    }
    for (const u of cells) {
      const { row, col } = u.table!;
      if (row < 1 || col < 1) continue;
      rows[row - 1]![col - 1] = {
        text: u.text.trim(),
        row,
        col,
        page: u.page,
        ...(u.bbox ? { bbox: u.bbox } : {}),
        ...(u.md_offset !== undefined ? { offset: u.md_offset } : {}),
        ...(u.md_length !== undefined ? { length: u.md_length } : {}),
        unitId: u.id,
      };
    }

    grids.push({
      id,
      source: "cells",
      page: cells[0]?.page,
      // Every structured canonicalizer treats a detected table's first row as
      // the header (`positional-chunks.ts`, the Doc AI and Textract drivers).
      headerRow: 0,
      rows,
      columnCount: maxCol,
    });
  }
  return grids;
}

// ---------------------------------------------------------------------------
// Source 2 — GFM pipe tables in the markdown projection
// ---------------------------------------------------------------------------

/** A `| --- | :--- |` separator row: every cell is dashes with optional colons. */
function isSeparatorCells(cells: readonly string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/**
 * Split one pipe-table line into cells, returning each cell's text plus its
 * absolute offset in the document. Leading and trailing pipes are optional;
 * `\|` is an escaped pipe and does not split (it is how `renderTableGrid`
 * writes a literal pipe inside cell text).
 */
function splitPipeRow(line: string, lineOffset: number): Array<{ text: string; offset: number }> {
  const cells: Array<{ text: string; offset: number }> = [];
  let buf = "";
  let bufStart = 0;
  let started = false;
  let seenPipe = false;

  const push = () => {
    const trimmedStart = buf.length - buf.trimStart().length;
    const text = buf.trim();
    cells.push({ text: text.replace(/\\\|/g, "|"), offset: lineOffset + bufStart + trimmedStart });
    buf = "";
    bufStart = 0;
    started = false;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      if (!started) {
        started = true;
        bufStart = i;
      }
      buf += "\\|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (seenPipe) push();
      seenPipe = true;
      continue;
    }
    if (!seenPipe) continue; // text before the first pipe is not a cell
    if (!started) {
      started = true;
      bufStart = i;
    }
    buf += ch;
  }
  // Text after the last pipe (a table written without a trailing pipe).
  if (started) push();
  return cells;
}

/**
 * Build one {@link Grid} per GFM pipe table in `markdown`.
 *
 * A table is a maximal run of consecutive lines whose first non-space character
 * is `|`. The header is the row above a `| --- |` separator; with no separator
 * the first row is the header, matching how every structured provider projects
 * its grid (`renderTableGrid` always emits a separator, so a Koji-produced
 * markdown table always has one).
 *
 * Rows are squared to the widest row in the table, so a short row keeps its
 * leading columns rather than being compared against a differently-shaped
 * neighbour.
 */
export function gridsFromMarkdown(markdown: string): Grid[] {
  if (!markdown) return [];
  const grids: Grid[] = [];

  const lines = markdown.split("\n");
  const lineOffsets: number[] = [];
  let off = 0;
  for (const line of lines) {
    lineOffsets.push(off);
    off += line.length + 1;
  }

  let i = 0;
  let tableIndex = 0;
  while (i < lines.length) {
    if (lines[i]!.trimStart()[0] !== "|") {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && lines[end + 1]!.trimStart()[0] === "|") end += 1;

    const raw: Array<Array<{ text: string; offset: number }>> = [];
    let separatorAt = -1;
    for (let r = i; r <= end; r++) {
      const cells = splitPipeRow(lines[r]!, lineOffsets[r]!);
      if (cells.length === 0) continue;
      if (separatorAt < 0 && isSeparatorCells(cells.map((c) => c.text))) {
        separatorAt = raw.length; // index of the row this separator would have been
        continue; // separators are structure, not data
      }
      raw.push(cells);
    }

    // A one-row "table" is a formatting artifact, not a grid.
    if (raw.length >= 2) {
      const columnCount = raw.reduce((m, r) => Math.max(m, r.length), 0);
      const rows: GridCell[][] = raw.map((cells, r) => {
        const out: GridCell[] = [];
        for (let c = 0; c < columnCount; c++) {
          const cell = cells[c];
          out.push({
            text: cell?.text ?? "",
            row: r + 1,
            col: c + 1,
            ...(cell && cell.text ? { offset: cell.offset, length: cell.text.length } : {}),
          });
        }
        return out;
      });
      grids.push({
        id: `md-t${tableIndex++}`,
        source: "markdown",
        // The row above the separator is the header; with no separator, row 0.
        headerRow: separatorAt > 0 ? separatorAt - 1 : 0,
        rows,
        columnCount,
      });
    }

    i = end + 1;
  }

  return grids;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Every grid in a document, geometry-backed ones first.
 *
 * When the spine carries table cells they are authoritative: the markdown is a
 * *projection* of those same cells (`spineToMarkdown`), so parsing the
 * projection as well would yield a second, geometry-free copy of each grid and
 * a caller could pick the worse one. Markdown tables are therefore read only
 * when the spine has no cells at all — which is every markdown-native parse,
 * and every corpus document.
 */
export function buildGrids(markdown: string, units?: readonly ParseChunk[]): Grid[] {
  const fromSpine = gridsFromSpine(units);
  if (fromSpine.length > 0) return fromSpine;
  return gridsFromMarkdown(markdown);
}
