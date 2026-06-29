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
  unionBBox,
  type BBox,
  type ParseChunk,
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

/** Escape a pipe so it can't break the serialized markdown table grid. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

interface TableChunk {
  chunk: ParseChunk | null;
  /** WORD ids consumed by this table, so the line pass can skip them. */
  wordIds: Set<string>;
}

/**
 * Rebuild one TABLE block into a markdown table chunk from its CELLs'
 * known (row, col) coordinates. Cells are placed by index — never inferred
 * from geometry — so column association is exact.
 */
function tableToChunk(table: TextractBlock, byId: Map<string, TextractBlock>): TableChunk {
  const wordIds = new Set<string>();
  const grid = new Map<string, string>(); // "row,col" → text
  const cellBoxes: BBox[] = [];
  let maxRow = 0;
  let maxCol = 0;

  for (const id of relatedIds(table)) {
    const cell = byId.get(id);
    // Only base CELL blocks define the grid; MERGED_CELL is an overlay we
    // skip (its constituent CELLs already carry the text and coordinates).
    if (!cell || cell.BlockType !== "CELL") continue;
    const row = cell.RowIndex ?? 0;
    const col = cell.ColumnIndex ?? 0;
    if (row <= 0 || col <= 0) continue;
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
    grid.set(`${row},${col}`, cellText(cell, byId, wordIds));
    const bbox = toBBox(cell.Geometry);
    if (bbox) cellBoxes.push(bbox);
  }

  if (maxRow === 0 || maxCol === 0) return { chunk: null, wordIds };

  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const cols: string[] = [];
    for (let c = 1; c <= maxCol; c++) {
      cols.push(escapeCell(grid.get(`${r},${c}`) ?? ""));
    }
    lines.push(`| ${cols.join(" | ")} |`);
    // Emit a markdown header separator after the first row so the serialized
    // table is valid markdown a downstream LLM reads naturally.
    if (r === 1) {
      lines.push(`| ${Array.from({ length: maxCol }, () => "---").join(" | ")} |`);
    }
  }

  const text = lines.join("\n");
  const bbox = toBBox(table.Geometry) ?? unionBBox(cellBoxes);
  const page = table.Page ?? 1;
  return {
    chunk: { text, page, ...(bbox ? { bbox } : {}) },
    wordIds,
  };
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
    const candidates: Array<{ page: number; y: number; x: number; chunk: ParseChunk }> = [];

    // Tables first — they tell us which words are already accounted for.
    for (const b of blocks) {
      if (b.BlockType !== "TABLE") continue;
      const { chunk, wordIds } = tableToChunk(b, byId);
      for (const id of wordIds) tableWordIds.add(id);
      if (chunk) {
        candidates.push({
          page: chunk.page,
          y: chunk.bbox?.y ?? 0,
          x: chunk.bbox?.x ?? 0,
          chunk,
        });
      }
    }

    // Lines that aren't entirely inside a table become text chunks.
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
      candidates.push({
        page,
        y: bbox?.y ?? 0,
        x: bbox?.x ?? 0,
        chunk: { text, page, ...(bbox ? { bbox } : {}) },
      });
    }

    candidates.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    return candidates.map((c) => c.chunk);
  }
}

/**
 * Serialize canonicalized chunks into a single markdown document — the
 * `ParseResponse.markdown` view the extraction layer consumes today. Table
 * chunks are already markdown; text chunks are joined as paragraphs.
 */
export function chunksToMarkdown(chunks: ParseChunk[]): string {
  return chunks.map((c) => c.text).join("\n\n");
}
