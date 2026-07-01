/**
 * Parse output contract — the provenance-carrying chunk and the canonicalizer
 * seam (PB-1, the keystone of the pluggable-parse work; see
 * `docs/parse-strategy.md` and `docs/byo-parse-providers.md`).
 *
 * The abstraction boundary between parse and extraction is the **chunk**, not a
 * universal canonical document. Multiple prep paths converge on the same chunk
 * shape, each populating provenance (`bbox`) as richly as its source allows:
 *
 *   - markdown-native providers (Mistral, Azure layout, docling) → text only,
 *     bbox left sparse;
 *   - the digital-positional path (PB-6, pdfjs geometry) → bbox from known
 *     coordinates;
 *   - JSON-native providers (PB-7 Google Document AI, PB-8 AWS Textract) →
 *     bbox from layout anchors / block geometry.
 *
 * Deliberately there is **no lowest-common-denominator IR**. Each structured
 * provider keeps its own native representation and converts it into chunks via
 * a {@link ChunkCanonicalizer} for that representation. This file defines the
 * chunk type, the canonicalizer seam, and the small generic geometry helpers
 * every canonicalizer needs (so PB-6/7/8 implement *into* a shared seam rather
 * than each inventing one).
 *
 * Status: additive and dormant. Nothing in the live markdown → extraction path
 * consumes these types yet. Structured providers (PB-6/7/8) and provenance
 * wiring (PB-11) implement against this seam in later tasks.
 */

/**
 * THE CANONICAL BOUNDING-BOX COORDINATE CONVENTION — the single source of truth
 * for every parse provider in Koji. If you emit geometry from a parser, it MUST
 * conform to this exactly; the dashboard renders highlights straight from these
 * stored values with zero per-provider coordinate math.
 *
 * 1. **Normalized floats in `[0, 1]`.** `x`/`w` are fractions of the page
 *    width; `y`/`h` are fractions of the page height. Never pixels, never PDF
 *    points. (Convert absolute units with {@link normalizeBBox}.)
 * 2. **Origin top-left, y increases downward.** `y = 0` is the top edge of the
 *    page, `y = 1` the bottom. PDF user space (origin bottom-left) MUST be
 *    flipped before emission.
 * 3. **Page-indexed starting at 1.** The `BBox` itself carries no page; the
 *    companion `page` field on {@link ParseChunk} / `TextMapSegment` does, and
 *    the first page is `1` (never `0`).
 *
 * This convention applies identically to both {@link ParseChunk.bbox} and the
 * flat `x,y,w,h` on `TextMapSegment` (`api/src/parse/provider.ts`), and matches
 * the extract layer's provenance `BBox` (`api/src/extract/provenance.ts`).
 * Keeping one convention everywhere means a chunk/word box flows straight into
 * provenance highlighting without conversion.
 *
 * Providers that cannot produce normalized coords (they lack the page
 * dimensions) MUST leave the box `undefined` — never emit raw pixel/point
 * coordinates that would silently violate this contract. Use
 * {@link assertNormalizedBBox} in tests to enforce conformance.
 */
export interface BBox {
  /** Left edge, fraction of page width in [0, 1]. */
  x: number;
  /** Top edge, fraction of page height in [0, 1]. */
  y: number;
  /** Width, fraction of page width in [0, 1]. */
  w: number;
  /** Height, fraction of page height in [0, 1]. */
  h: number;
}

/**
 * The role a {@link ParseUnit} plays in the document — a light, best-effort
 * classification, NOT a document AST. Canonicalizers set it only where they
 * trivially know (a Doc AI paragraph, a Textract table cell, a positional
 * line); it is omitted otherwise. Consumers must treat a missing role as
 * "unknown," never as an error.
 */
export type ParseUnitRole =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table_cell"
  | "line";

/**
 * The **parse spine** unit — an *addressable* piece of parsed text carrying
 * provenance. The convergence point of every parse path and the keystone type
 * for anchored extraction / deterministic provenance.
 *
 * **`id` is parse-scoped** (Decision 1, `docs/parse-spine-model.md`): it is a
 * stable handle WITHIN a single parse result only — `p<page>-u<index>`, the
 * unit's 0-based position in reading order on its page. It is deterministic for
 * a given ordered set of units (same units -> same ids across runs) but carries
 * **no** cross-provider or cross-re-parse guarantee: re-parsing the same bytes
 * with a different provider segments differently and yields different ids. The
 * durable provenance artifact is the resolved **bbox** (+ resolution rung),
 * never the id — see {@link assignUnitIds} and `extract/provenance.ts`.
 *
 * `bbox` is **optional** by design: markdown-native providers cannot supply
 * geometry, while positional/structured providers can. It uses the one
 * canonical convention (normalized `[0,1]`, top-left origin — see {@link BBox}).
 * `md_offset`/`md_length` locate the unit in the projected markdown (oss-317).
 * `role`/`table` are best-effort structure (Decision 2).
 */
export interface ParseUnit {
  /**
   * Parse-scoped, reading-order identifier (`p<page>-u<index>`). Stable within
   * one parse result only; assign deterministically via {@link assignUnitIds}.
   */
  id: string;
  /** 1-based page number this unit's text appears on. */
  page: number;
  /** The unit's text content. */
  text: string;
  /**
   * Bounding box of the unit on its page, in the canonical normalized `[0,1]`
   * top-left convention. Present only when the source path carries geometry
   * (positional / JSON-native).
   */
  bbox?: BBox;
  /** Character offset of this unit's text in the projected markdown (oss-317). */
  md_offset?: number;
  /** Character length of this unit's text in the projected markdown (oss-317). */
  md_length?: number;
  /** Best-effort role; omitted when the canonicalizer doesn't trivially know it. */
  role?: ParseUnitRole;
  /**
   * Table cell coordinates — present only on `role: "table_cell"` units emitted
   * by a provider with true cell structure (Doc AI, Textract). 1-based
   * `row`/`col`; `tableId` is parse-scoped (`p<page>-t<index>`).
   */
  table?: { tableId: string; row: number; col: number };
}

/** The flat, reading-order parse spine — the ordered list of {@link ParseUnit}s. */
export type ParseSpine = ParseUnit[];

/**
 * `ParseChunk` is an **alias** of {@link ParseUnit} (Decision: no rename churn).
 * Historically the parse<->extract boundary was the "chunk"; the spine is the
 * same array, now enriched with `id`/`role`/`table`/offsets. Existing
 * `ParseChunk` consumers keep compiling — the type is a superset of the old
 * `{ text, page, bbox? }` shape (with `id` now required on constructed units).
 */
export type ParseChunk = ParseUnit;

/**
 * A {@link ParseUnit} before its parse-scoped `id` is assigned. Canonicalizers
 * build these in reading order, then hand the list to {@link assignUnitIds} to
 * stamp ids in one deterministic pass.
 */
export type ParseUnitDraft = Omit<ParseUnit, "id">;

/**
 * Stamp parse-scoped ids onto units in reading order, per page. The `id` of the
 * i-th unit on page P (in the given array order) is `p${P}-u${i}` where `i`
 * restarts at 0 for each page.
 *
 * Deterministic and pure: the same ordered drafts always produce the same ids,
 * which is what "stable within a parse run" (Decision 1) means. Re-running it on
 * already-id'd units (e.g. after page renumbering in a shard merge) simply
 * reassigns fresh, correct ids — the durable artifact is the bbox, not the id,
 * so overwriting ids across a re-id pass is safe.
 */
export function assignUnitIds(drafts: readonly ParseUnitDraft[]): ParseUnit[] {
  const perPage = new Map<number, number>();
  return drafts.map((d) => {
    const i = perPage.get(d.page) ?? 0;
    perPage.set(d.page, i + 1);
    return { ...d, id: `p${d.page}-u${i}` };
  });
}

/**
 * Render one table's cells as a GitHub-flavored markdown table. Cells carry
 * 1-based `row`/`col`; the grid is squared to the widest column seen and missing
 * cells are rendered blank. A `| --- |` separator is emitted after the first
 * row (the header). Pipes in cell text are escaped so they can't break the grid.
 *
 * This is the single grid renderer shared by the markdown projection of every
 * structured provider — the column math lives once, in each canonicalizer's
 * cell-coordinate assignment, and this function is a dumb projector over it.
 */
export function renderTableGrid(
  cells: ReadonlyArray<{ row: number; col: number; text: string }>,
): string {
  if (cells.length === 0) return "";
  let maxRow = 0;
  let maxCol = 0;
  const grid = new Map<string, string>();
  for (const c of cells) {
    if (c.row > maxRow) maxRow = c.row;
    if (c.col > maxCol) maxCol = c.col;
    grid.set(`${c.row},${c.col}`, c.text.replace(/\|/g, "\\|"));
  }
  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const cols: string[] = [];
    for (let c = 1; c <= maxCol; c++) cols.push(grid.get(`${r},${c}`) ?? "");
    lines.push(`| ${cols.join(" | ")} |`);
    if (r === 1) {
      lines.push(`| ${Array.from({ length: maxCol }, () => "---").join(" | ")} |`);
    }
  }
  return lines.join("\n");
}

/**
 * Project a parse spine to a single markdown document — markdown demoted to a
 * *projection* of the spine (`docs/parse-spine-model.md`). Contiguous
 * `table_cell` units sharing a `tableId` are reassembled into one markdown grid
 * via {@link renderTableGrid}; every other unit contributes its text. Blocks are
 * joined with a blank line, exactly as the pre-spine `chunks.map(text).join`
 * did, so the projected markdown is byte-identical for non-table content and
 * reconstructs the same table a single markdown-table chunk used to hold.
 */
export function spineToMarkdown(units: readonly ParseUnit[]): string {
  const blocks: string[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i]!;
    if (u.role === "table_cell" && u.table) {
      const { tableId } = u.table;
      const cells: { row: number; col: number; text: string }[] = [];
      while (i < units.length) {
        const c = units[i]!;
        if (c.role !== "table_cell" || c.table?.tableId !== tableId) break;
        cells.push({ row: c.table.row, col: c.table.col, text: c.text });
        i++;
      }
      const md = renderTableGrid(cells);
      if (md) blocks.push(md);
      continue;
    }
    blocks.push(u.text);
    i++;
  }
  return blocks.join("\n\n");
}

/**
 * The canonicalizer seam.
 *
 * A `ChunkCanonicalizer<T>` converts a single provider's **native structured
 * output** `T` into provenance-carrying chunks. `T` is intentionally the
 * provider's own shape — pdfjs positional pages, a Google `Document`, an array
 * of Textract `Block`s — not a shared intermediate. Each structured provider
 * implements one of these for its representation; the chunk type and these
 * helpers are the only things they share.
 *
 * Implementations should:
 *   - emit chunks in natural reading order;
 *   - populate `bbox` whenever geometry is available (use {@link unionBBox} to
 *     merge the boxes of the words/cells that make up a chunk, and
 *     {@link normalizeBBox} if the source coordinates are in pixel/point space);
 *   - never throw on a missing bbox — leave it `undefined` instead.
 *
 * @typeParam T - the provider's native structured parse representation.
 */
export interface ChunkCanonicalizer<T> {
  /** Convert one structured parse result into ordered chunks-with-provenance. */
  toChunks(structured: T): ParseChunk[];
}

// ---------------------------------------------------------------------------
// Generic geometry helpers — shared by every canonicalizer.
// These are provider-agnostic math, not domain or vendor logic.
// ---------------------------------------------------------------------------

/**
 * Merge a set of bounding boxes into the smallest box that encloses all of
 * them. Used by canonicalizers to roll the per-word / per-cell boxes that make
 * up a chunk into a single chunk-level box.
 *
 * Returns `undefined` when given no boxes, so the result can be assigned
 * directly to a `ParseChunk.bbox` (absent geometry stays absent). All inputs
 * are assumed to share one coordinate space (normalize first if not).
 */
export function unionBBox(boxes: readonly BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Convert a box expressed in absolute page units (pixels or PDF points, origin
 * top-left) into the normalized `[0, 1]` {@link BBox} convention.
 *
 * Returns `undefined` for a non-positive page width/height so callers can fall
 * back to "no geometry" rather than emitting `NaN`/`Infinity` coordinates.
 */
export function normalizeBBox(
  box: { x: number; y: number; w: number; h: number },
  pageWidth: number,
  pageHeight: number,
): BBox | undefined {
  if (pageWidth <= 0 || pageHeight <= 0) return undefined;
  return {
    x: box.x / pageWidth,
    y: box.y / pageHeight,
    w: box.w / pageWidth,
    h: box.h / pageHeight,
  };
}

/**
 * Predicate: does `box` conform to the canonical {@link BBox} convention?
 *
 * A conforming box has finite `x, y, w, h`, non-negative width/height, and lies
 * entirely within the normalized unit square (`0 <= x`, `0 <= y`,
 * `x + w <= 1`, `y + h <= 1`), allowing a tiny `epsilon` for floating-point
 * rounding at the edges. This is the machine-checkable form of the top-left,
 * normalized-`[0, 1]` contract documented on {@link BBox}.
 *
 * Note: normalization alone cannot prove top-left origin — a bottom-left box is
 * still numerically in `[0, 1]`. Origin correctness is verified per provider by
 * feeding a known input whose top-left position is asserted (see the bbox
 * contract tests). This predicate catches the mechanical failures: unnormalized
 * pixels/points (values `> 1`), negative coordinates, and `NaN`/`Infinity`.
 */
export function isNormalizedBBox(box: BBox, epsilon = 1e-6): boolean {
  const { x, y, w, h } = box;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return false;
  if (w < -epsilon || h < -epsilon) return false;
  if (x < -epsilon || y < -epsilon) return false;
  if (x + w > 1 + epsilon || y + h > 1 + epsilon) return false;
  return true;
}

/**
 * Assert that `box` conforms to the canonical {@link BBox} convention, throwing
 * a descriptive error otherwise. Providers and their tests use this to enforce
 * "one canonical coordinate convention" — a box that fails here would render
 * highlights in the wrong place (or off-page) in the dashboard.
 *
 * Dependency-free by design: safe to call from provider code paths, not just
 * tests. `label` is included in the message so a failure names the offending
 * provider/emitter.
 */
export function assertNormalizedBBox(box: BBox, label = "bbox"): void {
  if (!isNormalizedBBox(box)) {
    throw new Error(
      `${label} violates the canonical normalized [0,1] top-left BBox convention: ` +
        `${JSON.stringify(box)}`,
    );
  }
}
