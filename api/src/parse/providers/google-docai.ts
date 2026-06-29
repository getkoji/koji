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
 * Credentials are resolved per-tenant via `resolveTenantParseProvider`
 * (`parse_endpoints` → decrypt → driver registry) — never from raw env vars.
 * The driver is registered under the slug `google-docai` in `drivers.ts`.
 *
 * Live validation against a real Document AI processor needs a Google Cloud
 * access token + project/processor config and is pending. The canonicalizer is
 * unit-tested against a sample `Document` fixture (table fidelity / correct
 * column association is the key assertion).
 */

import type { ParseProvider, ParseResponse } from "../provider";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import {
  type BBox,
  type ParseChunk,
  type ChunkCanonicalizer,
  normalizeBBox,
  unionBBox,
} from "../chunk";

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

/** Document-AI-specific config read from the (decrypted) endpoint payload. */
interface GoogleDocAiConfig {
  projectId?: string;
  processorId?: string;
  /** Processor version (optional pin). */
  processorVersionId?: string;
  location?: string;
}

function readConfig(payload: ParseEndpointPayload): GoogleDocAiConfig {
  const cfg = (payload.config ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof cfg[k] === "string" ? (cfg[k] as string) : undefined;
  return {
    projectId: str("project_id") ?? str("projectId"),
    processorId: str("processor_id") ?? str("processorId"),
    processorVersionId: str("processor_version_id") ?? str("processorVersionId"),
    // `region` is the shared payload field; `location` may also be in config.
    location: payload.region ?? str("location") ?? DEFAULT_LOCATION,
  };
}

/**
 * ParseProvider backed by Google Document AI.
 *
 * Authentication: Document AI uses Google Cloud OAuth2 — `payload.api_key` is
 * sent as a Bearer access token. (Service-account JWT → access-token exchange,
 * if a tenant stores a key file instead of a token, is a follow-up; the driver
 * accepts a ready access token today.) Project / processor / location come from
 * the endpoint's `config_json`.
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

    const host = (this.payload.base_url ?? `https://${cfg.location}-documentai.googleapis.com`).replace(
      /\/$/,
      "",
    );
    const name =
      `projects/${cfg.projectId}/locations/${cfg.location}/processors/${cfg.processorId}` +
      (cfg.processorVersionId ? `/processorVersions/${cfg.processorVersionId}` : "");
    const url = `${host}/v1/${name}:process`;

    const body = JSON.stringify({
      rawDocument: {
        content: input.fileBuffer.toString("base64"),
        mimeType: input.mimeType,
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
      throw new Error(`google-docai process ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const json = (await resp.json()) as GoogleProcessResponse;
    const document = json.document ?? {};
    return this.buildResponse(document);
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
}
