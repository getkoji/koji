/**
 * Field-level text provenance — locates extracted values in source markdown
 * and optionally resolves bounding boxes via the parse service's text_map.
 *
 * Given the extracted field values and the original markdown, finds the
 * character offset where each value appears. Supports exact match,
 * case-insensitive match, and format-aware matching for dollar amounts,
 * dates, and numbers.
 *
 * When a text_map (from the parse service) is provided, also resolves
 * bounding box coordinates for each field so the dashboard can highlight
 * values directly on the rendered PDF.
 *
 * When the parse provider instead emits structured/positional `ParseChunk`s
 * carrying geometry (PB-11), the chunk's bbox is preferred as authoritative
 * geometry over coordinates re-derived from the flattened markdown, and a
 * column-mismatch flag is raised when a value's bbox does not sit under its
 * column header's bbox (the detection counterpart to the docling wrong-column
 * bug). Both are additive — markdown-native parses are unaffected.
 */

import { resolveVocab } from "./schema-tree";
import type { ParseChunk } from "../parse/chunk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WordBox {
  text: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextSegment {
  text: string;
  page: number;
  /**
   * Spatial position of this word on the page. Optional: provenance/geometry
   * is additive — a segment whose coordinates are missing or non-finite still
   * participates in text matching, it just can't contribute a bounding box.
   * Consumers MUST guard `bbox` before reading `.x/.y/.w/.h` (a bbox-less
   * segment is skipped for highlighting, never crashes extraction).
   */
  bbox?: BBox;
  level?: "word";
  /** Character offset of this word in the exported markdown (L3 provenance). */
  md_offset?: number;
  /** Character length of this word in the exported markdown (L3 provenance). */
  md_length?: number;
}

export type TextMap = TextSegment[];

/**
 * Flat-coordinate segment shape emitted by the parse layer
 * (`TextMapSegment` in `parse/provider.ts`): geometry lives at the top level
 * (`x/y/w/h`) rather than nested under `bbox`.
 */
export interface FlatTextMapSegment {
  text: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  md_offset?: number;
  md_length?: number;
}

/**
 * Convert the parse layer's FLAT text-map segments (`{text, page, x, y, w, h}`)
 * into the provenance layer's NESTED `TextMap` (`{text, page, bbox:{x,y,w,h}}`).
 *
 * This is the single shared converter for both the build path
 * (`routes/extract.ts`) and the validate path (`routes/schemas.ts`) so the two
 * can't drift. It preserves `md_offset`/`md_length` for L3 offset lookup.
 *
 * A segment whose coordinates are missing or non-finite gets NO `bbox` (the
 * property is omitted, not zero-filled) — a zero bbox would render a bogus
 * highlight. Downstream provenance guards `bbox` before reading it, so a
 * bbox-less segment still matches text but contributes no bounding box.
 */
export function toProvenanceTextMap(
  segments: ReadonlyArray<FlatTextMapSegment>,
): TextMap {
  return segments.map((seg) => {
    const out: TextSegment = { text: seg.text, page: seg.page };
    if (
      Number.isFinite(seg.x) &&
      Number.isFinite(seg.y) &&
      Number.isFinite(seg.w) &&
      Number.isFinite(seg.h)
    ) {
      out.bbox = { x: seg.x, y: seg.y, w: seg.w, h: seg.h };
    }
    if (seg.md_offset != null) out.md_offset = seg.md_offset;
    if (seg.md_length != null) out.md_length = seg.md_length;
    return out;
  });
}

export interface ProvenanceSpan {
  offset: number;
  length: number;
  chunk?: string;
  page?: number;
  bbox?: BBox;
  /** Per-word bounding boxes for precise highlighting */
  words?: WordBox[];
  /** LLM-provided reasoning for why this value was selected */
  reasoning?: string;
  /** Per-item provenance for array fields */
  items?: ProvenanceSpan[];
  /** Per-property provenance for object items in arrays */
  properties?: Record<string, ProvenanceSpan | null>;
  /**
   * Set when the value's bounding box does not sit horizontally under its
   * column header's bounding box — a likely wrong-column association in a
   * table (the detection counterpart to the docling reading-order /
   * wrong-column bug). Only computed when chunk geometry is available and a
   * header for the field is found; absent otherwise. `false` means "checked,
   * value sits under its header"; `undefined` means "not checked / no header."
   */
  column_mismatch?: boolean;
  /**
   * How this span's **geometry** (bbox) was resolved — the resolution "rung"
   * (`docs/parse-spine-model.md`, Decision 3). The durable provenance artifact
   * is the resolved bbox PLUS this rung, so the UI can distinguish an exact
   * locate from a best guess and honestly show "no source" instead of a wrong
   * box:
   *   - `"offset"` — direct md_offset overlap lookup (L3, exact);
   *   - `"chunk"`  — authoritative structured/positional chunk bbox (PB-11);
   *   - `"fuzzy"`  — best-effort fuzzy text/value matching;
   *   - `"none"`   — no geometry resolved (no bbox to render).
   * `"anchored"` is RESERVED for the future anchored-extraction move (the LLM
   * citing a source unit id) and is intentionally not populated here.
   */
  resolution?: "anchored" | "offset" | "chunk" | "fuzzy" | "none";
}

export type ProvenanceMap = Record<string, ProvenanceSpan | null>;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Strip whitespace runs down to single spaces and trim. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Remove commas and $ from a numeric string. */
function stripCurrencyFormatting(s: string): string {
  return s.replace(/[$,]/g, "").trim();
}

// ---------------------------------------------------------------------------
// Format-aware search strategies
// ---------------------------------------------------------------------------

/**
 * Try to find `needle` in `haystack`. Returns the offset and length of the
 * match in the *original* haystack, or null.
 */
function findExact(haystack: string, needle: string): { offset: number; length: number } | null {
  const idx = haystack.indexOf(needle);
  if (idx !== -1) return { offset: idx, length: needle.length };
  return null;
}

/**
 * For short values (≤4 chars like state codes, abbreviations), prefer
 * word-boundary matches to avoid matching inside longer words
 * (e.g. "NC" inside "INCORPORATION").
 */
function findWordBoundary(haystack: string, needle: string): { offset: number; length: number } | null {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "i");
  const m = haystack.match(pattern);
  if (m && m.index !== undefined) {
    return { offset: m.index, length: m[0].length };
  }
  return null;
}

/**
 * Find a numeric/dollar value ensuring it's not a prefix of a larger number.
 * E.g. "$1,000" must not match inside "$1,000,000".
 */
function findNumericBounded(haystack: string, needle: string): { offset: number; length: number } | null {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped + "(?![\\d,.])", "i");
  const m = haystack.match(pattern);
  if (m && m.index !== undefined) {
    return { offset: m.index, length: m[0].length };
  }
  return null;
}

/**
 * Locate a numeric value within `region` as a standalone number — trying the
 * raw form first, then `$`/comma-formatted variants — using bounded matching
 * so "0" never matches inside "50,000" and "$1,000" never matches inside
 * "$1,000,000". Returns the hit offset/length, or null when the number does
 * not appear on its own.
 *
 * Shared by array-item provenance resolution (to place a bbox) and the
 * faithfulness gate (to decide whether a number is grounded), so both use
 * identical matching semantics.
 */
export function findNumericInRegion(
  region: string,
  value: number | string,
): { offset: number; length: number } | null {
  const strVal = typeof value === "number" ? String(value) : value;
  const direct = findNumericBounded(region, strVal);
  if (direct) return direct;
  const num = typeof value === "number" ? value : parseFloat(strVal.replace(/[$,]/g, ""));
  if (Number.isNaN(num)) return null;
  const formatted = num.toLocaleString("en-US");
  for (const candidate of [`$${formatted}`, formatted, `$${num}`, String(num)]) {
    const hit = findNumericBounded(region, candidate);
    if (hit) return hit;
  }
  return null;
}

/** Every complete numeric token in `text`, parsed to a Number. Grouping commas
 *  are stripped; whole comma/decimal-grouped runs are read as ONE number, so
 *  "$1,000,000" yields 1000000 (not 1, 000, 000) and "9.00" yields 9. */
function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = parseFloat(m[0].replace(/,/g, ""));
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

/**
 * True when `value` occurs as a complete number in `region`, compared
 * NUMERICALLY (not by string boundary): every numeric token in the region is
 * parsed and checked for equality against the value. This is robust to
 * format differences that trip up boundary regexes — `9` matches `"9.00"`,
 * `70.3` matches `"70.30"`, `50000` matches `"$50,000"` — while still refusing
 * spurious sub-matches: a fabricated `0` does NOT match `"$50,000"` (whose only
 * token is 50000), and `1000` does NOT match `"$1,000,000"` (token 1000000).
 *
 * Used by the faithfulness gate to decide whether the model actually read a
 * number off the page (present in the text it cited) or invented it.
 */
export function numericAnchoredInText(region: string, value: number | string): boolean {
  const target = typeof value === "number" ? value : parseFloat(String(value).replace(/[$,]/g, ""));
  if (Number.isNaN(target)) return false;
  return numbersInText(region).some((n) => Math.abs(n - target) < 1e-9);
}

/**
 * Try matching with HTML entity variants: `&` ↔ `&amp;`.
 * PDF parsers often produce `&amp;` in markdown while the LLM extracts `&`.
 */
function findWithEntities(haystack: string, needle: string): { offset: number; length: number } | null {
  // Try replacing & with &amp; in the needle
  if (needle.includes("&") && !needle.includes("&amp;")) {
    const entityNeedle = needle.replace(/&/g, "&amp;");
    const hit = findExact(haystack, entityNeedle) ?? findCaseInsensitive(haystack, entityNeedle) ?? findNormalized(haystack, entityNeedle);
    if (hit) return hit;
  }
  // Try replacing &amp; with & in the needle
  if (needle.includes("&amp;")) {
    const decodedNeedle = needle.replace(/&amp;/g, "&");
    const hit = findExact(haystack, decodedNeedle) ?? findCaseInsensitive(haystack, decodedNeedle) ?? findNormalized(haystack, decodedNeedle);
    if (hit) return hit;
  }
  return null;
}

function findCaseInsensitive(haystack: string, needle: string): { offset: number; length: number } | null {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx !== -1) return { offset: idx, length: needle.length };
  return null;
}

function findNormalized(haystack: string, needle: string): { offset: number; length: number } | null {
  // Normalize both sides for matching, but we need to map back to the
  // original haystack offset. Use a regex-based approach.
  const normNeedle = normalizeWhitespace(needle);
  if (!normNeedle) return null;

  // Build a regex that allows flexible whitespace between words
  const words = normNeedle.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(words.join("\\s+"), "i");
  const m = haystack.match(pattern);
  if (m && m.index !== undefined) {
    return { offset: m.index, length: m[0].length };
  }
  return null;
}

/**
 * Multi-line address matching. Addresses are often extracted as a single
 * comma-separated string ("123 Main St, Suite 200, New York, NY 10001")
 * but appear in the source as multiple lines:
 *   123 Main St
 *   Suite 200
 *   New York, NY 10001
 *
 * Builds a regex where commas/newlines in the needle match either commas
 * or newlines (with optional surrounding whitespace) in the haystack.
 */
function findMultiLine(haystack: string, needle: string): { offset: number; length: number } | null {
  // Only try if the needle contains commas or newlines — avoid overhead
  // for simple strings.
  if (!needle.includes(",") && !needle.includes("\n")) return null;

  // Split on comma-or-newline boundaries, keep non-empty trimmed segments.
  const segments = needle.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  // Join the (regex-escaped) segments with a flexible separator that
  // matches comma or newline plus any surrounding whitespace.
  const escaped = segments.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("[,\\n\\r]\\s*"), "i");
  const m = haystack.match(pattern);
  if (m && m.index !== undefined) {
    return { offset: m.index, length: m[0].length };
  }
  return null;
}

/**
 * Fuzzy OCR text matching. OCR engines commonly confuse visually similar
 * characters. This function builds a regex with character classes for
 * commonly confused pairs (l/1/I/|, 0/O/o, 5/S/s, 8/B, g/9/q, Z/2) plus
 * the rn↔m substitution (the "cornpany" / "company" classic), then
 * attempts a match.
 *
 * Only fires as a last-resort fallback because the false-positive risk
 * grows on short strings — require ≥ 6 characters before even trying.
 * The match also has to *differ* from the original needle; otherwise it
 * would have been caught by an earlier exact-or-case-insensitive pass
 * and shouldn't get re-reported by this layer.
 */
function findFuzzyOcr(haystack: string, needle: string): { offset: number; length: number } | null {
  if (needle.length < 6) return null;

  // Common OCR confusion pairs (bidirectional). Map each problem
  // character to a character class that accepts any visually-similar
  // variant.
  const ocrMap: Record<string, string> = {
    l: "[l1I|]",
    "1": "[1lI|]",
    I: "[Il1|]",
    "0": "[0Oo]",
    O: "[O0o]",
    o: "[o0O]",
    "5": "[5S]",
    S: "[S5]",
    s: "[s5]",
    "8": "[8B]",
    B: "[B8]",
    g: "[g9q]",
    "9": "[9gq]",
    q: "[qg9]",
    Z: "[Z2]",
    "2": "[2Z]",
  };

  let patternStr = "";
  for (const ch of needle) {
    if (ocrMap[ch]) {
      patternStr += ocrMap[ch];
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      patternStr += "\\" + ch;
    } else {
      patternStr += ch;
    }
  }

  // Handle "rn" ↔ "m" substitution (common OCR confusion). The second
  // replace guards against re-rewriting the "m" we just inserted as part
  // of an "(?:rn|m)" group.
  patternStr = patternStr.replace(/rn/g, "(?:rn|m)");
  patternStr = patternStr.replace(/(?<!(?:\(\?:rn\|))m(?!\))/g, "(?:m|rn)");

  try {
    const m = haystack.match(new RegExp(patternStr, "i"));
    if (m && m.index !== undefined && m[0].toLowerCase() !== needle.toLowerCase()) {
      return { offset: m.index, length: m[0].length };
    }
  } catch {
    // Malformed regex from an unusual character combination — fall through.
  }
  return null;
}

/**
 * Search for a dollar amount in multiple representations:
 * - "$1,000,000" / "$1000000" / "1,000,000" / "1000000"
 */
function findDollarAmount(haystack: string, value: number | string): { offset: number; length: number } | null {
  const num = typeof value === "string" ? parseFloat(stripCurrencyFormatting(value)) : value;
  if (isNaN(num)) return null;

  // Generate candidate representations — prefer more-specific (two-decimal)
  // forms first so we match "$1,500.00" before the shorter "$1,500".
  const candidates: string[] = [];

  // Two-decimal version (most specific, try first)
  const twoDecimal = num.toFixed(2);
  const twoDecimalFormatted = parseFloat(twoDecimal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  candidates.push(`$${twoDecimalFormatted}`, twoDecimalFormatted, `$${twoDecimal}`, twoDecimal);

  // With commas (integer-formatted)
  const formatted = num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const formattedInt = num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  candidates.push(`$${formatted}`, formatted, `$${formattedInt}`, formattedInt);

  // Plain number (no commas)
  const plain = Number.isInteger(num) ? String(num) : num.toFixed(2);
  candidates.push(`$${plain}`, plain);

  // Deduplicate
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const result = findCaseInsensitive(haystack, c);
    if (result) return result;
  }

  return null;
}

/**
 * Search for a date in multiple formats:
 * - YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, Month DD, YYYY, etc.
 */
function findDate(haystack: string, value: string): { offset: number; length: number } | null {
  // Try the value as-is first
  const exact = findCaseInsensitive(haystack, value);
  if (exact) return exact;

  // Parse YYYY-MM-DD
  const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;

  const [, year, monthStr, dayStr] = m;
  const month = parseInt(monthStr!, 10);
  const day = parseInt(dayStr!, 10);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthAbbr = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const yy = year!.slice(-2);
  const ordinal = day === 1 || day === 21 || day === 31 ? `${day}st`
    : day === 2 || day === 22 ? `${day}nd`
    : day === 3 || day === 23 ? `${day}rd`
    : `${day}th`;

  const candidates: string[] = [
    // MM/DD/YYYY
    `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`,
    // M/D/YYYY
    `${month}/${day}/${year}`,
    // DD/MM/YYYY
    `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
    // Month DD, YYYY
    `${monthNames[month - 1]} ${day}, ${year}`,
    `${monthNames[month - 1]} ${String(day).padStart(2, "0")}, ${year}`,
    // DD Month YYYY
    `${day} ${monthNames[month - 1]} ${year}`,
    // Mon DD, YYYY
    `${monthAbbr[month - 1]} ${day}, ${year}`,
    `${monthAbbr[month - 1]} ${String(day).padStart(2, "0")}, ${year}`,
    // MM-DD-YYYY
    `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-${year}`,
    // Two-digit year variants (slash)
    `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${yy}`,
    `${month}/${day}/${yy}`,
    // Hyphen 2-digit year: 12-04-17
    `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-${yy}`,
    `${month}-${day}-${yy}`,
    // Dot-separated: 12.04.2017, 04.12.2017
    `${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}.${year}`,
    `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
    // Month DD YYYY (no comma)
    `${monthNames[month - 1]} ${day} ${year}`,
    `${monthAbbr[month - 1]} ${day} ${year}`,
    // DD Mon YYYY
    `${day} ${monthAbbr[month - 1]} ${year}`,
    `${String(day).padStart(2, "0")} ${monthAbbr[month - 1]} ${year}`,
    // DD/MM/YY
    `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${yy}`,
    // YYYY/MM/DD
    `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
    // Month DD, YY and Mon DD, YY — named month with 2-digit year
    `${monthNames[month - 1]} ${day}, ${yy}`,
    `${monthAbbr[month - 1]} ${day}, ${yy}`,
    // Ordinal formats: "29th of April, 2003", "29th day of April, 2003"
    `${ordinal} of ${monthNames[month - 1]}, ${year}`,
    `${ordinal} of ${monthNames[month - 1]} ${year}`,
  ];

  for (const c of candidates) {
    const result = findCaseInsensitive(haystack, c);
    if (result) return result;
  }

  // Regex fallback: match ordinal + optional "day" + "of" + month + year
  // (4-digit OR 2-digit). Handles OCR variations like
  // "29th day\n\nof April, 2003".
  const ordinalPattern = new RegExp(
    `${ordinal}\\s+(?:day\\s+)?(?:of\\s+)?${monthNames[month - 1]}[,\\s]+(?:${year}|${yy})`,
    "i",
  );
  const ordMatch = haystack.match(ordinalPattern);
  if (ordMatch && ordMatch.index !== undefined) {
    return { offset: ordMatch.index, length: ordMatch[0].length };
  }

  // Final regex fallback: flexible separators around numeric date pieces.
  // Accepts MM/DD/YYYY, MM-DD-YYYY, or 2-digit-year variants, with
  // optional whitespace/newlines around separators (common in OCR
  // output). Negative-lookahead on the year guards against bleeding
  // into a longer numeric run.
  const flexDatePattern = new RegExp(
    `0?${month}\\s*[/\\-]\\s*0?${day}\\s*[/\\-]\\s*(?:${year}|${yy})(?![\\d])`,
    "i",
  );
  const flexMatch = haystack.match(flexDatePattern);
  if (flexMatch && flexMatch.index !== undefined) {
    return { offset: flexMatch.index, length: flexMatch[0].length };
  }

  return null;
}

// US state code → full name mapping for provenance expansion
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

/**
 * Search for a US state by its full name when the extracted value is a
 * 2-letter code. E.g., extracted "NC" → search for "North Carolina".
 */
function findStateName(haystack: string, code: string): { offset: number; length: number } | null {
  const fullName = STATE_NAMES[code.toUpperCase()];
  if (!fullName) return null;
  return findCaseInsensitive(haystack, fullName);
}

/**
 * Locate a SHORT code (≤4 chars — state abbreviations and the like) safely.
 *
 * A bare substring search matches the code INSIDE a longer word — the classic
 * "NC" inside "I·nc·orporation", which then highlights "Articles of
 * Incorporation" for a state field. So short codes must match at a word
 * boundary; if the bare code has no standalone token, expand a 2-letter state
 * code to its full name (NC → "North Carolina") and match that. Returns null
 * rather than an unbounded substring match — better no highlight than a
 * confidently-wrong one.
 *
 * Used by every matcher that searches a short value against the full markdown
 * (the fallback `resolveScalar`) OR against an LLM-provided source-text/context
 * region (the primary `resolveScalarViaSourceText`) — so the substring trap
 * can't sneak in through either path.
 */
function findShortCode(haystack: string, needle: string): { offset: number; length: number } | null {
  return findWordBoundary(haystack, needle)
    ?? (/^[A-Z]{2}$/i.test(needle) ? findStateName(haystack, needle) : null);
}

/**
 * Search for a number in the markdown. Tries the plain number and
 * comma-formatted variants.
 */
function findNumber(haystack: string, value: number): { offset: number; length: number } | null {
  const candidates: string[] = [];

  const plain = Number.isInteger(value) ? String(value) : value.toFixed(2);
  candidates.push(plain);

  // Comma-formatted
  const formatted = value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (formatted !== plain) candidates.push(formatted);

  // Also try as dollar amount
  const dollarResult = findDollarAmount(haystack, value);
  if (dollarResult) return dollarResult;

  for (const c of candidates) {
    const result = findExact(haystack, c);
    if (result) return result;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Page estimation from markdown offset
// ---------------------------------------------------------------------------

/** Page break separator used when joining pages into markdown. */
const PAGE_SEPARATOR = "\n\n---\n\n";

/**
 * Estimate the 1-indexed page number for a character offset in the markdown.
 * Pages are separated by `\n\n---\n\n`. Returns 1 if no separators are found.
 */
export function estimatePageFromOffset(markdown: string, offset: number): number {
  let page = 1;
  let pos = 0;
  while (true) {
    const idx = markdown.indexOf(PAGE_SEPARATOR, pos);
    if (idx === -1 || idx >= offset) break;
    page++;
    pos = idx + PAGE_SEPARATOR.length;
  }
  return page;
}

// ---------------------------------------------------------------------------
// Bounding box resolver
// ---------------------------------------------------------------------------

/**
 * Search the text_map for a segment whose text contains the given needle.
 * When preferredPage is provided and multiple matches exist, returns the
 * match on the preferred page (or closest page).
 */
function findBbox(needle: string, textMap: TextMap, preferredPage?: number): { page: number; bbox: BBox } | null {
  if (!needle || textMap.length === 0) return null;

  const lowerNeedle = needle.toLowerCase();

  // First pass: exact substring match (case-insensitive) — collect all matches
  const exactMatches: { page: number; bbox: BBox }[] = [];
  for (const seg of textMap) {
    if (!seg.bbox) continue;
    if (seg.text.toLowerCase().includes(lowerNeedle)) {
      exactMatches.push({ page: seg.page, bbox: seg.bbox });
    }
  }
  if (exactMatches.length > 0) {
    return pickClosest(exactMatches, preferredPage);
  }

  // Second pass: normalized whitespace match
  const normNeedle = normalizeWhitespace(needle).toLowerCase();
  if (normNeedle) {
    const normMatches: { page: number; bbox: BBox }[] = [];
    for (const seg of textMap) {
      if (!seg.bbox) continue;
      if (normalizeWhitespace(seg.text).toLowerCase().includes(normNeedle)) {
        normMatches.push({ page: seg.page, bbox: seg.bbox });
      }
    }
    if (normMatches.length > 0) {
      return pickClosest(normMatches, preferredPage);
    }
  }

  return null;
}

/** From a list of matches, pick the one on or closest to the preferred page. */
function pickClosest<T extends { page: number }>(matches: T[], preferredPage?: number): T {
  if (matches.length === 1 || preferredPage == null) return matches[0]!;
  let best = matches[0]!;
  let bestDist = Math.abs(best.page - preferredPage);
  for (let i = 1; i < matches.length; i++) {
    const dist = Math.abs(matches[i]!.page - preferredPage);
    if (dist < bestDist) {
      best = matches[i]!;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Locate per-word bounding boxes for an extracted value by finding
 * consecutive word-level text_map segments that match the value.
 *
 * Matching strategy:
 * 1. Exact consecutive word match (case-insensitive)
 * 2. Single-word containment (value within one word)
 * 3. Falls back to null if no match
 */
function locateWords(
  value: unknown,
  chunk: string | undefined,
  textMap: TextMap,
  preferredPage?: number,
): WordBox[] | null {
  const strValue = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (!strValue || textMap.length === 0) return null;

  // Try the matched chunk text first, then the raw value
  const candidates = chunk ? [chunk, strValue] : [strValue];

  for (const needle of candidates) {
    const needleWords = needle.trim().split(/\s+/).map((w) => w.toLowerCase());
    if (needleWords.length === 0) continue;

    // Slide through text_map looking for consecutive word matches — collect all
    const allMatches: { startIdx: number; words: WordBox[] }[] = [];
    for (let i = 0; i <= textMap.length - needleWords.length; i++) {
      let matched = true;
      for (let j = 0; j < needleWords.length; j++) {
        const seg = textMap[i + j]!;
        // A segment without geometry can't yield a word box — exclude any
        // window that covers one so the matched run is always highlightable.
        if (!seg.bbox) { matched = false; break; }
        const segText = seg.text.toLowerCase().replace(/[,.$()]/g, "");
        const needleWord = needleWords[j]!.replace(/[,.$()]/g, "");
        // Empty-after-strip segments — typically standalone punctuation like
        // bare "$" in a premium-summary column — would otherwise pass the
        // containment check (every string includes ""), so a run of them
        // matches any multi-word needle. Skip.
        if (segText === "") { matched = false; break; }
        // For digit-only words, require exact match to avoid "1000" matching "1000000".
        // For words with digits + separators (e.g. "2025-12-04"), don't allow
        // substring containment — it false-matches any component like "2025" or "04".
        const isDigitWord = /^\d+$/.test(needleWord);
        const isFormattedValue = /\d/.test(needleWord) && /[-/]/.test(needleWord);
        if (isDigitWord || isFormattedValue) {
          if (segText !== needleWord) { matched = false; break; }
        } else if (segText !== needleWord && !segText.includes(needleWord) && !needleWord.includes(segText)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        allMatches.push({
          startIdx: i,
          words: needleWords.map((_, j) => {
            const seg = textMap[i + j]!;
            // Guaranteed present: the matching loop above skips windows with a
            // bbox-less segment.
            const bbox = seg.bbox!;
            return {
              text: seg.text,
              page: seg.page,
              x: bbox.x,
              y: bbox.y,
              w: bbox.w,
              h: bbox.h,
            };
          }),
        });
      }
    }

    if (allMatches.length > 0) {
      if (allMatches.length === 1 || preferredPage == null) {
        return allMatches[0]!.words;
      }
      // Pick the match whose first word is on/closest to the preferred page
      let best = allMatches[0]!;
      let bestDist = Math.abs(best.words[0]!.page - preferredPage);
      for (let i = 1; i < allMatches.length; i++) {
        const dist = Math.abs(allMatches[i]!.words[0]!.page - preferredPage);
        if (dist < bestDist) {
          best = allMatches[i]!;
          bestDist = dist;
        }
      }
      return best.words;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// L3: Offset-based lookup (direct, no fuzzy matching)
// ---------------------------------------------------------------------------

/**
 * Check whether the text_map has L3 offset annotations (md_offset/md_length).
 * Returns true if at least one segment carries an offset. Uses `.some` rather
 * than only inspecting the first segment: serializers can annotate most items
 * while leaving a few unset (e.g. a leading raw-text fallback or an item that
 * trimmed to empty), and the L3 path should still run for the annotated majority
 * (unannotated values fall through to fuzzy matching in `resolveBbox`).
 */
export function hasOffsetAnnotations(textMap: TextMap): boolean {
  return textMap.some((seg) => seg.md_offset != null);
}

/**
 * Find text_map segments whose md_offset range overlaps with a given
 * markdown character range [offset, offset+length). Direct O(n) lookup
 * that replaces fuzzy text matching when L3 offset data is available.
 */
export function locateWordsByOffset(
  textMap: TextMap,
  offset: number,
  length: number,
): WordBox[] | null {
  const end = offset + length;
  const words: WordBox[] = [];

  for (const seg of textMap) {
    if (seg.md_offset == null || seg.md_length == null) continue;
    // No geometry → no word box; skip (still best-effort, never crashes).
    if (!seg.bbox) continue;
    const segEnd = seg.md_offset + seg.md_length;
    // Overlap check: segment overlaps [offset, end)
    if (seg.md_offset < end && segEnd > offset) {
      words.push({
        text: seg.text,
        page: seg.page,
        x: seg.bbox.x,
        y: seg.bbox.y,
        w: seg.bbox.w,
        h: seg.bbox.h,
      });
    }
  }

  return words.length > 0 ? words : null;
}

/** Compute the enclosing bounding box of an array of word boxes. */
function enclosingBbox(words: WordBox[]): { page: number; bbox: BBox } | null {
  if (words.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of words) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.w);
    maxY = Math.max(maxY, w.y + w.h);
  }
  return {
    page: words[0]!.page,
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

/**
 * Resolve bounding boxes for a value.
 *
 * When L3 offset annotations are available on the text_map, uses direct
 * offset-based lookup — no fuzzy text matching needed. Falls back to
 * the original per-word and paragraph-level fuzzy matching when offsets
 * are not available.
 *
 * When markdown and offset are provided, estimates the page from the
 * markdown offset and prefers text_map matches on the same page. This
 * resolves the bug where duplicate text across pages (e.g. the same
 * date on declarations and endorsements) would match the wrong occurrence.
 */
/**
 * Expand a chunk by grabbing surrounding words from the markdown.
 * This helps disambiguate short/common words in the textMap by providing
 * a longer, more unique search string.
 */
function expandChunkFromMarkdown(
  chunk: string,
  markdown: string,
  offset: number,
  wordsEachSide = 2,
): string {
  // Find where the chunk starts in the markdown (it should be at `offset`)
  const before = markdown.slice(Math.max(0, offset - 200), offset);
  const after = markdown.slice(offset + chunk.length, offset + chunk.length + 200);

  const wordsBefore = before.trim().split(/\s+/).filter(Boolean).slice(-wordsEachSide);
  const wordsAfter = after.trim().split(/\s+/).filter(Boolean).slice(0, wordsEachSide);

  return [...wordsBefore, chunk, ...wordsAfter].join(" ");
}

/** A resolved bbox plus the rung recording HOW it was located. */
type BboxHit = {
  page: number;
  bbox: BBox;
  words?: WordBox[];
  /** "offset" = exact md_offset lookup (L3); "fuzzy" = best-effort matching. */
  resolution: "offset" | "fuzzy";
};

function resolveBbox(
  value: unknown,
  chunk: string | undefined,
  textMap: TextMap,
  markdown?: string,
  offset?: number,
): BboxHit | null {
  // L3 path: direct offset lookup when md_offset annotations are present
  if (offset != null && chunk != null && hasOffsetAnnotations(textMap)) {
    const words = locateWordsByOffset(textMap, offset, chunk.length);
    if (words && words.length > 0) {
      const enclosing = enclosingBbox(words);
      if (enclosing) {
        return { ...enclosing, words, resolution: "offset" };
      }
    }
  }

  // Legacy path: fuzzy text matching
  const preferredPage = (markdown != null && offset != null)
    ? estimatePageFromOffset(markdown, offset)
    : undefined;

  // Try per-word matching first
  const words = locateWords(value, chunk, textMap, preferredPage);
  if (words && words.length > 0) {
    const enclosing = enclosingBbox(words);
    if (enclosing) {
      return { ...enclosing, words, resolution: "fuzzy" };
    }
  }

  // Try paragraph-level segment matching with the chunk
  if (chunk) {
    const hit = findBbox(chunk, textMap, preferredPage);
    if (hit) return { ...hit, resolution: "fuzzy" };
  }

  // Context expansion: when chunk alone fails, expand with surrounding words
  // from the markdown to create a more unique search string, then locate
  // within that expanded match.
  if (chunk && markdown != null && offset != null) {
    const expanded = expandChunkFromMarkdown(chunk, markdown, offset);
    if (expanded !== chunk) {
      // Try locateWords with the expanded string
      const expandedWords = locateWords(expanded, undefined, textMap, preferredPage);
      if (expandedWords && expandedWords.length > 0) {
        const enclosing = enclosingBbox(expandedWords);
        if (enclosing) {
          return { ...enclosing, words: expandedWords, resolution: "fuzzy" };
        }
      }
      // Try findBbox with expanded string
      const expandedHit = findBbox(expanded, textMap, preferredPage);
      if (expandedHit) return { ...expandedHit, resolution: "fuzzy" };
    }
  }

  // Last resort: try the raw extracted value (no fallback guessing — findBbox
  // will reject matches too far from the preferred page)
  const strValue = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (strValue && strValue !== chunk) {
    const hit = findBbox(strValue, textMap, preferredPage);
    if (hit) return { ...hit, resolution: "fuzzy" };
  }

  // No reliable match found — return null rather than guess wrong.
  return null;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve text provenance for each extracted field against the source markdown.
 *
 * Returns a map of field name -> ProvenanceSpan (offset + length in the
 * markdown), or null if the value could not be located.
 *
 * When textMap is provided, also resolves bounding box coordinates for
 * highlighting on the rendered PDF.
 */
/**
 * Resolve provenance for a single scalar value (string or number).
 * Returns a ProvenanceSpan with offset, chunk, and optional bbox, or null.
 */
function resolveScalar(
  value: unknown,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  let result: { offset: number; length: number } | null = null;

  if (typeof value === "string") {
    const isNumericStr = /^\$?[\d,.]+$/.test(value);
    if (isNumericStr) {
      // Numeric strings: use bounded matching to avoid "$1,000" inside "$1,000,000"
      result = findNumericBounded(markdown, value);
      if (!result) result = findDollarAmount(markdown, value);
    } else if (value.length <= 4) {
      // Short codes (2-letter state abbreviations, etc.) must ONLY match at a
      // word boundary (see findShortCode) — never as an unbounded substring,
      // which matches "NC" inside "I·nc·orporation". The date/multi-line/fuzzy
      // fallbacks below are no-ops for ≤4-char values anyway (date needs ≥8
      // chars, multi-line needs a comma, fuzzy needs ≥6).
      result = findShortCode(markdown, value);
    } else {
      result =
        findExact(markdown, value) ??
        findWithEntities(markdown, value) ??
        findCaseInsensitive(markdown, value) ??
        findNormalized(markdown, value);
      if (!result && /^[A-Z]{2}$/.test(value)) {
        result = findStateName(markdown, value);
      }
      if (!result && /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
        result = findDate(markdown, value);
      }
      // Multi-line address matching: extracted value has commas but
      // source has line breaks instead (or vice versa).
      if (!result) {
        result = findMultiLine(markdown, value);
      }
      // Fuzzy OCR matching as the absolute last resort — guards against
      // visually-similar character confusion (l/1/I, 0/O/o, 5/S, 8/B,
      // g/9/q, Z/2, rn↔m).
      if (!result) {
        result = findFuzzyOcr(markdown, value);
      }
    }
  } else if (typeof value === "number") {
    // Use bounded matching for numbers — prefer most specific forms first
    const formatted = value.toLocaleString("en-US");
    const twoDecimal = value.toFixed(2);
    const twoDecimalFmt = parseFloat(twoDecimal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const plain = Number.isInteger(value) ? String(value) : twoDecimal;
    const candidates = [
      `$${twoDecimalFmt}`, `$${twoDecimal}`, `$${formatted}`, `$${plain}`,
      twoDecimalFmt, twoDecimal, formatted, plain,
    ];
    for (const c of candidates) {
      result = findNumericBounded(markdown, c);
      if (result) break;
    }
    if (!result) result = findNumber(markdown, value);
  }

  if (!result) return null;

  const chunk = markdown.slice(result.offset, result.offset + result.length);
  const span: ProvenanceSpan = {
    offset: result.offset,
    length: result.length,
    chunk,
    page: estimatePageFromOffset(markdown, result.offset),
  };

  if (textMap && textMap.length > 0) {
    const bboxHit = resolveBbox(value, chunk, textMap, markdown, result.offset);
    if (bboxHit) {
      span.page = bboxHit.page;
      span.bbox = bboxHit.bbox;
      span.resolution = bboxHit.resolution;
      if (bboxHit.words) {
        span.words = bboxHit.words;
      }
    }
  }

  return span;
}

/**
 * Resolve provenance for an array item using its LLM-provided source text.
 * Searches the markdown for the verbatim text and resolves bbox via text_map.
 * Returns null if the source text can't be located.
 */
function resolveObjectItemFromSourceText(
  sourceText: string,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  if (!sourceText) return null;

  // Try exact match first, then normalized whitespace
  let result = findExact(markdown, sourceText)
    ?? findNormalized(markdown, sourceText);

  if (!result) return null;

  const chunk = markdown.slice(result.offset, result.offset + result.length);
  const page = estimatePageFromOffset(markdown, result.offset);
  const span: ProvenanceSpan = {
    offset: result.offset,
    length: result.length,
    chunk,
    page,
  };

  if (textMap && textMap.length > 0) {
    const bboxHit = resolveBbox(sourceText, chunk, textMap, markdown, result.offset);
    if (bboxHit) {
      span.bbox = bboxHit.bbox;
      span.resolution = bboxHit.resolution;
      span.page = bboxHit.page;
      if (bboxHit.words) span.words = bboxHit.words;
    }
  }

  return span;
}

/**
 * For an object array item, find the page in the markdown that contains the
 * most of the item's property values. Returns page-level provenance only —
 * no bbox or word highlighting, since object items are assembled from
 * multiple places and any single highlight would be misleading.
 */
function resolveObjectItem(
  obj: Record<string, unknown>,
  markdown: string,
): ProvenanceSpan | null {
  // Collect searchable scalar values (strings ≥3 chars, numbers ≥4 digits)
  const needles: string[] = [];
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.length >= 3) needles.push(val);
    else if (typeof val === "number" && Math.abs(val) >= 1000) needles.push(String(val));
  }
  if (needles.length === 0) return null;

  // Split markdown into pages and score each by needle hits
  const pages = markdown.split(PAGE_SEPARATOR);
  let bestPage = 1;
  let bestHits = 0;
  let bestPageOffset = 0;
  let offset = 0;

  for (let i = 0; i < pages.length; i++) {
    const pageLower = pages[i]!.toLowerCase();
    let hits = 0;
    for (const needle of needles) {
      if (pageLower.includes(needle.toLowerCase())) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestPage = i + 1;
      bestPageOffset = offset;
    }
    offset += pages[i]!.length + PAGE_SEPARATOR.length;
  }

  if (bestHits === 0) return null;

  return {
    offset: bestPageOffset,
    length: 0,
    page: bestPage,
  };
}

/**
 * Resolve provenance for an array value. Each item is resolved independently.
 * String/number items use the scalar resolver. Object items prefer LLM-provided
 * source texts for precise matching, falling back to heuristic page-scoring.
 */
function resolveArray(
  items: unknown[],
  markdown: string,
  textMap?: TextMap,
  itemSourceTexts?: string[],
  itemFieldSpecs?: Record<string, Record<string, unknown>>,
): ProvenanceSpan | null {
  if (items.length === 0) return null;

  const resolved: ProvenanceSpan[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null) continue;
    if (typeof item === "string" || typeof item === "number") {
      const span = resolveScalar(item, markdown, textMap);
      if (span) resolved.push(span);
    } else if (typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      // Prefer LLM-provided source text for precise matching
      const srcText = itemSourceTexts?.[i];
      let span: ProvenanceSpan | null = null;
      if (srcText) {
        span = resolveObjectItemFromSourceText(srcText, markdown, textMap);
      }
      if (!span) {
        span = resolveObjectItem(obj, markdown);
      }
      // Resolve per-property provenance for each scalar value.
      // When we have source text, search within that region first —
      // avoids false matches like "$1,000" inside "$1,000,000".
      if (span) {
        const properties: Record<string, ProvenanceSpan | null> = {};
        const regionOffset = span.offset;
        const region = srcText && span.chunk ? span.chunk : null;

        for (const [propName, propValue] of Object.entries(obj)) {
          if (propValue == null) {
            properties[propName] = null;
            continue;
          }
          if (typeof propValue !== "string" && typeof propValue !== "number") {
            properties[propName] = null;
            continue;
          }

          let propSpan: ProvenanceSpan | null = null;

          // First: search within the source text region for precise matching
          if (region) {
            const strVal = typeof propValue === "number" ? String(propValue) : propValue;
            const isNumeric = typeof propValue === "number" || /^\$?[\d,.]+$/.test(strVal);

            let localHit: { offset: number; length: number } | null = null;

            if (isNumeric) {
              // Bounded matching (shared with the faithfulness gate) — avoids
              // "$1,000" matching inside "$1,000,000"; tries $/comma variants.
              localHit = findNumericInRegion(region, propValue);
            } else {
              // String value: try the value, then its printed aliases (the model
              // usually returns the canonical code, e.g. `each_occurrence`, while
              // the document says "Each Occurrence"). Match against exact,
              // entity-aware, case-insensitive, and normalized forms.
              const searchTerms = [strVal, ...aliasCandidates(strVal, itemFieldSpecs?.[propName], obj)];
              for (const term of searchTerms) {
                localHit =
                  findExact(region, term) ??
                  findWithEntities(region, term) ??
                  findCaseInsensitive(region, term) ??
                  findNormalized(region, term);
                if (localHit) break;
              }
            }
            if (localHit) {
              // Translate local offset to absolute markdown offset
              const absOffset = regionOffset + localHit.offset;
              const chunk = markdown.slice(absOffset, absOffset + localHit.length);
              propSpan = {
                offset: absOffset,
                length: localHit.length,
                chunk,
                page: estimatePageFromOffset(markdown, absOffset),
              };
              if (textMap && textMap.length > 0) {
                const bboxHit = resolveBbox(propValue, chunk, textMap, markdown, absOffset);
                if (bboxHit) {
                  propSpan.page = bboxHit.page;
                  propSpan.bbox = bboxHit.bbox;
                  propSpan.resolution = bboxHit.resolution;
                  if (bboxHit.words) propSpan.words = bboxHit.words;
                }
              }
            }
          }

          // Fallback: search the full markdown — first the value directly,
          // then its printed aliases for canonicalized fields.
          if (!propSpan) {
            propSpan = resolveScalar(propValue, markdown, textMap) ?? null;
          }
          if (!propSpan && typeof propValue === "string" && itemFieldSpecs?.[propName]) {
            propSpan = resolveViaAliases(propValue, itemFieldSpecs[propName]!, markdown, textMap, obj);
          }

          properties[propName] = propSpan;
        }
        span.properties = properties;
        resolved.push(span);
      }
    }
  }

  if (resolved.length === 0) return null;

  const first = resolved[0]!;
  return {
    offset: first.offset,
    length: first.length,
    chunk: first.chunk,
    page: first.page,
    bbox: first.bbox,
    words: first.words,
    resolution: first.resolution,
    items: resolved,
  };
}

/**
 * Resolve provenance for a standalone object value (not inside an array) by
 * resolving each property and exposing them under `properties`, mirroring how
 * object items inside arrays are handled. The object span's own
 * offset/chunk/bbox anchor on the first resolvable property.
 */
function resolveObjectField(
  obj: Record<string, unknown>,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  const properties: Record<string, ProvenanceSpan | null> = {};
  let anchor: ProvenanceSpan | null = null;
  for (const [propName, propValue] of Object.entries(obj)) {
    const span = resolveValue(propValue, markdown, textMap);
    properties[propName] = span;
    if (!anchor && span) anchor = span;
  }
  if (!anchor) return null;
  return {
    offset: anchor.offset,
    length: anchor.length,
    chunk: anchor.chunk,
    page: anchor.page,
    bbox: anchor.bbox,
    words: anchor.words,
    resolution: anchor.resolution,
    properties,
  };
}

/** Dispatch provenance resolution by value shape (scalar / array / object). */
function resolveValue(
  value: unknown,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  if (value == null) return null;
  if (Array.isArray(value)) return resolveArray(value, markdown, textMap);
  if (typeof value === "object") return resolveObjectField(value as Record<string, unknown>, markdown, textMap);
  return resolveScalar(value, markdown, textMap);
}

/**
 * For enum/mapping fields, search for the mapping's aliases in the markdown
 * when the canonical value can't be found directly.
 * E.g. extracted "directors_and_officers" → search for "D&O", "Directors and Officers", etc.
 */
/**
 * Search terms for a canonicalized value's printed form: the field's aliases
 * for that canonical key (from static `mappings` OR the `vocab_by` branch
 * selected by `siblings`), plus an underscores→spaces variant. Used to recover
 * the document's verbatim text when the model returned the canonical code
 * (e.g. value `each_occurrence`, document says "Each Occurrence").
 */
function aliasCandidates(
  canonicalValue: string,
  fieldSpec: Record<string, unknown> | undefined,
  siblings?: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  if (fieldSpec && typeof fieldSpec === "object") {
    let mappings = fieldSpec.mappings as Record<string, unknown[]> | undefined;
    if ((!mappings || Object.keys(mappings).length === 0) && fieldSpec.vocab_by) {
      mappings = resolveVocab(fieldSpec, siblings ?? {}).spec.mappings as Record<string, unknown[]> | undefined;
    }
    const aliases = mappings?.[canonicalValue];
    if (Array.isArray(aliases)) out.push(...aliases.map(String));
  }
  if (canonicalValue.includes("_")) out.push(canonicalValue.replace(/_/g, " "));
  return out.filter((a) => a && a !== canonicalValue);
}

function resolveViaAliases(
  canonicalValue: string,
  fieldSpec: Record<string, unknown>,
  markdown: string,
  textMap?: TextMap,
  siblings?: Record<string, unknown>,
): ProvenanceSpan | null {
  const candidates = aliasCandidates(canonicalValue, fieldSpec, siblings);
  if (candidates.length === 0) return null;

  for (const alias of candidates) {
    const span = resolveScalar(alias, markdown, textMap);
    if (span) return span;
  }
  return null;
}

/**
 * For boolean fields, search for common representations in the markdown
 * when "true"/"false" can't be found directly.
 * Documents use "Yes", "No", "X", "✓", "☑", "Included", etc.
 */
function resolveBoolean(
  value: boolean,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  const truthy = ["Yes", "YES", "yes", "Y", "X", "✓", "☑", "✔", "Included", "INCLUDED", "Active", "ACTIVE"];
  const falsy = ["No", "NO", "no", "N", "☐", "Excluded", "EXCLUDED", "Inactive", "INACTIVE", "N/A", "n/a", "None", "NONE"];
  const candidates = value ? truthy : falsy;

  for (const candidate of candidates) {
    const span = candidate.length <= 4
      ? findWordBoundary(markdown, candidate)
      : findExact(markdown, candidate);
    if (span) {
      const chunk = markdown.slice(span.offset, span.offset + span.length);
      const result: ProvenanceSpan = {
        offset: span.offset,
        length: span.length,
        chunk,
        page: estimatePageFromOffset(markdown, span.offset),
      };
      if (textMap && textMap.length > 0) {
        const bboxHit = resolveBbox(candidate, chunk, textMap, markdown, span.offset);
        if (bboxHit) {
          result.page = bboxHit.page;
          result.bbox = bboxHit.bbox;
          result.resolution = bboxHit.resolution;
          if (bboxHit.words) result.words = bboxHit.words;
        }
      }
      return result;
    }
  }
  return null;
}

/**
 * Resolve provenance for a scalar field using LLM-provided source text and context.
 * Tries context-narrowed search first, then direct source text search.
 */
function resolveScalarViaSourceText(
  sourceText: string,
  sourceContext: string | undefined,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  if (!sourceText) return null;

  let result: { offset: number; length: number } | null = null;

  // Short source texts (e.g. a state code the LLM echoed as "NC" instead of the
  // verbatim "North Carolina") must be located with the word-boundary guard, or
  // they substring-match inside a longer word — even within a correct context
  // region ("nc" in "…Incorporation…") or in the full markdown. Long source
  // texts keep ordinary substring matching, which is more permissive.
  const isShort = sourceText.length <= 4;

  // Strategy 1: find context in haystack, then source text within context region
  if (sourceContext) {
    const ctxHit = findExact(markdown, sourceContext)
      ?? findCaseInsensitive(markdown, sourceContext)
      ?? findNormalized(markdown, sourceContext);
    if (ctxHit) {
      const region = markdown.slice(ctxHit.offset, ctxHit.offset + ctxHit.length);
      const localHit = isShort
        ? findShortCode(region, sourceText)
        : (findExact(region, sourceText) ?? findCaseInsensitive(region, sourceText));
      if (localHit) {
        result = {
          offset: ctxHit.offset + localHit.offset,
          length: localHit.length,
        };
      }
    }
  }

  // Strategy 2: find source text directly in the full haystack
  if (!result) {
    result = isShort
      ? findShortCode(markdown, sourceText)
      : (findExact(markdown, sourceText)
        ?? findCaseInsensitive(markdown, sourceText)
        ?? findNormalized(markdown, sourceText));
  }

  if (!result) return null;

  const chunk = markdown.slice(result.offset, result.offset + result.length);
  const span: ProvenanceSpan = {
    offset: result.offset,
    length: result.length,
    chunk,
    page: estimatePageFromOffset(markdown, result.offset),
  };

  if (textMap && textMap.length > 0) {
    const bboxHit = resolveBbox(sourceText, chunk, textMap, markdown, result.offset);
    if (bboxHit) {
      span.page = bboxHit.page;
      span.bbox = bboxHit.bbox;
      span.resolution = bboxHit.resolution;
      if (bboxHit.words) span.words = bboxHit.words;
    }
  }

  return span;
}

// ---------------------------------------------------------------------------
// Chunk-level provenance (PB-11)
//
// When the parse provider emits structured / positional chunks
// (`ParseChunk { text, page, bbox? }` from `parse/chunk.ts`), the chunk's bbox
// is authoritative geometry — preferable to coordinates re-derived from the
// flattened markdown. This section maps an extracted value onto its source
// chunk's bbox and flags likely wrong-column associations (a value whose bbox
// does not sit under its column header's bbox).
//
// The `BBox` convention here matches `parse/chunk.ts` by design (normalized
// [0,1], top-left origin) so a chunk bbox flows straight in with no conversion.
//
// Entirely additive: when no chunk carries a bbox (markdown-native providers),
// none of this runs and provenance behaves exactly as before.
// ---------------------------------------------------------------------------

/** Do two boxes overlap on the x-axis (their horizontal extents intersect)? */
function xOverlaps(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w;
}

/**
 * Is `header` positioned above `value` on the page — its bottom edge at or
 * above the value's top edge, with a small tolerance for baseline jitter?
 * Coordinates are top-left origin, so smaller `y` is higher on the page.
 */
function isAbove(header: BBox, value: BBox): boolean {
  const tol = 0.005; // half a percent of page height
  return header.y + header.h <= value.y + tol;
}

/**
 * Candidate header strings for a field: its humanized name (`premium_amount` →
 * "premium amount") plus any schema-declared `label`/`title`. Generic — no
 * domain knowledge, just the field's own identifier.
 */
function headerCandidates(
  fieldName: string,
  fieldSpec?: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const humanized = fieldName.replace(/[_-]+/g, " ").trim();
  if (humanized) out.push(humanized);
  for (const key of ["label", "title"]) {
    const v = fieldSpec?.[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

/**
 * All bbox-bearing chunks whose text contains `value` — the candidate
 * occurrences an extracted value could have come from. When a value string
 * appears in several cells (the repeated-value case a dec page produces), this
 * returns every one so the caller can disambiguate.
 */
function matchingValueChunks(
  value: string,
  chunks: readonly ParseChunk[],
): ParseChunk[] {
  const needle = normalizeWhitespace(value).toLowerCase();
  if (!needle) return [];
  return chunks.filter(
    (c) => c.bbox && normalizeWhitespace(c.text).toLowerCase().includes(needle),
  );
}

/**
 * From a set of candidate chunks, pick the one on / closest to `preferredPage`
 * (first match when there's a single candidate or no page preference). This is
 * the pre-existing tie-break — the fallback when table-coordinate
 * disambiguation can't decide.
 */
function pickByPage(
  matches: readonly ParseChunk[],
  preferredPage?: number,
): ParseChunk | null {
  if (matches.length === 0) return null;
  if (matches.length === 1 || preferredPage == null) return matches[0]!;

  let best = matches[0]!;
  let bestDist = Math.abs(best.page - preferredPage);
  for (let i = 1; i < matches.length; i++) {
    const d = Math.abs(matches[i]!.page - preferredPage);
    if (d < bestDist) {
      best = matches[i]!;
      bestDist = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Deterministic repeated-value disambiguation via table coordinates (oss-333)
//
// When a value string appears in >=2 table cells (e.g. a `$300,000` that is both
// a limit and -- in a different column -- a matching sublimit), the first
// textual match highlights the wrong cell (the anchored-extraction spike,
// oss-331, scored the deterministic path 0/4 here). Now that `table_cell` units
// carry `{ tableId, row, col }` (oss-318), we can pick the right occurrence
// deterministically: score each candidate cell by how well the field's identity
// (its key + schema label/title/description/aliases) matches that cell's column
// header and row label, read straight off the spine's table coordinates. No
// LLM, no tokens -- the disambiguated pick is still deterministic geometry, so
// it keeps the `"chunk"` resolution rung.
//
// This is the table-coordinate counterpart to the geometric `findHeaderChunk`
// notion of a column header used by `column_mismatch`: that one finds the header
// by bbox (the chunk sitting above the value); this one finds it by cell
// coordinates (min row, same col). Both express "the header of this value's
// column"; this path uses coordinates because they disambiguate *which* cell,
// not just whether one cell sits under its header.
// ---------------------------------------------------------------------------

/** Grammatical glue that would create spurious identity/label token overlap. */
const IDENTITY_STOPWORDS = new Set([
  "the", "of", "and", "a", "an", "to", "for", "in", "on", "by", "with", "or",
]);

/** Lowercase, split on non-alphanumeric, drop stopwords and 1-char tokens. */
function tokenizeIdentity(s: string): string[] {
  return normalizeWhitespace(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !IDENTITY_STOPWORDS.has(t));
}

/**
 * Identity tokens for a field: its humanized key plus any schema-declared
 * `label`/`title`/`description`/`aliases`. Generic -- no domain knowledge, just
 * whatever the schema says this field *is*.
 */
function fieldIdentityTokens(
  fieldName: string,
  fieldSpec?: Record<string, unknown>,
): string[] {
  const parts: string[] = [fieldName.replace(/[_-]+/g, " ")];
  if (fieldSpec) {
    for (const key of ["label", "title", "description"]) {
      const v = fieldSpec[key];
      if (typeof v === "string" && v.trim()) parts.push(v);
    }
    const aliases = fieldSpec.aliases;
    if (Array.isArray(aliases)) {
      for (const a of aliases) if (typeof a === "string" && a.trim()) parts.push(a);
    }
  }
  const tokens = new Set<string>();
  for (const p of parts) for (const t of tokenizeIdentity(p)) tokens.add(t);
  return [...tokens];
}

/** Count of distinct field tokens that also appear in the label token set. */
function tokenOverlapScore(
  fieldTokens: readonly string[],
  labelTokens: readonly string[],
): number {
  if (fieldTokens.length === 0 || labelTokens.length === 0) return 0;
  const labelSet = new Set(labelTokens);
  let n = 0;
  for (const t of new Set(fieldTokens)) if (labelSet.has(t)) n++;
  return n;
}

/**
 * The text of the cell at (minimum row, candidate's col) within the candidate's
 * table -- its column header. Returns [] when the candidate has no table coords,
 * no earlier row exists, or the candidate is itself in the header row.
 */
function columnHeaderTokensFor(
  cand: ParseChunk,
  units: readonly ParseChunk[],
): string[] {
  const t = cand.table;
  if (!t) return [];
  let headerRow = Infinity;
  let headerText: string | null = null;
  for (const u of units) {
    const ut = u.table;
    if (ut && ut.tableId === t.tableId && ut.col === t.col && ut.row < headerRow) {
      headerRow = ut.row;
      headerText = u.text;
    }
  }
  if (headerText == null || headerRow >= t.row) return [];
  return tokenizeIdentity(headerText);
}

/**
 * The text of the cell at (candidate's row, minimum col) within the candidate's
 * table -- its row label. Returns [] under the same guards as the column header.
 */
function rowLabelTokensFor(
  cand: ParseChunk,
  units: readonly ParseChunk[],
): string[] {
  const t = cand.table;
  if (!t) return [];
  let labelCol = Infinity;
  let labelText: string | null = null;
  for (const u of units) {
    const ut = u.table;
    if (ut && ut.tableId === t.tableId && ut.row === t.row && ut.col < labelCol) {
      labelCol = ut.col;
      labelText = u.text;
    }
  }
  if (labelText == null || labelCol >= t.col) return [];
  return tokenizeIdentity(labelText);
}

/**
 * Deterministically pick which candidate cell a repeated value came from, by
 * matching the field's identity against each candidate's column header and row
 * label (read off the spine's table coordinates). Returns the single
 * highest-scoring candidate, or null -- the caller then falls back to the
 * existing page/first-match behavior. Strictly gated so it is purely additive:
 *   (a) >=2 candidate occurrences,
 *   (b) at least one candidate carries table coordinates,
 *   (c) the top score clears a small threshold, AND
 *   (d) that top score is unique (a tie is treated as no signal).
 */
function disambiguateByTableCoords(
  candidates: readonly ParseChunk[],
  fieldTokens: readonly string[],
  allUnits: readonly ParseChunk[],
): ParseChunk | null {
  if (candidates.length < 2 || fieldTokens.length === 0) return null;
  const coordCands = candidates.filter((c) => c.table);
  if (coordCands.length === 0) return null;

  let best: ParseChunk | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of coordCands) {
    const labelTokens = [
      ...columnHeaderTokensFor(c, allUnits),
      ...rowLabelTokensFor(c, allUnits),
    ];
    const score = tokenOverlapScore(fieldTokens, labelTokens);
    if (score > bestScore) {
      bestScore = score;
      best = c;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  // Threshold: at least one shared identity/label token, and a unique winner.
  if (!best || bestScore < 1 || tie) return null;
  return best;
}

/**
 * Find the column-header chunk for a field: a bbox-bearing chunk on the value's
 * page whose text matches one of the field's header candidates and sits above
 * the value. Returns null when none is found — the mismatch is then
 * indeterminate and deliberately not flagged.
 */
function findHeaderChunk(
  headers: string[],
  valueChunk: ParseChunk,
  chunks: readonly ParseChunk[],
): ParseChunk | null {
  if (!valueChunk.bbox) return null;
  const wanted = headers.map((h) => normalizeWhitespace(h).toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return null;

  const candidates = chunks.filter((c) => {
    if (!c.bbox || c.page !== valueChunk.page) return false;
    if (!isAbove(c.bbox, valueChunk.bbox!)) return false;
    const txt = normalizeWhitespace(c.text).toLowerCase();
    return wanted.some((w) => txt === w || txt.includes(w));
  });
  if (candidates.length === 0) return null;

  // Prefer the header nearest above the value (largest y among those above).
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i]!.bbox!.y > best.bbox!.y) best = candidates[i]!;
  }
  return best;
}

/**
 * Map a single resolved span onto chunk geometry: override its bbox/page with
 * the value's source chunk and flag a column mismatch when the value does not
 * sit under its header. No-op when no bbox-bearing chunk matches the value.
 */
function applyChunkToSpan(
  span: ProvenanceSpan,
  value: unknown,
  fieldName: string,
  fieldSpec: Record<string, unknown> | undefined,
  chunks: readonly ParseChunk[],
): void {
  const str =
    typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (!str) return;

  const candidates = matchingValueChunks(str, chunks);
  if (candidates.length === 0) return;

  // Higher-priority signal: when a value occurs in >=2 cells, disambiguate by
  // matching the field's identity to each candidate's table column header / row
  // label (oss-333). Strictly gated inside `disambiguateByTableCoords`; returns
  // null when it can't decide, in which case we fall back to the pre-existing
  // page/first-match tie-break — zero regression on the non-repeated case.
  let vc: ParseChunk | null = null;
  if (candidates.length >= 2) {
    vc = disambiguateByTableCoords(
      candidates,
      fieldIdentityTokens(fieldName, fieldSpec),
      chunks,
    );
  }
  if (!vc) vc = pickByPage(candidates, span.page);
  if (!vc || !vc.bbox) return;

  // Chunk geometry is authoritative — replace the text-derived bbox/page. The
  // disambiguated pick is still deterministic geometry, so it keeps the same
  // "chunk" rung.
  span.bbox = vc.bbox;
  span.page = vc.page;
  span.resolution = "chunk";

  const header = findHeaderChunk(headerCandidates(fieldName, fieldSpec), vc, chunks);
  if (header?.bbox) {
    span.column_mismatch = !xOverlaps(vc.bbox, header.bbox);
  }
}

/**
 * Layer chunk geometry onto a resolved provenance map (PB-11). For each field
 * with a value located in a bbox-bearing chunk, override the bbox with the
 * source chunk's box and set the column-mismatch flag. Recurses into
 * array-of-object item properties, where the wrong-column failure actually
 * manifests (table rows). Additive: fields with no matching bbox-bearing chunk
 * are left exactly as the text-based resolver produced them.
 */
function applyChunkProvenance(
  provenance: ProvenanceMap,
  extracted: Record<string, unknown>,
  chunks: readonly ParseChunk[],
  fieldSpecs?: Record<string, Record<string, unknown>>,
): void {
  for (const [field, value] of Object.entries(extracted)) {
    const span = provenance[field];
    if (!span || value == null) continue;

    if (typeof value === "string" || typeof value === "number") {
      applyChunkToSpan(span, value, field, fieldSpecs?.[field], chunks);
      continue;
    }

    // Array of objects: apply per item-property, using the property name as the
    // column header. This is the table case the column-mismatch flag targets.
    if (Array.isArray(value) && span.items) {
      const itemSpecs = (fieldSpecs?.[field]?.items as Record<string, unknown> | undefined)
        ?.properties as Record<string, Record<string, unknown>> | undefined;
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const itemSpan = span.items[i];
        if (
          !itemSpan?.properties ||
          item == null ||
          typeof item !== "object" ||
          Array.isArray(item)
        ) {
          continue;
        }
        for (const [prop, propVal] of Object.entries(item as Record<string, unknown>)) {
          const propSpan = itemSpan.properties[prop];
          if (!propSpan || propVal == null) continue;
          applyChunkToSpan(propSpan, propVal, prop, itemSpecs?.[prop], chunks);
        }
      }
    }
  }
}

/**
 * Recursively stamp `resolution: "none"` on any span (and its array items /
 * object properties) that resolved no bbox and carries no rung yet. Leaves
 * spans that already have geometry (and thus an "offset"/"chunk"/"fuzzy" rung)
 * untouched.
 */
function stampUnresolvedRung(span: ProvenanceSpan | null | undefined): void {
  if (!span) return;
  if (span.bbox === undefined && span.resolution === undefined) {
    span.resolution = "none";
  }
  if (span.items) {
    for (const item of span.items) stampUnresolvedRung(item);
  }
  if (span.properties) {
    for (const key of Object.keys(span.properties)) {
      stampUnresolvedRung(span.properties[key]);
    }
  }
}

export function resolveProvenance(
  extracted: Record<string, unknown>,
  markdown: string,
  textMap?: TextMap,
  sourceTexts?: Record<string, string[]>,
  fieldSpecs?: Record<string, Record<string, unknown>>,
  scalarSourceTexts?: Record<string, string>,
  sourceContexts?: Record<string, string>,
  chunks?: readonly ParseChunk[],
): ProvenanceMap {
  const provenance: ProvenanceMap = {};

  for (const [field, value] of Object.entries(extracted)) {
    if (value == null) {
      provenance[field] = null;
      continue;
    }

    if (Array.isArray(value)) {
      const itemProps = (fieldSpecs?.[field]?.items as Record<string, unknown> | undefined)?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      provenance[field] = resolveArray(value, markdown, textMap, sourceTexts?.[field], itemProps);
      continue;
    }

    // Standalone object: resolve per-property provenance.
    if (typeof value === "object") {
      provenance[field] = resolveObjectField(value as Record<string, unknown>, markdown, textMap);
      continue;
    }

    // Primary strategy: use LLM-provided scalar source text
    let span: ProvenanceSpan | null = null;
    const srcText = scalarSourceTexts?.[field];
    const srcContext = sourceContexts?.[field];
    if (srcText) {
      span = resolveScalarViaSourceText(srcText, srcContext, markdown, textMap);
    }

    // Fallback: standard format-variant matching
    if (!span) {
      span = resolveScalar(value, markdown, textMap);
    }
    // For enum/mapping/vocab_by fields, try aliases when the canonical value
    // isn't found directly. `extracted` provides sibling values for vocab_by.
    if (!span && typeof value === "string" && fieldSpecs?.[field]) {
      span = resolveViaAliases(value, fieldSpecs[field]!, markdown, textMap, extracted);
    }
    // For boolean fields, search for common representations
    if (!span && typeof value === "boolean") {
      span = resolveBoolean(value, markdown, textMap);
    }
    provenance[field] = span ?? null;
  }

  // PB-11: when the parse path produced chunks with geometry, layer the real
  // bbox onto each resolved span and flag wrong-column associations. Guarded on
  // at least one chunk carrying a bbox, so markdown-native parses are untouched.
  if (chunks && chunks.some((c) => c.bbox)) {
    applyChunkProvenance(provenance, extracted, chunks, fieldSpecs);
  }

  // Record the resolution rung on every span that resolved NO geometry: the
  // durable contract is "bbox + rung", so a bbox-less span is stamped "none"
  // (honest "no source") rather than left ambiguous. Spans with a bbox already
  // carry their rung ("offset" / "chunk" / "fuzzy") from resolution time.
  for (const field of Object.keys(provenance)) {
    stampUnresolvedRung(provenance[field]);
  }

  return provenance;
}
