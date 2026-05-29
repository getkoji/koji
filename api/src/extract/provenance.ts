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
 */

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
  bbox: BBox;
  level?: "word";
}

export type TextMap = TextSegment[];

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
    // Two-digit year variants
    `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${yy}`,
    `${month}/${day}/${yy}`,
    // Ordinal formats: "29th of April, 2003", "29th day of April, 2003"
    `${ordinal} of ${monthNames[month - 1]}, ${year}`,
    `${ordinal} of ${monthNames[month - 1]} ${year}`,
  ];

  for (const c of candidates) {
    const result = findCaseInsensitive(haystack, c);
    if (result) return result;
  }

  // Regex fallback: match ordinal + optional "day" + "of" + month + year
  // Handles OCR variations like "29th day\n\nof April, 2003"
  const ordinalPattern = new RegExp(
    `${ordinal}\\s+(?:day\\s+)?(?:of\\s+)?${monthNames[month - 1]}[,\\s]+${year}`,
    "i",
  );
  const ordMatch = haystack.match(ordinalPattern);
  if (ordMatch && ordMatch.index !== undefined) {
    return { offset: ordMatch.index, length: ordMatch[0].length };
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
        const segText = textMap[i + j]!.text.toLowerCase().replace(/[,.$()]/g, "");
        const needleWord = needleWords[j]!.replace(/[,.$()]/g, "");
        if (segText !== needleWord && !segText.includes(needleWord) && !needleWord.includes(segText)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        allMatches.push({
          startIdx: i,
          words: needleWords.map((_, j) => {
            const seg = textMap[i + j]!;
            return {
              text: seg.text,
              page: seg.page,
              x: seg.bbox.x,
              y: seg.bbox.y,
              w: seg.bbox.w,
              h: seg.bbox.h,
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

    // Single-word containment: value is contained within one text_map word
    if (needleWords.length === 1) {
      const lowerNeedle = needleWords[0]!;
      const singleMatches: WordBox[] = [];
      for (const seg of textMap) {
        if (seg.text.toLowerCase().replace(/[,.$()]/g, "").includes(lowerNeedle.replace(/[,.$()]/g, ""))) {
          singleMatches.push({
            text: seg.text,
            page: seg.page,
            x: seg.bbox.x,
            y: seg.bbox.y,
            w: seg.bbox.w,
            h: seg.bbox.h,
          });
        }
      }
      if (singleMatches.length > 0) {
        const picked = pickClosest(singleMatches, preferredPage);
        return [picked];
      }
    }
  }

  return null;
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
 * Resolve bounding boxes for a value. Tries per-word matching first,
 * falls back to paragraph-level segment matching.
 *
 * When markdown and offset are provided, estimates the page from the
 * markdown offset and prefers text_map matches on the same page. This
 * resolves the bug where duplicate text across pages (e.g. the same
 * date on declarations and endorsements) would match the wrong occurrence.
 */
function resolveBbox(
  value: unknown,
  chunk: string | undefined,
  textMap: TextMap,
  markdown?: string,
  offset?: number,
): { page: number; bbox: BBox; words?: WordBox[] } | null {
  const preferredPage = (markdown != null && offset != null)
    ? estimatePageFromOffset(markdown, offset)
    : undefined;

  // Try per-word matching first
  const words = locateWords(value, chunk, textMap, preferredPage);
  if (words && words.length > 0) {
    const enclosing = enclosingBbox(words);
    if (enclosing) {
      return { ...enclosing, words };
    }
  }

  // Fall back to paragraph-level segment matching
  if (chunk) {
    const hit = findBbox(chunk, textMap, preferredPage);
    if (hit) return hit;
  }

  const strValue = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (strValue) {
    const hit = findBbox(strValue, textMap, preferredPage);
    if (hit) return hit;
  }

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
    if (value.length <= 4) {
      result = findWordBoundary(markdown, value);
    }
    if (!result) {
      result =
        findExact(markdown, value) ??
        findCaseInsensitive(markdown, value) ??
        findNormalized(markdown, value);
    }
    if (!result && /^[A-Z]{2}$/.test(value)) {
      result = findStateName(markdown, value);
    }
    if (!result && /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
      result = findDate(markdown, value);
    }
    if (!result && /^\$?[\d,.]+$/.test(value)) {
      result = findDollarAmount(markdown, value);
    }
  } else if (typeof value === "number") {
    result = findNumber(markdown, value);
  }

  if (!result) return null;

  const chunk = markdown.slice(result.offset, result.offset + result.length);
  const span: ProvenanceSpan = {
    offset: result.offset,
    length: result.length,
    chunk,
  };

  if (textMap && textMap.length > 0) {
    const bboxHit = resolveBbox(value, chunk, textMap, markdown, result.offset);
    if (bboxHit) {
      span.page = bboxHit.page;
      span.bbox = bboxHit.bbox;
      if (bboxHit.words) {
        span.words = bboxHit.words;
      }
    }
  }

  return span;
}

/**
 * For an object array item, find the paragraph in the markdown that contains
 * the most property values. Maps the item to a region of the document rather
 * than a single property, avoiding false matches from ambiguous short values.
 */
function resolveObjectItem(
  obj: Record<string, unknown>,
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  // Collect searchable scalar values (strings ≥3 chars, numbers ≥4 digits)
  const needles: string[] = [];
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.length >= 3) needles.push(val);
    else if (typeof val === "number" && Math.abs(val) >= 1000) needles.push(String(val));
  }
  if (needles.length === 0) return null;

  // Split markdown into paragraphs and score each by needle hits
  const paragraphs = markdown.split(/\n{2,}/);
  let bestPara = "";
  let bestParaStart = 0;
  let bestHits = 0;
  let cursor = 0;

  for (const para of paragraphs) {
    const start = markdown.indexOf(para, cursor);
    const paraLower = para.toLowerCase();
    let hits = 0;
    for (const needle of needles) {
      if (paraLower.includes(needle.toLowerCase())) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestPara = para;
      bestParaStart = start >= 0 ? start : cursor;
    }
    cursor = (start >= 0 ? start : cursor) + para.length;
  }

  if (bestHits === 0) {
    // Fallback: resolve the longest string value directly
    const longest = needles.sort((a, b) => b.length - a.length)[0];
    return longest ? resolveScalar(longest, markdown, textMap) : null;
  }

  // Use the longest matched needle for bbox resolution
  let anchorNeedle: string | null = null;
  for (const needle of needles.sort((a, b) => b.length - a.length)) {
    if (bestPara.toLowerCase().includes(needle.toLowerCase())) {
      anchorNeedle = needle;
      break;
    }
  }

  const span: ProvenanceSpan = {
    offset: bestParaStart,
    length: bestPara.length,
    chunk: bestPara.slice(0, 80).trim(),
  };

  if (textMap && textMap.length > 0 && anchorNeedle) {
    const bboxHit = resolveBbox(anchorNeedle, anchorNeedle, textMap, markdown, bestParaStart);
    if (bboxHit) {
      span.page = bboxHit.page;
      span.bbox = bboxHit.bbox;
      if (bboxHit.words) span.words = bboxHit.words;
    }
  }

  if (!span.page) span.page = estimatePageFromOffset(markdown, bestParaStart);

  return span;
}

/**
 * Resolve provenance for an array value. Each item is resolved independently.
 * String/number items use the scalar resolver. Object items find the
 * paragraph containing the most of their property values.
 */
function resolveArray(
  items: unknown[],
  markdown: string,
  textMap?: TextMap,
): ProvenanceSpan | null {
  if (items.length === 0) return null;

  const resolved: ProvenanceSpan[] = [];

  for (const item of items) {
    if (item == null) continue;
    if (typeof item === "string" || typeof item === "number") {
      const span = resolveScalar(item, markdown, textMap);
      if (span) resolved.push(span);
    } else if (typeof item === "object" && !Array.isArray(item)) {
      const span = resolveObjectItem(item as Record<string, unknown>, markdown, textMap);
      if (span) resolved.push(span);
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
    items: resolved,
  };
}

export function resolveProvenance(
  extracted: Record<string, unknown>,
  markdown: string,
  textMap?: TextMap,
): ProvenanceMap {
  const provenance: ProvenanceMap = {};

  for (const [field, value] of Object.entries(extracted)) {
    if (value == null) {
      provenance[field] = null;
      continue;
    }

    if (Array.isArray(value)) {
      provenance[field] = resolveArray(value, markdown, textMap);
      continue;
    }

    provenance[field] = resolveScalar(value, markdown, textMap) ?? null;
  }

  return provenance;
}
