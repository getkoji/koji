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
 * are larger (50–226pg policies). So the provider counts the PDF's pages and
 * routes:
 *
 *   - ≤15pg            → online `:process`
 *   - 16–30pg          → online `:process` with `imagelessMode: true`
 *   - >30pg            → **batch** (`:batchProcess`): upload the source to GCS,
 *                        dispatch the async long-running operation, poll it to
 *                        completion, read the sharded output `Document` JSON
 *                        from GCS, canonicalize + merge the shards, then clean
 *                        up the temp GCS objects.
 *
 * Batch is the **primary** path for Superkey, not an edge case. It needs a
 * tenant-supplied GCS bucket (`config_json.gcs_bucket` / `gcs_output_uri`) and
 * a service account whose token carries `roles/documentai.apiUser` (batch) plus
 * `roles/storage.objectAdmin` on that bucket. Auth reuses the existing Bearer
 * token (`payload.api_key`). When the page count can't be determined (e.g. a
 * non-PDF or an unreadable PDF), the provider falls back to online `:process`.
 *
 * Credentials are resolved per-tenant via `resolveTenantParseProvider`
 * (`parse_endpoints` → decrypt → driver registry) — never from raw env vars.
 * The driver is registered under the slug `google-docai` in `drivers.ts`.
 *
 * Live validation against a real Document AI processor + GCS bucket needs a
 * Google Cloud access token, project/processor config, and bucket permissions
 * and is pending. The canonicalizer and the routing / batch-merge logic are
 * unit-tested against sample `Document` fixtures and a fully mocked GCS +
 * long-running-operation REST surface.
 */

import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { ParseProvider, ParseResponse } from "../provider";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import {
  type BBox,
  type ParseChunk,
  type ChunkCanonicalizer,
  normalizeBBox,
  unionBBox,
} from "../chunk";
import { GcsClient, joinGcsPath, parseGcsUri, toGcsUri } from "./gcs";

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

/** Escape a cell value for inclusion in a markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/** Flatten a table row into ordered cell strings, expanding colSpan as blanks. */
function rowCells(fullText: string, row: GoogleTableRow): string[] {
  const out: string[] = [];
  for (const cell of row.cells ?? []) {
    out.push(escapeCell(textFromAnchor(fullText, cell.layout?.textAnchor)));
    // A colSpan>1 cell occupies extra grid columns; pad with blanks so every
    // downstream column stays aligned with its header.
    const span = Math.max(1, toInt(cell.colSpan, 1));
    for (let i = 1; i < span; i++) out.push("");
  }
  return out;
}

/**
 * Serialize a Document AI table to GitHub-flavored markdown from the KNOWN
 * cell grid. Because every cell's column is its index in `cells[]` (not an
 * inference over flattened text), column association is preserved exactly —
 * this is the wrong-column fix.
 *
 * If the table has no `headerRows`, the first body row is promoted to the
 * header so the output is still valid markdown.
 */
function serializeTable(fullText: string, table: GoogleTable): string {
  const headerRows = (table.headerRows ?? []).map((r) => rowCells(fullText, r));
  const bodyRows = (table.bodyRows ?? []).map((r) => rowCells(fullText, r));

  let header: string[];
  let rest: string[][];
  if (headerRows.length > 0) {
    header = headerRows[0]!;
    rest = [...headerRows.slice(1), ...bodyRows];
  } else if (bodyRows.length > 0) {
    header = bodyRows[0]!;
    rest = bodyRows.slice(1);
  } else {
    return "";
  }

  // Square the grid: every row padded to the widest row's column count.
  const cols = Math.max(header.length, ...rest.map((r) => r.length), 1);
  const pad = (r: string[]): string[] => {
    const copy = r.slice(0, cols);
    while (copy.length < cols) copy.push("");
    return copy;
  };

  const lines: string[] = [];
  lines.push(`| ${pad(header).join(" | ")} |`);
  lines.push(`| ${Array(cols).fill("---").join(" | ")} |`);
  for (const r of rest) lines.push(`| ${pad(r).join(" | ")} |`);
  return lines.join("\n");
}

/** An emitted chunk paired with a sort key for page reading order. */
interface OrderedChunk {
  chunk: ParseChunk;
  /** Original index — stable tie-break when geometry is missing. */
  order: number;
  /** Top edge (normalized) for vertical reading order; Infinity when unknown. */
  top: number;
  /** Left edge (normalized) for horizontal tie-break; Infinity when unknown. */
  left: number;
}

/**
 * Converts a Google `Document` into ordered, provenance-carrying chunks.
 *
 * Text paragraphs (falling back to lines, then blocks) become text chunks;
 * paragraphs whose text falls inside a table's span are dropped so table text
 * isn't emitted twice. Each table becomes one chunk holding a clean markdown
 * table. Chunks are ordered top-to-bottom, left-to-right within a page by their
 * bbox, with original order as a stable fallback.
 */
export class GoogleDocAiCanonicalizer implements ChunkCanonicalizer<GoogleDocument> {
  toChunks(structured: GoogleDocument): ParseChunk[] {
    const fullText = structured.text ?? "";
    const chunks: ParseChunk[] = [];

    const pages = structured.pages ?? [];
    pages.forEach((page, pageIdx) => {
      const pageNum = page.pageNumber ?? pageIdx + 1;
      const dim = page.dimension;
      const tables = page.tables ?? [];
      const tableRanges = tables
        .map(tableTextRange)
        .filter((r): r is [number, number] => r !== null);

      const ordered: OrderedChunk[] = [];
      let order = 0;

      // Text elements: prefer paragraphs; fall back to lines, then blocks.
      const textElements =
        (page.paragraphs?.length ? page.paragraphs : undefined) ??
        (page.lines?.length ? page.lines : undefined) ??
        page.blocks ??
        [];

      for (const el of textElements) {
        const range = elementTextRange(el);
        // Skip text that belongs to a table — the table chunk carries it.
        if (range && tableRanges.some((tr) => rangesOverlap(range, tr))) continue;

        const text = textFromAnchor(fullText, el.layout?.textAnchor).trim();
        if (!text) continue;

        const bbox = bboxFromPoly(el.layout?.boundingPoly, dim);
        ordered.push({
          chunk: { text, page: pageNum, ...(bbox ? { bbox } : {}) },
          order: order++,
          top: bbox ? bbox.y : Infinity,
          left: bbox ? bbox.x : Infinity,
        });
      }

      // Tables → one markdown chunk each.
      for (const table of tables) {
        const md = serializeTable(fullText, table);
        if (!md) continue;
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
        ordered.push({
          chunk: { text: md, page: pageNum, ...(bbox ? { bbox } : {}) },
          order: order++,
          top: bbox ? bbox.y : Infinity,
          left: bbox ? bbox.x : Infinity,
        });
      }

      // Reading order: top-to-bottom, then left-to-right; stable on ties / when
      // geometry is missing (preserves the provider's emitted order).
      ordered.sort((a, b) => {
        if (a.top !== b.top) return a.top - b.top;
        if (a.left !== b.left) return a.left - b.left;
        return a.order - b.order;
      });

      for (const o of ordered) chunks.push(o.chunk);
    });

    return chunks;
  }
}

// ---------------------------------------------------------------------------
// Provider — calls Document AI, canonicalizes, returns chunks + markdown.
// ---------------------------------------------------------------------------

const DEFAULT_LOCATION = "us";

/**
 * Page-count routing thresholds. Document AI's synchronous `:process` caps at
 * 15 pages, or 30 when `imagelessMode` is set; above that the only path is
 * async `:batchProcess`.
 */
const ONLINE_MAX_PAGES = 15;
const IMAGELESS_MAX_PAGES = 30;

/** Default batch operation timeout. Large policies (200+pg) take minutes. */
const DEFAULT_BATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
/** Delay between batch long-running-operation poll attempts. */
const DEFAULT_BATCH_POLL_INTERVAL_MS = 5000;

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
}

function readConfig(payload: ParseEndpointPayload): GoogleDocAiConfig {
  const cfg = (payload.config ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof cfg[k] === "string" ? (cfg[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof cfg[k] === "number" ? (cfg[k] as number) : undefined;
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
  return merged;
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
 * Page-count routing (see file header): ≤15pg online, 16–30pg online imageless,
 * >30pg batch via GCS.
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

    // Route by page count. An unknown count (non-PDF / unreadable PDF) falls
    // back to online `:process` — the smallest, safest path.
    const pageCount = await countPdfPages(input.fileBuffer, input.mimeType);

    if (pageCount !== null && pageCount > IMAGELESS_MAX_PAGES) {
      return this.processBatch(cfg, token, input);
    }

    const imageless = pageCount !== null && pageCount > ONLINE_MAX_PAGES;
    return this.processOnline(cfg, token, input, imageless);
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
   * Synchronous online path: `:process` with the raw document inline. Sets
   * `imagelessMode` for the 16–30pg band (Document AI's documented way to lift
   * the 15-page sync cap to 30).
   */
  private async processOnline(
    cfg: GoogleDocAiConfig,
    token: string,
    input: { filename: string; mimeType: string; fileBuffer: Buffer },
    imageless: boolean,
  ): Promise<ParseResponse> {
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
      throw new Error(`google-docai process ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await resp.json()) as GoogleProcessResponse;
    const document = json.document ?? {};
    return this.buildResponse(document);
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
      throw new Error(`google-docai batchProcess ${resp.status}: ${errText.slice(0, 300)}`);
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
        throw new Error(`google-docai operation poll ${resp.status}: ${errText.slice(0, 300)}`);
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
    const markdown = chunks.map((c) => c.text).join("\n\n");
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
      markdown: merged.map((c) => c.text).join("\n\n"),
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
