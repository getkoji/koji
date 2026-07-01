/**
 * Textract `Blocks` → chunks canonicalizer (PB-8).
 *
 * AWS Textract returns a flat graph of `Block`s linked by `Relationships`,
 * not markdown:
 *
 *   PAGE ──CHILD──▶ LINE ──CHILD──▶ WORD
 *   PAGE ──CHILD──▶ TABLE ──CHILD──▶ CELL ──CHILD──▶ WORD | SELECTION_ELEMENT
 *
 * Each block carries `Geometry.BoundingBox`, which Textract already expresses
 * in **normalized page coordinates** (`Left`/`Top`/`Width`/`Height` as
 * fractions of the page, origin top-left) — the exact convention of
 * {@link BBox}. So mapping a Textract box to a chunk bbox is a direct field
 * rename, no scaling needed.
 *
 * This module is the pure JSON→chunks step (the real engineering work of PB-8):
 * it has no AWS SDK dependency so it can be unit-tested against a sample
 * `Blocks` fixture. The provider in `./textract.ts` calls Textract and feeds
 * the response here.
 *
 * Table reconstruction is the key behavior: CELL blocks carry 1-based
 * `RowIndex`/`ColumnIndex`, so we rebuild the grid from those known cell
 * coordinates and serialize a coherent markdown table where every value sits
 * under its correct column — eliminating the wrong-column failure at the
 * source rather than guessing column association from x-positions later.
 */

import {
  assignUnitIds,
  spineToMarkdown,
  type BBox,
  type ParseChunk,
  type ParseUnitDraft,
  type ChunkCanonicalizer,
} from "../chunk";

/**
 * A Textract bounding box: fractions of the page in [0, 1], origin top-left.
 * Already matches {@link BBox} semantics — only the field names differ.
 */
export interface TextractBoundingBox {
  Width?: number;
  Height?: number;
  Left?: number;
  Top?: number;
}

export interface TextractGeometry {
  BoundingBox?: TextractBoundingBox;
}

export interface TextractRelationship {
  /** "CHILD", "VALUE", "MERGED_CELL", ... — we only consume "CHILD". */
  Type?: string;
  Ids?: string[];
}

/**
 * A single Textract block. All fields optional to structurally match the AWS
 * SDK's `Block` type, so an `AnalyzeDocumentCommandOutput` (or aggregated
 * `GetDocumentAnalysis` pages) can be passed straight through.
 */
export interface TextractBlock {
  Id?: string;
  /** PAGE | LINE | WORD | TABLE | CELL | MERGED_CELL | SELECTION_ELEMENT | ... */
  BlockType?: string;
  Text?: string;
  /** 1-based page number. */
  Page?: number;
  /** 1-based row, present on CELL / MERGED_CELL. */
  RowIndex?: number;
  /** 1-based column, present on CELL / MERGED_CELL. */
  ColumnIndex?: number;
  RowSpan?: number;
  ColumnSpan?: number;
  /** e.g. ["COLUMN_HEADER"] on a header CELL. */
  EntityTypes?: string[];
  /** "SELECTED" | "NOT_SELECTED" on SELECTION_ELEMENT. */
  SelectionStatus?: string;
  Geometry?: TextractGeometry;
  Relationships?: TextractRelationship[];
}

/**
 * The canonicalizer input — structurally a Textract `AnalyzeDocument` /
 * `GetDocumentAnalysis` response (or several merged together for multi-page
 * async jobs).
 */
export interface TextractBlocks {
  Blocks?: TextractBlock[];
  DocumentMetadata?: { Pages?: number };
}

/** Map a Textract bounding box (already normalized) into a {@link BBox}. */
function toBBox(geometry: TextractGeometry | undefined): BBox | undefined {
  const b = geometry?.BoundingBox;
  if (!b) return undefined;
  const x = b.Left;
  const y = b.Top;
  const w = b.Width;
  const h = b.Height;
  if (x == null || y == null || w == null || h == null) return undefined;
  return { x, y, w, h };
}

/** The ids of a block's children of a given relationship type (default CHILD). */
function relatedIds(block: TextractBlock, type = "CHILD"): string[] {
  const ids: string[] = [];
  for (const rel of block.Relationships ?? []) {
    if (rel.Type === type) ids.push(...(rel.Ids ?? []));
  }
  return ids;
}

/** Text of a single CELL: join its WORD children; render selection marks. */
function cellText(cell: TextractBlock, byId: Map<string, TextractBlock>, wordSink: Set<string>): string {
  const parts: string[] = [];
  for (const id of relatedIds(cell)) {
    const child = byId.get(id);
    if (!child) continue;
    if (child.BlockType === "WORD") {
      wordSink.add(id);
      if (child.Text) parts.push(child.Text);
    } else if (child.BlockType === "SELECTION_ELEMENT") {
      parts.push(child.SelectionStatus === "SELECTED" ? "[X]" : "[ ]");
    }
  }
  return parts.join(" ").trim();
}

/** One TABLE block canonicalized to per-cell units plus placement metadata. */
interface TableCells {
  /** Per-cell `table_cell` drafts (id assigned later), row-major ordered. */
  cells: ParseUnitDraft[];
  /** WORD ids consumed by this table, so the line pass can skip them. */
  wordIds: Set<string>;
  /** Table top/left (normalized) for reading-order placement among lines. */
  top: number;
  left: number;
}

/**
 * Turn one TABLE block into per-cell `table_cell` units from its CELLs' known
 * (row, col) coordinates. Cells are addressed by index — never inferred from
 * geometry — so column association is exact (the wrong-column fix). Each cell
 * carries `{ tableId, row, col }`, `role: "table_cell"`, its own bbox, and its
 * raw text; the clean markdown table is reprojected from these by
 * {@link spineToMarkdown}. Empty cells are still emitted so the projected grid
 * keeps its full column count.
 */
function tableToCells(
  table: TextractBlock,
  byId: Map<string, TextractBlock>,
  tableId: string,
): TableCells {
  const wordIds = new Set<string>();
  const page = table.Page ?? 1;
  const raw: { row: number; col: number; text: string; bbox?: BBox }[] = [];

  for (const id of relatedIds(table)) {
    const cell = byId.get(id);
    // Only base CELL blocks define the grid; MERGED_CELL is an overlay we
    // skip (its constituent CELLs already carry the text and coordinates).
    if (!cell || cell.BlockType !== "CELL") continue;
    const row = cell.RowIndex ?? 0;
    const col = cell.ColumnIndex ?? 0;
    if (row <= 0 || col <= 0) continue;
    raw.push({ row, col, text: cellText(cell, byId, wordIds), bbox: toBBox(cell.Geometry) });
  }

  // Row-major so the projected markdown reads top-to-bottom, left-to-right.
  raw.sort((a, b) => a.row - b.row || a.col - b.col);
  const cells: ParseUnitDraft[] = raw.map((c) => ({
    text: c.text,
    page,
    ...(c.bbox ? { bbox: c.bbox } : {}),
    role: "table_cell" as const,
    table: { tableId, row: c.row, col: c.col },
  }));

  const tableBox = toBBox(table.Geometry);
  const cellTop = Math.min(...raw.map((c) => c.bbox?.y ?? Infinity), Infinity);
  const cellLeft = Math.min(...raw.map((c) => c.bbox?.x ?? Infinity), Infinity);
  const top = tableBox?.y ?? (Number.isFinite(cellTop) ? cellTop : 0);
  const left = tableBox?.x ?? (Number.isFinite(cellLeft) ? cellLeft : 0);
  return { cells, wordIds, top, left };
}

/**
 * Converts a Textract `Blocks` graph into ordered chunks-with-bbox.
 *
 * - Tables → one chunk per TABLE, serialized as a markdown grid from cell
 *   (row, col) indices (correct column association by construction).
 * - Everything else → one chunk per LINE, skipping LINEs whose words are all
 *   consumed by a table (avoids double-emitting table text as loose lines).
 * - Chunks are sorted by (page, top, left) so they land in reading order even
 *   though Textract emits tables as a separate block subtree.
 */
export class TextractCanonicalizer implements ChunkCanonicalizer<TextractBlocks> {
  toChunks(structured: TextractBlocks): ParseChunk[] {
    const blocks = structured.Blocks ?? [];
    const byId = new Map<string, TextractBlock>();
    for (const b of blocks) {
      if (b.Id) byId.set(b.Id, b);
    }

    const tableWordIds = new Set<string>();

    // Each item is a group of contiguous units — a table's cells (kept together
    // and row-major) or a single free-text line — keyed by (page, top, left) so
    // the flattened spine lands in natural reading order.
    interface Item {
      page: number;
      y: number;
      x: number;
      units: ParseUnitDraft[];
    }
    const items: Item[] = [];

    // Tables first — they tell us which words are already accounted for.
    let tableIndex = 0;
    for (const b of blocks) {
      if (b.BlockType !== "TABLE") continue;
      const page = b.Page ?? 1;
      const tableId = `p${page}-t${tableIndex++}`;
      const { cells, wordIds, top, left } = tableToCells(b, byId, tableId);
      for (const id of wordIds) tableWordIds.add(id);
      if (cells.length > 0) items.push({ page, y: top, x: left, units: cells });
    }

    // Lines that aren't entirely inside a table become text units.
    for (const b of blocks) {
      if (b.BlockType !== "LINE") continue;
      const wordIds = relatedIds(b);
      const allInTable = wordIds.length > 0 && wordIds.every((id) => tableWordIds.has(id));
      if (allInTable) continue;

      const text =
        (b.Text ?? "").trim() ||
        wordIds
          .map((id) => byId.get(id)?.Text ?? "")
          .join(" ")
          .trim();
      if (!text) continue;

      const bbox = toBBox(b.Geometry);
      const page = b.Page ?? 1;
      items.push({
        page,
        y: bbox?.y ?? 0,
        x: bbox?.x ?? 0,
        units: [{ text, page, ...(bbox ? { bbox } : {}), role: "line" }],
      });
    }

    items.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    const drafts: ParseUnitDraft[] = [];
    for (const it of items) drafts.push(...it.units);
    return assignUnitIds(drafts);
  }
}

/**
 * Serialize canonicalized units into a single markdown document — the
 * `ParseResponse.markdown` view the extraction layer consumes today. Markdown
 * is a projection of the spine: `table_cell` runs are reassembled into a grid,
 * every other unit is joined as a paragraph (see {@link spineToMarkdown}).
 */
export function chunksToMarkdown(chunks: ParseChunk[]): string {
  return spineToMarkdown(chunks);
}
