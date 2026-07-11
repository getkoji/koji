/**
 * Google Document AI parse provider (PB-7).
 *
 * Document AI is **JSON-native**: its `:process` endpoint returns a `Document`
 * object carrying the full OCR text plus per-element layout (text anchors into
 * that string + bounding polygons) and, crucially, **tables as explicit grids
 * of cells** with row/column position. This is the path that fixes the
 * wrong-column bug *at the source*: column association is structural (a cell's
 * position in its row's `cells[]` array), not inferred from reading-order
 * heuristics over flattened text the way docling does it.
 *
 * Two pieces live here:
 *
 *   - {@link GoogleDocAiCanonicalizer} — a {@link ChunkCanonicalizer} that turns
 *     a `Document` JSON into provenance-carrying {@link ParseChunk}s. Text
 *     paragraphs become text chunks; each table becomes a single chunk whose
 *     text is a clean markdown table serialized from the KNOWN cell coordinates,
 *     so columns can't drift. bbox is populated from normalized vertices (or
 *     pixel vertices via {@link normalizeBBox}).
 *   - {@link GoogleDocAiProvider} — a {@link ParseProvider} that calls Document
 *     AI, runs the canonicalizer, and returns both the canonicalized chunks and
 *     a linearized markdown view (for the legacy text path).
 *
 * **Size routing (the Superkey-blocking part).** The synchronous `:process`
 * endpoint caps at 15 pages (30 with `imagelessMode`), but most Superkey docs
 * are larger (50–226pg policies). The provider counts the PDF's pages and, by
 * default, keeps everything on the synchronous path — **GCS-free**:
 *
 *   - ≤ slice size (default 15pg) → a single online `:process` call.
 *   - > slice size               → slice the PDF into ≤-slice-size segments
 *                                  (reusing the shared `slicePdfPages` helper),
 *                                  run each segment through online `:process`
 *                                  **in parallel** (bounded by a configurable
 *                                  concurrency cap, default 6, to respect Doc AI
 *                                  online QPS quotas), then **merge** the
 *                                  per-segment chunks with global page
 *                                  renumbering via {@link mergeShardChunks}.
 *
 * Slicing at page boundaries is quality-neutral for a page-local OCR processor,
 * avoids GCS/bucket/IAM entirely, and parallel synchronous calls are faster
 * wallclock per document than batch's async polling. A segment that the online
 * endpoint rejects as too large (image-heavy pages) is bisected and retried at a
 * smaller slice; a segment that still fails surfaces the error rather than
 * silently dropping its pages.
 *
 * **Batch is opt-in** (no longer the default large-doc path). Set
 * `config_json.parse_mode = "batch"` (or `use_batch: true`) to route large docs
 * through async `:batchProcess` — upload the source to a tenant-supplied GCS
 * bucket, dispatch the long-running operation, poll to completion, read the
 * sharded output `Document` JSON, canonicalize + merge the shards, then clean up
 * the temp GCS objects. This path is reserved for bulk / high-volume historical
 * imports; it needs a GCS bucket (`config_json.gcs_bucket` / `gcs_output_uri`)
 * and a service account whose token carries `roles/documentai.apiUser` plus
 * `roles/storage.objectAdmin` on that bucket.
 *
 * Auth reuses the existing Bearer token (`payload.api_key`). When the page count
 * can't be determined (e.g. a non-PDF or a PDF unreadable by both pdf-lib and
 * pdfjs), the provider falls back to a single online `:process` call. Slice size
 * and concurrency are configurable via `config_json` (`slice_pages` default 15,
 * `online_concurrency` default 6).
 *
 * **pdf-lib-unreadable PDFs (oss-377).** Some real PDFs defeat pdf-lib while
 * remaining perfectly parseable: owner-password encryption (empty user
 * password) combined with a page tree in compressed object streams. pdf-lib's
 * `ignoreEncryption` skips decryption, so the page tree never materializes and
 * both counting and slicing throw. For those, the count comes from pdfjs
 * (which decrypts properly) via {@link probePdf}; a large doc is then
 * **normalized once** through the parse service's `/normalize-pdf` (a
 * PDFium/MuPDF re-save, see `pdf-normalize.ts`) so the standard sliced path
 * runs on the normalized bytes. If normalization fails, ≤30pg docs retry as a
 * single imageless online call; larger ones surface an actionable error
 * instead of Doc AI's bare PAGE_LIMIT_EXCEEDED.
 *
 * Credentials are resolved per-tenant via `resolveTenantParseProvider`
 * (`parse_endpoints` → decrypt → driver registry) — never from raw env vars.
 * The driver is registered under the slug `google-docai` in `drivers.ts`.
 *
 * Live validation against a real Document AI processor needs a Google Cloud
 * access token and project/processor config (plus bucket permissions for the
 * opt-in batch path) and is pending. The canonicalizer and the routing /
 * slice-parallel-merge / batch-merge logic are unit-tested against sample
 * `Document` fixtures and a fully mocked Doc AI + GCS REST surface.
 */

import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { ParseProvider, ParseResponse } from "../provider";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import {
  type BBox,
  type ParseChunk,
  type ParseUnitDraft,
  type ParseUnitRole,
  type ChunkCanonicalizer,
  assignUnitIds,
  spineToMarkdown,
  normalizeBBox,
  unionBBox,
} from "../chunk";
import { GcsClient, joinGcsPath, parseGcsUri, toGcsUri } from "./gcs";
import { slicePdfPages, mapWithConcurrency, probePdf } from "../pdf-slice";
import { normalizePdfViaService } from "../pdf-normalize";
import { resolveMimeType } from "../../ingestion/mime";

// ---------------------------------------------------------------------------
// Google Document AI `Document` JSON — the subset we consume.
//
// Mirrors the REST `Document` message
// (https://cloud.google.com/document-ai/docs/reference/rest/v1/Document).
// Integer offsets are serialized as strings in JSON (int64), and proto3 omits
// zero-valued fields (a `startIndex` of 0 is absent) — both handled below.
// ---------------------------------------------------------------------------

interface GoogleVertex {
  x?: number;
  y?: number;
}

interface GoogleBoundingPoly {
  /** Pixel-space vertices (origin top-left). Normalize with page dimension. */
  vertices?: GoogleVertex[];
  /** Already fraction-of-page [0,1] vertices (origin top-left). */
  normalizedVertices?: GoogleVertex[];
}

interface GoogleTextSegment {
  /** Byte/char offset into `Document.text`; absent means 0. */
  startIndex?: string | number;
  endIndex?: string | number;
}

interface GoogleTextAnchor {
  textSegments?: GoogleTextSegment[];
  /** Some processors inline the text directly instead of via offsets. */
  content?: string;
}

interface GoogleLayout {
  textAnchor?: GoogleTextAnchor;
  boundingPoly?: GoogleBoundingPoly;
}

interface GoogleDimension {
  width?: number;
  height?: number;
  unit?: string;
}

/** A block / paragraph / line — anything carrying a layout. */
interface GoogleLayoutElement {
  layout?: GoogleLayout;
}

interface GoogleTableCell {
  layout?: GoogleLayout;
  rowSpan?: number;
  colSpan?: number;
}

interface GoogleTableRow {
  cells?: GoogleTableCell[];
}

interface GoogleTable {
  layout?: GoogleLayout;
  headerRows?: GoogleTableRow[];
  bodyRows?: GoogleTableRow[];
}

interface GooglePage {
  /** 1-based; absent on the first page (proto3 zero-omission) → treat as 1. */
  pageNumber?: number;
  dimension?: GoogleDimension;
  blocks?: GoogleLayoutElement[];
  paragraphs?: GoogleLayoutElement[];
  lines?: GoogleLayoutElement[];
  tables?: GoogleTable[];
}

export interface GoogleDocument {
  /** The full concatenated OCR text; layout elements index into this. */
  text?: string;
  pages?: GooglePage[];
}

/** The `:process` response envelope (`{ document: Document }`). */
export interface GoogleProcessResponse {
  document?: GoogleDocument;
}

// ---------------------------------------------------------------------------
// Canonicalizer — Document JSON → chunks-with-bbox.
// ---------------------------------------------------------------------------

/** Coerce a Document AI int64-as-string (or number, or undefined) to a number. */
function toInt(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve a layout element's text from its anchor (offsets into `fullText`). */
function textFromAnchor(fullText: string, anchor: GoogleTextAnchor | undefined): string {
  if (!anchor) return "";
  // Processors that inline content win — no offsets to resolve.
  if (typeof anchor.content === "string" && anchor.content.length > 0) {
    return anchor.content;
  }
  const segs = anchor.textSegments ?? [];
  if (segs.length === 0) return "";
  let out = "";
  for (const s of segs) {
    const start = toInt(s.startIndex, 0);
    const end = toInt(s.endIndex, 0);
    if (end > start) out += fullText.slice(start, end);
  }
  return out;
}

/**
 * Build a normalized {@link BBox} from a bounding polygon. Prefers
 * `normalizedVertices` (already in [0,1]); falls back to pixel `vertices`
 * scaled by the page dimension via {@link normalizeBBox}. Returns undefined
 * when no usable geometry is present.
 */
function bboxFromPoly(
  poly: GoogleBoundingPoly | undefined,
  dim: GoogleDimension | undefined,
): BBox | undefined {
  if (!poly) return undefined;

  const nv = (poly.normalizedVertices ?? []).filter(
    (v) => typeof v.x === "number" && typeof v.y === "number",
  );
  if (nv.length > 0) {
    const xs = nv.map((v) => v.x as number);
    const ys = nv.map((v) => v.y as number);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }

  const vv = (poly.vertices ?? []).filter(
    (v) => typeof v.x === "number" && typeof v.y === "number",
  );
  if (vv.length > 0 && dim?.width && dim?.height) {
    const xs = vv.map((v) => v.x as number);
    const ys = vv.map((v) => v.y as number);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return normalizeBBox(
      { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
      dim.width,
      dim.height,
    );
  }

  return undefined;
}

/** Smallest [start, end) span covering all of a table's cell text anchors. */
function tableTextRange(table: GoogleTable): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of [...(table.headerRows ?? []), ...(table.bodyRows ?? [])]) {
    for (const cell of row.cells ?? []) {
      for (const s of cell.layout?.textAnchor?.textSegments ?? []) {
        const start = toInt(s.startIndex, 0);
        const end = toInt(s.endIndex, 0);
        if (start < min) min = start;
        if (end > max) max = end;
      }
    }
  }
  return min !== Infinity && max > min ? [min, max] : null;
}

/** First [start, end) span of a layout element, or null when it has no anchor. */
function elementTextRange(el: GoogleLayoutElement): [number, number] | null {
  const segs = el.layout?.textAnchor?.textSegments ?? [];
  if (segs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const s of segs) {
    const start = toInt(s.startIndex, 0);
    const end = toInt(s.endIndex, 0);
    if (start < min) min = start;
    if (end > max) max = end;
  }
  return min !== Infinity && max > min ? [min, max] : null;
}

/** Two half-open ranges overlap. */
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** A cell's display text: whitespace-collapsed and trimmed, pipes left raw
 * (the markdown projector escapes them). */
function cellDisplayText(fullText: string, cell: GoogleTableCell): string {
  return textFromAnchor(fullText, cell.layout?.textAnchor).replace(/\s+/g, " ").trim();
}

/**
 * Flatten a Document AI table into per-cell `table_cell` units from the KNOWN
 * cell grid. Because every cell's column is its index in `cells[]` (colSpan
 * expanded to blank grid slots), column association is preserved exactly — the
 * wrong-column fix, now carried as addressable cells rather than a pre-rendered
 * markdown string. Header rows are numbered first (row 1..), then body rows;
 * {@link spineToMarkdown} reprojects the identical markdown table, treating
 * row 1 as the header (which also promotes the first body row when there are no
 * header rows).
 *
 * Each real cell carries `{ tableId, row, col }`, `role: "table_cell"`, its
 * bbox, and its text; colSpan padding is emitted as empty cells so the grid
 * keeps its full width.
 */
function tableCells(
  fullText: string,
  table: GoogleTable,
  dim: GoogleDimension | undefined,
  pageNum: number,
  tableId: string,
): ParseUnitDraft[] {
  const rows = [...(table.headerRows ?? []), ...(table.bodyRows ?? [])];
  if (rows.length === 0) return [];

  const units: ParseUnitDraft[] = [];
  rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 1;
    let col = 1;
    for (const cell of row.cells ?? []) {
      const text = cellDisplayText(fullText, cell);
      const bbox = bboxFromPoly(cell.layout?.boundingPoly, dim);
      units.push({
        text,
        page: pageNum,
        ...(bbox ? { bbox } : {}),
        role: "table_cell",
        table: { tableId, row: rowNum, col },
      });
      // A colSpan>1 cell occupies extra grid columns; emit blank cells so the
      // projected grid stays aligned with its header.
      const span = Math.max(1, toInt(cell.colSpan, 1));
      for (let k = 1; k < span; k++) {
        units.push({
          text: "",
          page: pageNum,
          role: "table_cell",
          table: { tableId, row: rowNum, col: col + k },
        });
      }
      col += span;
    }
  });
  return units;
}

/** A contiguous group of units paired with a sort key for page reading order. */
interface OrderedGroup {
  /** Units emitted contiguously (a text unit, or a table's cells). */
  units: ParseUnitDraft[];
  /** Original index — stable tie-break when geometry is missing. */
  order: number;
  /** Top edge (normalized) for vertical reading order; Infinity when unknown. */
  top: number;
  /** Left edge (normalized) for horizontal tie-break; Infinity when unknown. */
  left: number;
  /** Height (normalized) — used to cluster groups into rows by vertical
   * overlap; 0 when geometry is unknown. */
  height: number;
}

/**
 * Two groups share a visual row when their vertical extents overlap by at least
 * 30% of the shorter one. Anchored to the row's top-most group so a tall element
 * can't chain-merge successive rows. Falls back to a small top-distance test
 * when a height is missing, and to exact-top equality when geometry is absent.
 */
function sameRow(anchor: OrderedGroup, g: OrderedGroup): boolean {
  if (!Number.isFinite(anchor.top) || !Number.isFinite(g.top)) return anchor.top === g.top;
  const minH = Math.min(anchor.height, g.height);
  if (minH <= 0) return Math.abs(g.top - anchor.top) < 0.004;
  const overlap = Math.min(anchor.top + anchor.height, g.top + g.height) - Math.max(anchor.top, g.top);
  return overlap / minH >= 0.3;
}

/**
 * Order page groups in human reading order: cluster into horizontal rows by
 * vertical overlap, order rows top-to-bottom, and order groups left-to-right
 * within each row.
 *
 * A plain top-then-left sort fails on two-column label/value layouts (common in
 * form headers): two cells in the same visual row almost never share an exact
 * `top`, so the comparator never reaches the left tie-break and cells from
 * different columns interleave — decoupling every label from its value.
 * Banding by vertical overlap keeps a label adjacent to its value. Groups with
 * no geometry (`top === Infinity`) keep their original order at the end.
 */
function orderGroupsIntoRows(groups: OrderedGroup[]): OrderedGroup[] {
  const byTop = [...groups].sort((a, b) => a.top - b.top || a.order - b.order);
  const rows: OrderedGroup[][] = [];
  for (const g of byTop) {
    const row = rows[rows.length - 1];
    if (row && sameRow(row[0]!, g)) row.push(g);
    else rows.push([g]);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left || a.order - b.order);
  return rows.flat();
}

/**
 * Converts a Google `Document` into an ordered, provenance-carrying parse spine.
 *
 * Text paragraphs (falling back to lines, then blocks) become text units;
 * paragraphs whose text falls inside a table's span are dropped so table text
 * isn't emitted twice. Each table becomes a contiguous run of `table_cell`
 * units carrying `{ tableId, row, col }` (markdown is reprojected from them by
 * {@link spineToMarkdown}). Units are ordered top-to-bottom, left-to-right
 * within a page by their bbox, with original order as a stable fallback, then
 * stamped with parse-scoped reading-order ids.
 */
export class GoogleDocAiCanonicalizer implements ChunkCanonicalizer<GoogleDocument> {
  toChunks(structured: GoogleDocument): ParseChunk[] {
    const fullText = structured.text ?? "";
    const drafts: ParseUnitDraft[] = [];

    const pages = structured.pages ?? [];
    pages.forEach((page, pageIdx) => {
      const pageNum = page.pageNumber ?? pageIdx + 1;
      const dim = page.dimension;
      const tables = page.tables ?? [];
      const tableRanges = tables
        .map(tableTextRange)
        .filter((r): r is [number, number] => r !== null);

      const groups: OrderedGroup[] = [];
      let order = 0;

      // Text elements: prefer paragraphs; fall back to lines, then blocks. The
      // role hint reflects which family we're reading (best-effort per Decision 2).
      const usingParagraphs = !!page.paragraphs?.length;
      const usingLines = !usingParagraphs && !!page.lines?.length;
      const textElements =
        (page.paragraphs?.length ? page.paragraphs : undefined) ??
        (page.lines?.length ? page.lines : undefined) ??
        page.blocks ??
        [];
      const textRole: ParseUnitRole = usingLines ? "line" : "paragraph";

      for (const el of textElements) {
        const range = elementTextRange(el);
        // Skip text that belongs to a table — the table cells carry it.
        if (range && tableRanges.some((tr) => rangesOverlap(range, tr))) continue;

        const text = textFromAnchor(fullText, el.layout?.textAnchor).trim();
        if (!text) continue;

        const bbox = bboxFromPoly(el.layout?.boundingPoly, dim);
        groups.push({
          units: [{ text, page: pageNum, ...(bbox ? { bbox } : {}), role: textRole }],
          order: order++,
          top: bbox ? bbox.y : Infinity,
          left: bbox ? bbox.x : Infinity,
          height: bbox ? bbox.h : 0,
        });
      }

      // Tables → a contiguous run of per-cell units each.
      tables.forEach((table, tableIdx) => {
        const tableId = `p${pageNum}-t${tableIdx}`;
        const cells = tableCells(fullText, table, dim, pageNum, tableId);
        if (cells.length === 0) return;
        // Prefer the table's own layout box; else union the cell boxes.
        let bbox = bboxFromPoly(table.layout?.boundingPoly, dim);
        if (!bbox) {
          const cellBoxes: BBox[] = [];
          for (const row of [...(table.headerRows ?? []), ...(table.bodyRows ?? [])]) {
            for (const cell of row.cells ?? []) {
              const b = bboxFromPoly(cell.layout?.boundingPoly, dim);
              if (b) cellBoxes.push(b);
            }
          }
          bbox = unionBBox(cellBoxes);
        }
        groups.push({
          units: cells,
          order: order++,
          top: bbox ? bbox.y : Infinity,
          left: bbox ? bbox.x : Infinity,
          height: bbox ? bbox.h : 0,
        });
      });

      // Reading order: cluster into rows by vertical overlap, order rows
      // top-to-bottom and groups left-to-right within a row. A plain
      // top-then-left sort interleaves the columns of a two-column label/value
      // layout (form headers) because same-row cells rarely share an exact `top`.
      for (const g of orderGroupsIntoRows(groups)) drafts.push(...g.units);
    });

    return assignUnitIds(drafts);
  }
}

// ---------------------------------------------------------------------------
// Provider — calls Document AI, canonicalizes, returns chunks + markdown.
// ---------------------------------------------------------------------------

const DEFAULT_LOCATION = "us";

/**
 * Page-count routing thresholds. Document AI's synchronous `:process` caps at
 * 15 pages plain, or 30 when `imagelessMode` is set — so a single online call
 * (or one slice) can never exceed 30 pages.
 */
const ONLINE_MAX_PAGES = 15;
const IMAGELESS_MAX_PAGES = 30;

/**
 * Default pages per slice for the slice→parallel→merge large-doc path. 15 keeps
 * each slice within the plain `:process` cap (no imageless needed). Configurable
 * via `config_json.slice_pages`; clamped to [1, 30] since online can't exceed 30
 * pages even with imageless.
 */
const DEFAULT_SLICE_PAGES = 15;
/**
 * Default cap on concurrent online `:process` calls when fanning slices out.
 * Conservative to respect Doc AI's per-project online QPS quota. Configurable
 * via `config_json.online_concurrency`.
 */
const DEFAULT_ONLINE_CONCURRENCY = 6;

/** Default batch operation timeout. Large policies (200+pg) take minutes. */
const DEFAULT_BATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
/** Delay between batch long-running-operation poll attempts. */
const DEFAULT_BATCH_POLL_INTERVAL_MS = 5000;

/**
 * An HTTP error from a Document AI REST call, carrying the status so the slice
 * path can tell a retryable "request too large" (bisect + retry) apart from a
 * non-retryable auth/quota error (surface immediately).
 */
class GoogleDocAiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleDocAiRequestError";
  }
}

/**
 * Whether an online `:process` failure is plausibly an oversize-request error
 * worth retrying at a smaller slice (vs. an auth/quota/config error that
 * bisecting won't fix). Treats 400/413 and page-/size-limit messages as
 * retryable.
 */
function isOversizeError(err: unknown): boolean {
  if (err instanceof GoogleDocAiRequestError) {
    if (err.status === 400 || err.status === 413) return true;
    // 401/403/404/429/5xx aren't fixed by a smaller slice.
    if (err.status > 0) return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /page limit|page_limit|exceed|too large|payload size|request size|content too large/i.test(
    msg,
  );
}

/** Document-AI-specific config read from the (decrypted) endpoint payload. */
interface GoogleDocAiConfig {
  projectId?: string;
  processorId?: string;
  /** Processor version (optional pin). */
  processorVersionId?: string;
  location?: string;
  /** GCS bucket for batch I/O (input upload + sharded output). */
  gcsBucket?: string;
  /** Full `gs://` prefix for batch input uploads (overrides bucket-derived). */
  gcsInputUri?: string;
  /** Full `gs://` prefix for batch output shards (overrides bucket-derived). */
  gcsOutputUri?: string;
  /** Total batch operation timeout (ms). */
  batchTimeoutMs?: number;
  /** Batch poll interval (ms). */
  batchPollIntervalMs?: number;
  /** Pages per slice for the slice→parallel→merge path. Default 15. */
  slicePages?: number;
  /** Max concurrent online `:process` calls when fanning slices out. Default 6. */
  onlineConcurrency?: number;
  /** Opt in to the async batch path for large docs (bulk imports). Default off. */
  useBatch?: boolean;
}

function readConfig(payload: ParseEndpointPayload): GoogleDocAiConfig {
  const cfg = (payload.config ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof cfg[k] === "string" ? (cfg[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof cfg[k] === "number" ? (cfg[k] as number) : undefined;
  const bool = (k: string): boolean | undefined =>
    typeof cfg[k] === "boolean" ? (cfg[k] as boolean) : undefined;

  const parseMode = (str("parse_mode") ?? str("parseMode"))?.toLowerCase();
  const useBatch =
    parseMode === "batch" || bool("use_batch") === true || bool("useBatch") === true;

  return {
    projectId: str("project_id") ?? str("projectId"),
    processorId: str("processor_id") ?? str("processorId"),
    processorVersionId: str("processor_version_id") ?? str("processorVersionId"),
    // `region` is the shared payload field; `location` may also be in config.
    location: payload.region ?? str("location") ?? DEFAULT_LOCATION,
    gcsBucket: str("gcs_bucket") ?? str("gcsBucket"),
    gcsInputUri: str("gcs_input_uri") ?? str("gcsInputUri"),
    gcsOutputUri: str("gcs_output_uri") ?? str("gcsOutputUri"),
    batchTimeoutMs: num("batch_timeout_ms") ?? num("batchTimeoutMs"),
    batchPollIntervalMs: num("batch_poll_interval_ms") ?? num("batchPollIntervalMs"),
    slicePages: num("slice_pages") ?? num("slicePages") ?? num("slice_size") ?? num("sliceSize"),
    onlineConcurrency:
      num("online_concurrency") ??
      num("onlineConcurrency") ??
      num("parallel_slices") ??
      num("parallelSlices"),
    useBatch,
  };
}

// ---------------------------------------------------------------------------
// Batch long-running operation + Document.shardInfo shapes (subset we read).
// ---------------------------------------------------------------------------

/** The `:batchProcess` response is a long-running Operation handle. */
interface BatchOperationHandle {
  name?: string;
}

/** A polled long-running Operation. */
interface LongRunningOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  metadata?: BatchProcessMetadata;
}

/** `BatchProcessMetadata` — carries per-document output destinations. */
interface BatchProcessMetadata {
  state?: string;
  stateMessage?: string;
  individualProcessStatuses?: Array<{
    /** `gs://` folder the shards for this input doc were written under. */
    outputGcsDestination?: string;
    status?: { code?: number; message?: string };
  }>;
}

/** Sharding info present on each output `Document` from a batch run. */
interface GoogleShardInfo {
  shardIndex?: string | number;
  shardCount?: string | number;
  textOffset?: string | number;
}

type ShardedGoogleDocument = GoogleDocument & { shardInfo?: GoogleShardInfo };

/** A 1-indexed, inclusive page range for the slice→parallel→merge path. */
interface PageRange {
  startPage: number;
  endPage: number;
}

/** One unit of {@link mergeShardChunks} input: a shard's chunks + page span. */
interface MergeShard {
  chunks: ParseChunk[];
  pageCount: number;
  basePage: number;
}

/**
 * Merge canonicalized chunks from a document's output shards into one ordered,
 * globally-page-numbered chunk list.
 *
 * Document AI batch output is **sharded**: each shard is its own `Document`
 * covering a contiguous page range, with text anchors relative to that shard's
 * own `text`. Shards are emitted in `shardInfo.shardIndex` order. We rebase
 * each shard's page numbers onto a running global offset so the merged result
 * is monotonically numbered 1..N regardless of whether the provider numbers
 * pages globally or per-shard (both observed in the wild). The offset advances
 * by the shard's page count, not by distinct chunk pages, so pages with no
 * extractable text still consume their page slot.
 */
export function mergeShardChunks(
  shards: ReadonlyArray<{ chunks: ParseChunk[]; pageCount: number; basePage: number }>,
): ParseChunk[] {
  const merged: ParseChunk[] = [];
  let offset = 0;
  for (const shard of shards) {
    for (const c of shard.chunks) {
      merged.push({ ...c, page: offset + (c.page - shard.basePage) + 1 });
    }
    offset += shard.pageCount;
  }
  // Ids were parse-scoped WITHIN each shard's local page numbers; after
  // rebasing pages onto the global range they must be restamped so the merged
  // spine's `p<page>-u<index>` handles are correct per global page.
  return assignUnitIds(merged);
}

/**
 * ParseProvider backed by Google Document AI.
 *
 * Authentication: Document AI uses Google Cloud OAuth2 — `payload.api_key` is
 * sent as a Bearer access token. (Service-account JWT → access-token exchange,
 * if a tenant stores a key file instead of a token, is a follow-up; the driver
 * accepts a ready access token today.) Project / processor / location come from
 * the endpoint's `config_json`.
 *
 * Page-count routing (see file header): a single online `:process` call when
 * the doc fits one slice (≤ slice size, default 15pg); otherwise slice into
 * ≤-slice-size segments and run them through online `:process` in parallel,
 * merging with global page renumbering. Batch via GCS is opt-in for bulk
 * imports (`config_json.parse_mode = "batch"`).
 */
export class GoogleDocAiProvider implements ParseProvider {
  private readonly canonicalizer = new GoogleDocAiCanonicalizer();

  constructor(private readonly payload: ParseEndpointPayload) {}

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const cfg = readConfig(this.payload);
    if (!cfg.projectId || !cfg.processorId) {
      throw new Error(
        "google-docai: config_json must provide project_id and processor_id",
      );
    }
    const token = this.payload.api_key;
    if (!token) {
      throw new Error("google-docai: missing access token (api_key)");
    }

    // Defense-in-depth: Doc AI's `rawDocument.mime_type` rejects a bare/invalid
    // MIME with 400 INVALID_ARGUMENT. SmartParseProvider already normalizes
    // centrally, but this provider can also be invoked directly, so re-resolve
    // here (claimed → filename → magic bytes) before any request is built.
    const resolvedMime = resolveMimeType(
      input.mimeType,
      input.filename,
      input.fileBuffer,
    );
    if (resolvedMime !== input.mimeType) {
      console.log(
        `[google-docai] ${input.filename}: normalized mimeType "${input.mimeType}" → "${resolvedMime}"`,
      );
      input = { ...input, mimeType: resolvedMime };
    }

    // Slice size divides "one online call" from the large-doc strategy. Clamp
    // to [1, 30] — a single online request can't exceed 30 pages even imageless.
    const sliceSize = Math.min(
      Math.max(1, Math.floor(cfg.slicePages ?? DEFAULT_SLICE_PAGES)),
      IMAGELESS_MAX_PAGES,
    );

    // Route by page count. `probePdf` counts via pdf-lib and, when pdf-lib
    // can't read the file (owner-password encryption + object-stream page
    // trees — see pdf-normalize.ts), falls back to pdfjs for the count alone.
    // An unknown count (non-PDF / unreadable by both) falls back to a single
    // online `:process` call — the smallest, safest path.
    const probe = await probePdf(input.fileBuffer, input.mimeType);
    let pageCount = probe.pageCount;

    // Opt-in batch path for bulk / high-volume historical imports. Requires a
    // GCS bucket; gated behind config_json.parse_mode="batch" or use_batch=true.
    // Doc AI reads the original bytes from GCS — no local pdf-lib needed, so
    // this path works regardless of sliceability.
    if (cfg.useBatch && pageCount !== null && pageCount > sliceSize) {
      return this.processBatch(cfg, token, input);
    }

    // Fits a single online call (or page count unknown).
    if (pageCount === null || pageCount <= sliceSize) {
      const imageless = pageCount !== null && pageCount > ONLINE_MAX_PAGES;
      return this.processOnline(cfg, token, input, imageless);
    }

    // Large doc → the sliced path, which carves the PDF locally with pdf-lib.
    // When pdf-lib can't read the file, normalize it once through the parse
    // service (a PDFium/MuPDF re-save) and slice the normalized bytes. Without
    // this, the pre-oss-377 behavior was a doomed whole-doc online call that
    // Doc AI rejected with PAGE_LIMIT_EXCEEDED.
    if (!probe.pdfLibLoadable) {
      let normalized: Buffer;
      try {
        normalized = await normalizePdfViaService(input.fileBuffer, input.filename);
      } catch (err) {
        return this.handleUnsliceable(cfg, token, input, pageCount, err);
      }
      // Recount from the normalized bytes — authoritative for range building.
      // A normalize that pdf-lib still can't read is treated like a failure.
      const recount = await countPdfPages(normalized, input.mimeType);
      if (recount === null) {
        return this.handleUnsliceable(
          cfg,
          token,
          input,
          pageCount,
          new Error("normalized PDF is still not readable by pdf-lib"),
        );
      }
      console.log(
        `[google-docai] ${input.filename}: pdf-lib cannot read this PDF ` +
          `(likely owner-password encryption with object streams); normalized ` +
          `via parse service (${pageCount} → ${recount}pg).`,
      );
      input = { ...input, fileBuffer: normalized };
      pageCount = recount;
      if (pageCount <= sliceSize) {
        // Rare: the re-save collapsed the count under the slice size.
        return this.processOnline(cfg, token, input, pageCount > ONLINE_MAX_PAGES);
      }
    }

    // Default large-doc path: slice into ≤sliceSize segments, run each through
    // online `:process` in parallel (concurrency-capped), merge with global
    // page renumbering. GCS-free.
    return this.processSliced(cfg, token, input, pageCount, sliceSize);
  }

  /**
   * Last resorts for a large PDF that pdf-lib can't slice and the parse
   * service couldn't normalize. Up to {@link IMAGELESS_MAX_PAGES} a single
   * imageless online call still fits, so try that; beyond it there is no
   * online path at all — surface an actionable error instead of letting Doc
   * AI reject the whole document with a bare PAGE_LIMIT_EXCEEDED.
   */
  private async handleUnsliceable(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    pageCount: number,
    cause: unknown,
  ): Promise<ParseResponse> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (pageCount <= IMAGELESS_MAX_PAGES) {
      console.warn(
        `[google-docai] ${input.filename}: ${pageCount}pg PDF is not locally ` +
          `sliceable and normalization failed (${reason}); ` +
          `falling back to a single imageless online call.`,
      );
      return this.processOnline(cfg, token, input, true);
    }
    throw new Error(
      `google-docai: ${input.filename} has ${pageCount} pages but its PDF ` +
        `structure cannot be sliced locally (typically owner-password ` +
        `encryption with compressed object streams), and normalizing it via ` +
        `the parse service failed: ${reason}. A single online :process call ` +
        `is capped at ${IMAGELESS_MAX_PAGES} pages, so the document cannot be ` +
        `parsed as-is. Configure batch mode (config_json.parse_mode="batch" ` +
        `with a GCS bucket) or re-save the PDF at the source.`,
    );
  }

  /** Build the `documentai.googleapis.com` host for this config. */
  private host(cfg: GoogleDocAiConfig): string {
    return (
      this.payload.base_url ?? `https://${cfg.location}-documentai.googleapis.com`
    ).replace(/\/+$/, "");
  }

  /** Fully-qualified processor (or processor-version) resource name. */
  private processorName(cfg: GoogleDocAiConfig): string {
    return (
      `projects/${cfg.projectId}/locations/${cfg.location}/processors/${cfg.processorId}` +
      (cfg.processorVersionId ? `/processorVersions/${cfg.processorVersionId}` : "")
    );
  }

  /**
   * Synchronous online path: a single `:process` call, canonicalized into a
   * {@link ParseResponse}. `imageless` lifts the 15-page sync cap to 30.
   */
  private async processOnline(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    imageless: boolean,
  ): Promise<ParseResponse> {
    return this.buildResponse(await this.fetchDocument(cfg, token, input, imageless));
  }

  /**
   * One online `:process` call with the raw document inline; returns the raw
   * `Document`. Sets `imagelessMode` to lift the 15-page sync cap to 30. On a
   * non-2xx response throws a {@link GoogleDocAiRequestError} carrying the
   * status so the slice path can decide whether to bisect-and-retry.
   */
  private async fetchDocument(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    imageless: boolean,
  ): Promise<GoogleDocument> {
    const url = `${this.host(cfg)}/v1/${this.processorName(cfg)}:process`;

    const body = JSON.stringify({
      rawDocument: {
        content: input.fileBuffer.toString("base64"),
        mimeType: input.mimeType,
      },
      ...(imageless ? { imagelessMode: true } : {}),
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new GoogleDocAiRequestError(
        resp.status,
        `google-docai process ${resp.status}: ${errText}`,
      );
    }

    const json = (await resp.json()) as GoogleProcessResponse;
    return json.document ?? {};
  }

  /**
   * Default large-doc path: slice the PDF into ≤`sliceSize`-page segments, run
   * each through online `:process` in parallel (bounded by `onlineConcurrency`),
   * and merge the per-segment chunks into one globally-page-numbered list.
   *
   * No GCS, no async polling — just bounded-parallel synchronous calls. Each
   * segment is sliced from the ORIGINAL buffer by absolute page range, so a
   * segment's local page numbers (1..n in its fresh sliced PDF) rebase cleanly
   * onto the running global offset via {@link mergeShardChunks}. The offset
   * advances by the segment's page span, so blank/text-less pages still consume
   * their slot and downstream page numbers + bboxes stay correct end to end.
   */
  private async processSliced(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    pageCount: number,
    sliceSize: number,
  ): Promise<ParseResponse> {
    const concurrency = Math.max(
      1,
      Math.floor(cfg.onlineConcurrency ?? DEFAULT_ONLINE_CONCURRENCY),
    );

    const ranges: PageRange[] = [];
    for (let start = 1; start <= pageCount; start += sliceSize) {
      ranges.push({ startPage: start, endPage: Math.min(start + sliceSize - 1, pageCount) });
    }

    console.log(
      `[google-docai] ${input.filename}: ${pageCount}pg → ${ranges.length} online slice(s) ` +
        `(≤${sliceSize}pg each, concurrency ${concurrency})`,
    );

    // Each range yields one or more shards (more than one only when an oversize
    // segment was bisected). mapWithConcurrency preserves range order, and
    // bisection preserves sub-range order, so the flattened list is in global
    // page order.
    const perRange = await mapWithConcurrency(ranges, concurrency, (range) =>
      this.processRange(cfg, token, input, range),
    );
    const shards = perRange.flat();

    const merged = mergeShardChunks(shards);
    const totalPages = shards.reduce((sum, s) => sum + s.pageCount, 0);
    return {
      markdown: spineToMarkdown(merged),
      pages: totalPages || null,
      ocr_skipped: false,
      engine: "google-docai",
      chunks: merged,
    };
  }

  /**
   * Process one page range as an online `:process` call, returning it as a
   * single-element shard list. If the request is rejected as too large (an
   * image-heavy segment) and the range spans more than one page, bisect the
   * range and process the halves (still GCS-free) — gracefully shrinking the
   * slice instead of failing. A single-page range that still fails, or any
   * non-oversize error, surfaces so pages are never silently dropped.
   */
  private async processRange(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    range: PageRange,
  ): Promise<MergeShard[]> {
    const span = range.endPage - range.startPage + 1;

    let sliceBuffer: Buffer;
    try {
      sliceBuffer = await slicePdfPages(input.fileBuffer, range.startPage, range.endPage);
    } catch (err) {
      // The slicer couldn't carve this range (e.g. corrupt xref). Surface it —
      // dropping these pages silently would corrupt the merged output.
      throw new Error(
        `google-docai: failed to slice pages ${range.startPage}-${range.endPage}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const imageless = span > ONLINE_MAX_PAGES;
    try {
      const document = await this.fetchDocument(
        cfg,
        token,
        {
          filename: `${input.filename}#p${range.startPage}-${range.endPage}`,
          mimeType: input.mimeType,
          fileBuffer: sliceBuffer,
        },
        imageless,
      );
      const basePage = document.pages?.[0]?.pageNumber ?? 1;
      return [{ chunks: this.canonicalizer.toChunks(document), pageCount: span, basePage }];
    } catch (err) {
      if (span > 1 && isOversizeError(err)) {
        const mid = range.startPage + Math.floor(span / 2) - 1;
        console.warn(
          `[google-docai] ${input.filename}: slice ${range.startPage}-${range.endPage} ` +
            `rejected as too large; bisecting → ${range.startPage}-${mid} + ${mid + 1}-${range.endPage}.`,
        );
        const [left, right] = await Promise.all([
          this.processRange(cfg, token, input, { startPage: range.startPage, endPage: mid }),
          this.processRange(cfg, token, input, { startPage: mid + 1, endPage: range.endPage }),
        ]);
        return [...left, ...right];
      }
      throw err;
    }
  }

  /**
   * Asynchronous batch path for docs over the online cap. Flow:
   *   1. upload the source to a unique GCS input object;
   *   2. dispatch `:batchProcess` (input doc → output GCS prefix);
   *   3. poll the long-running operation to completion (with a timeout);
   *   4. list + download the sharded output `Document` JSON from GCS;
   *   5. canonicalize each shard and merge into one chunk list;
   *   6. delete the temp GCS objects (best-effort).
   */
  private async processBatch(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
  ): Promise<ParseResponse> {
    const { inputUri, outputUri } = resolveBatchUris(cfg);
    const gcs = new GcsClient({ accessToken: token });

    // A per-run id namespaces this job's input + output so concurrent batch
    // jobs never collide and cleanup is scoped to exactly what we created.
    const runId = randomUUID();
    const safeName = sanitizeObjectName(input.filename) || "document.pdf";

    const inUri = parseGcsUri(inputUri);
    const outUri = parseGcsUri(outputUri);
    const inputObject = joinGcsPath(inUri.object, runId, safeName);
    const outputPrefix = joinGcsPath(outUri.object, runId) + "/";
    const outputUriForRun = toGcsUri(outUri.bucket, outputPrefix);

    let dispatched = false;
    try {
      // 1. Upload the source.
      await gcs.upload(inUri.bucket, inputObject, input.fileBuffer, input.mimeType);

      // 2. Dispatch the batch operation.
      const operationName = await this.dispatchBatch(cfg, token, {
        inputGcsUri: toGcsUri(inUri.bucket, inputObject),
        inputMimeType: input.mimeType,
        outputGcsUri: outputUriForRun,
      });
      dispatched = true;

      // 3. Poll to completion.
      await this.pollOperation(cfg, token, operationName);

      // 4. List + download the output shards.
      const allObjects = await gcs.list(outUri.bucket, outputPrefix);
      const shardObjects = allObjects.filter((n) => n.endsWith(".json")).sort();
      if (shardObjects.length === 0) {
        throw new Error(
          `google-docai batch: operation completed but no output shards found under ${outputUriForRun}`,
        );
      }
      const documents: ShardedGoogleDocument[] = [];
      for (const name of shardObjects) {
        documents.push(await gcs.downloadJson<ShardedGoogleDocument>(outUri.bucket, name));
      }

      // 5. Canonicalize + merge.
      return this.buildBatchResponse(documents);
    } finally {
      // 6. Best-effort cleanup — never fail the parse on a dangling temp object.
      await this.cleanup(gcs, inUri.bucket, inputObject, outUri.bucket, outputPrefix, dispatched);
    }
  }

  /** POST `:batchProcess`; return the long-running operation's resource name. */
  private async dispatchBatch(
    cfg: GoogleDocAiConfig,
    token: string,
    args: { inputGcsUri: string; inputMimeType: string; outputGcsUri: string },
  ): Promise<string> {
    const url = `${this.host(cfg)}/v1/${this.processorName(cfg)}:batchProcess`;
    const body = JSON.stringify({
      inputDocuments: {
        gcsDocuments: {
          documents: [{ gcsUri: args.inputGcsUri, mimeType: args.inputMimeType }],
        },
      },
      documentOutputConfig: {
        gcsOutputConfig: { gcsUri: args.outputGcsUri },
      },
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`google-docai batchProcess ${resp.status}: ${errText}`);
    }
    const json = (await resp.json()) as BatchOperationHandle;
    if (!json.name) {
      throw new Error("google-docai batchProcess: response missing operation name");
    }
    return json.name;
  }

  /** Poll a long-running operation until `done`, or throw on timeout / failure. */
  private async pollOperation(
    cfg: GoogleDocAiConfig,
    token: string,
    operationName: string,
  ): Promise<LongRunningOperation> {
    const timeoutMs = cfg.batchTimeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
    const intervalMs = cfg.batchPollIntervalMs ?? DEFAULT_BATCH_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    const url = `${this.host(cfg)}/v1/${operationName}`;

    while (Date.now() < deadline) {
      const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`google-docai operation poll ${resp.status}: ${errText}`);
      }
      const op = (await resp.json()) as LongRunningOperation;
      if (op.done) {
        if (op.error) {
          const msg = op.error.message ?? `code ${op.error.code ?? "?"}`;
          throw new Error(`google-docai batch operation failed: ${msg}`);
        }
        // A "failed" per-document status also means we have no usable output.
        const failed = op.metadata?.individualProcessStatuses?.find(
          (s) => s.status?.code && s.status.code !== 0,
        );
        if (failed) {
          throw new Error(
            `google-docai batch document failed: ${failed.status?.message ?? "unknown error"}`,
          );
        }
        return op;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(`google-docai batch: operation did not complete within ${timeoutMs}ms`);
  }

  /** Delete the temp input object and every output shard we created. */
  private async cleanup(
    gcs: GcsClient,
    inputBucket: string,
    inputObject: string,
    outputBucket: string,
    outputPrefix: string,
    dispatched: boolean,
  ): Promise<void> {
    try {
      await gcs.delete(inputBucket, inputObject);
      // Only list/delete output if a batch was actually dispatched (otherwise
      // there is nothing under the prefix and the list is wasted).
      if (dispatched) {
        const outputs = await gcs.list(outputBucket, outputPrefix);
        await Promise.all(outputs.map((name) => gcs.delete(outputBucket, name)));
      }
    } catch (err) {
      console.warn(
        `[google-docai] batch cleanup failed (temp GCS objects may remain): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Canonicalize a `Document` into a {@link ParseResponse}: chunks-with-bbox
   * (the structured path) plus a linearized markdown view (the legacy text
   * path), serialized from the same ordered chunks so the two stay consistent.
   *
   * Exposed (over a raw `Document`) so tests can exercise the full provider
   * output shape without a live Document AI call.
   */
  buildResponse(document: GoogleDocument): ParseResponse {
    const chunks = this.canonicalizer.toChunks(document);
    const markdown = spineToMarkdown(chunks);
    return {
      markdown,
      pages: document.pages?.length ?? null,
      ocr_skipped: false,
      engine: "google-docai",
      chunks,
    };
  }

  /**
   * Build a {@link ParseResponse} from a batch run's output shards: canonicalize
   * each shard, merge into one globally-page-numbered chunk list, and join into
   * the linearized markdown view. Shards are taken in `shardInfo.shardIndex`
   * order (falling back to their already-sorted GCS listing order).
   *
   * Exposed so tests can exercise the merge without a live batch call.
   */
  buildBatchResponse(documents: ShardedGoogleDocument[]): ParseResponse {
    const ordered = [...documents].sort(
      (a, b) => shardIndex(a) - shardIndex(b),
    );
    const shards = ordered.map((doc) => {
      const chunks = this.canonicalizer.toChunks(doc);
      const pages = doc.pages ?? [];
      const basePage = pages.length > 0 ? (pages[0]!.pageNumber ?? 1) : 1;
      return { chunks, pageCount: pages.length, basePage };
    });
    const merged = mergeShardChunks(shards);
    const totalPages = shards.reduce((sum, s) => sum + s.pageCount, 0);
    return {
      markdown: spineToMarkdown(merged),
      pages: totalPages || null,
      ocr_skipped: false,
      engine: "google-docai",
      chunks: merged,
    };
  }
}

/** Read a shard's index (int64-as-string tolerant), defaulting to 0. */
function shardIndex(doc: ShardedGoogleDocument): number {
  const v = doc.shardInfo?.shardIndex;
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve the input + output `gs://` prefixes for a batch run from config.
 * Either explicit `gcs_input_uri` / `gcs_output_uri` URIs, or derived from
 * `gcs_bucket` under stable `koji-docai/{input,output}` prefixes. Throws when
 * no bucket can be determined — batch can't run without one.
 */
export function resolveBatchUris(cfg: GoogleDocAiConfig): {
  inputUri: string;
  outputUri: string;
} {
  const bucket =
    cfg.gcsBucket ??
    (cfg.gcsOutputUri ? parseGcsUri(cfg.gcsOutputUri).bucket : undefined) ??
    (cfg.gcsInputUri ? parseGcsUri(cfg.gcsInputUri).bucket : undefined);

  if (!cfg.gcsInputUri && !cfg.gcsOutputUri && !bucket) {
    throw new Error(
      "google-docai: batch processing requires a GCS bucket — set config_json.gcs_bucket " +
        "(or gcs_output_uri). Docs over 30 pages can only be processed via batch.",
    );
  }

  const inputUri = cfg.gcsInputUri ?? toGcsUri(bucket!, "koji-docai/input");
  const outputUri = cfg.gcsOutputUri ?? toGcsUri(bucket!, "koji-docai/output");
  return { inputUri, outputUri };
}

/** Strip path separators and unsafe chars from a filename for use as an object name. */
function sanitizeObjectName(filename: string): string {
  return filename.replace(/[/\\]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Count pages of a PDF buffer via pdf-lib, or return null when the count can't
 * be determined (non-PDF mime type, or an unreadable/corrupt PDF). A null
 * result routes to the online path — the safe default. `ignoreEncryption` is
 * set because many customer PDFs ship with an owner-password / no-print flag
 * that otherwise blocks loading (mirrors `chunked.ts`).
 */
export async function countPdfPages(
  fileBuffer: Buffer,
  mimeType: string,
): Promise<number | null> {
  if (!/pdf/i.test(mimeType)) return null;
  try {
    const doc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return null;
  }
}
