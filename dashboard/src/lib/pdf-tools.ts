/**
 * Pure helpers behind the PDF viewer's optional tools (zoom, search, rotate,
 * download, print, fullscreen).
 *
 * These live outside the component so the fiddly bits — zoom stepping, the
 * rotation coordinate transform, and the search matcher's offset arithmetic —
 * are unit-testable without mounting react-pdf. Everything here is pure: no
 * DOM, no pdf.js.
 */

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Every optional tool the viewer can expose. All are OFF by default; an embed
 * opts in per-tool with `?tools=zoom,search`. Keep this list and the docs in
 * `docs/integration.md` in lockstep.
 */
export const VIEWER_TOOL_NAMES = [
  "select",
  "zoom",
  "search",
  "rotate",
  "download",
  "print",
  "fullscreen",
] as const;

export type ViewerToolName = (typeof VIEWER_TOOL_NAMES)[number];

/** Which optional tools are enabled. Absent/false means the tool is hidden. */
export type ViewerTools = Partial<Record<ViewerToolName, boolean>>;

/**
 * Parse a `?tools=` query param into a tool set.
 *
 * Unknown names are ignored rather than rejected, so an embed URL written
 * against a newer viewer keeps working against an older one (and vice versa) —
 * a host can list a tool we don't ship yet without breaking the whole embed.
 * `?tools=all` turns on every tool.
 */
export function parseToolsParam(param: string | null | undefined): ViewerTools {
  const tools: ViewerTools = {};
  if (!param) return tools;
  const requested = param
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes("all")) {
    for (const name of VIEWER_TOOL_NAMES) tools[name] = true;
    return tools;
  }
  for (const name of VIEWER_TOOL_NAMES) {
    if (requested.includes(name)) tools[name] = true;
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

/**
 * Zoom is a multiplier on the fit-to-width page size, so 1 ("100%") always
 * means "the page fills the viewer" regardless of the container's size. The
 * steps are what the − / + buttons walk through; `koji:setZoom` may pass any
 * number in between and it is only clamped.
 */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Fit-to-width — the default, and what the reset button returns to. */
export const FIT_ZOOM = 1;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return FIT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Next zoom step in a direction. Uses a small epsilon so a value sitting
 * exactly on a step (the common case) advances instead of re-selecting itself
 * through float noise.
 */
export function stepZoom(zoom: number, direction: "in" | "out"): number {
  const current = clampZoom(zoom);
  const EPS = 1e-6;
  if (direction === "in") {
    return ZOOM_STEPS.find((s) => s > current + EPS) ?? MAX_ZOOM;
  }
  const below = ZOOM_STEPS.filter((s) => s < current - EPS);
  return below.length ? below[below.length - 1] : MIN_ZOOM;
}

/** "125%" — the label on the reset button. */
export function formatZoom(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export type Rotation = 0 | 90 | 180 | 270;

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

export function isRotation(value: unknown): value is Rotation {
  return typeof value === "number" && (ROTATIONS as number[]).includes(value);
}

/** Normalize any degree value (including negatives / >360) to a Rotation. */
export function normalizeRotation(deg: number): Rotation {
  if (!Number.isFinite(deg)) return 0;
  const snapped = (Math.round(deg / 90) * 90) % 360;
  return ((snapped + 360) % 360) as Rotation;
}

export function stepRotation(rotation: Rotation, direction: "cw" | "ccw"): Rotation {
  return normalizeRotation(rotation + (direction === "cw" ? 90 : -90));
}

/** A box in the repo-wide convention: normalized 0–1 fractions, top-left origin. */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map a box from unrotated page space into the rotated display space.
 *
 * Highlights, selections, and provenance boxes are all stored against the
 * page's native orientation. When the user rotates the view, react-pdf rotates
 * the rendered page but our overlays are positioned in percentages of the
 * (now rotated) box — so every box has to be rotated to match or the
 * highlights drift off the words they belong to.
 *
 * Derivation for 90° clockwise: a point (x, y) with x rightward and y downward
 * lands at (1 − y, x) — the original top-left corner becomes the new top-right.
 * Applying that to both corners of the box and re-normalizing gives the cases
 * below; width and height swap for the quarter turns.
 */
export function rotateBox(box: NormBox, rotation: Rotation): NormBox {
  switch (rotation) {
    case 90:
      return { x: 1 - (box.y + box.h), y: box.x, w: box.h, h: box.w };
    case 180:
      return { x: 1 - (box.x + box.w), y: 1 - (box.y + box.h), w: box.w, h: box.h };
    case 270:
      return { x: box.y, y: 1 - (box.x + box.w), w: box.h, h: box.w };
    default:
      return box;
  }
}

/**
 * Inverse of {@link rotateBox} — map a box drawn in rotated display space back
 * to the page's native orientation. Region selection needs this: the user
 * drags on the rotated view, but `resolve-region` (and every stored bbox)
 * speaks unrotated page coordinates.
 */
export function unrotateBox(box: NormBox, rotation: Rotation): NormBox {
  return rotateBox(box, normalizeRotation(-rotation));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Shortest query we'll run. One character matches half the document. */
export const MIN_SEARCH_QUERY = 2;

/**
 * Fold text for matching **without changing its length**.
 *
 * Length preservation is the whole contract: match offsets computed against a
 * page's indexed text are replayed against the same page's rendered text layer
 * to draw the highlight boxes. Any normalization that inserted or dropped
 * characters (collapsing runs of whitespace, stripping soft hyphens) would
 * shift those offsets and the boxes would land on the wrong words.
 */
export function foldForSearch(text: string): string {
  // Non-breaking / narrow / thin spaces are common in PDF text layers and
  // read as ordinary spaces to anyone typing a query. All are single
  // characters, so swapping them for a plain space keeps offsets aligned.
  return text.toLowerCase().replace(/[\u00a0\u202f\u2009]/g, " ");
}

/** A hit within one page's text, as `[start, end)` character offsets. */
export interface TextMatch {
  start: number;
  end: number;
}

/**
 * All non-overlapping occurrences of `query` in `text`, in order. Both sides
 * are folded with {@link foldForSearch}, so the returned offsets index into
 * the original string unchanged.
 */
export function findMatches(text: string, query: string): TextMatch[] {
  const needle = foldForSearch(query);
  if (needle.length < MIN_SEARCH_QUERY) return [];
  const hay = foldForSearch(text);
  const out: TextMatch[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    out.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return out;
}

/** One search hit in the document: which page, and which hit on that page. */
export interface SearchHit {
  page: number;
  /** 0-based index among that page's hits — how the overlay finds it again. */
  ordinal: number;
  start: number;
  end: number;
}

/**
 * Flatten per-page text into a document-ordered hit list.
 * `pageTexts[i]` is the text of page `i + 1`.
 */
export function collectHits(pageTexts: string[], query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  pageTexts.forEach((text, i) => {
    findMatches(text, query).forEach((m, ordinal) => {
      hits.push({ page: i + 1, ordinal, start: m.start, end: m.end });
    });
  });
  return hits;
}

/** Wrap an index around a list length (so next/prev cycle). Empty → -1. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return ((index % length) + length) % length;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * A sensible download filename for the document.
 *
 * Preview URLs are opaque (`/api/jobs/<slug>/documents/<uuid>/preview?token=…`)
 * so the URL's last path segment is useless as a name — fall back to a
 * constant rather than saving a file called "preview".
 */
export function downloadFilename(filename: string | null | undefined): string {
  const trimmed = (filename ?? "").trim();
  if (!trimmed) return "document.pdf";
  // Strip any directory component a caller may have passed through.
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.pdf`;
}
