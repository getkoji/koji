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
  ];

  for (const c of candidates) {
    const result = findCaseInsensitive(haystack, c);
    if (result) return result;
  }

  return null;
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
// Bounding box resolver
// ---------------------------------------------------------------------------

/**
 * Search the text_map for a segment whose text contains the given needle.
 * Returns the best matching segment.
 */
function findBbox(needle: string, textMap: TextMap): { page: number; bbox: BBox } | null {
  if (!needle || textMap.length === 0) return null;

  const lowerNeedle = needle.toLowerCase();

  // First pass: exact substring match (case-insensitive)
  for (const seg of textMap) {
    if (seg.text.toLowerCase().includes(lowerNeedle)) {
      return { page: seg.page, bbox: seg.bbox };
    }
  }

  // Second pass: normalized whitespace match
  const normNeedle = normalizeWhitespace(needle).toLowerCase();
  if (normNeedle) {
    for (const seg of textMap) {
      if (normalizeWhitespace(seg.text).toLowerCase().includes(normNeedle)) {
        return { page: seg.page, bbox: seg.bbox };
      }
    }
  }

  return null;
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
): WordBox[] | null {
  const strValue = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (!strValue || textMap.length === 0) return null;

  // Try the matched chunk text first, then the raw value
  const candidates = chunk ? [chunk, strValue] : [strValue];

  for (const needle of candidates) {
    const needleWords = needle.trim().split(/\s+/).map((w) => w.toLowerCase());
    if (needleWords.length === 0) continue;

    // Slide through text_map looking for consecutive word matches
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
        return needleWords.map((_, j) => {
          const seg = textMap[i + j]!;
          return {
            text: seg.text,
            page: seg.page,
            x: seg.bbox.x,
            y: seg.bbox.y,
            w: seg.bbox.w,
            h: seg.bbox.h,
          };
        });
      }
    }

    // Single-word containment: value is contained within one text_map word
    if (needleWords.length === 1) {
      const lowerNeedle = needleWords[0]!;
      for (const seg of textMap) {
        if (seg.text.toLowerCase().replace(/[,.$()]/g, "").includes(lowerNeedle.replace(/[,.$()]/g, ""))) {
          return [{
            text: seg.text,
            page: seg.page,
            x: seg.bbox.x,
            y: seg.bbox.y,
            w: seg.bbox.w,
            h: seg.bbox.h,
          }];
        }
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
 */
function resolveBbox(
  value: unknown,
  chunk: string | undefined,
  textMap: TextMap,
): { page: number; bbox: BBox; words?: WordBox[] } | null {
  // Try per-word matching first
  const words = locateWords(value, chunk, textMap);
  if (words && words.length > 0) {
    const enclosing = enclosingBbox(words);
    if (enclosing) {
      return { ...enclosing, words };
    }
  }

  // Fall back to paragraph-level segment matching
  if (chunk) {
    const hit = findBbox(chunk, textMap);
    if (hit) return hit;
  }

  const strValue = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  if (strValue) {
    const hit = findBbox(strValue, textMap);
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

    let result: { offset: number; length: number } | null = null;

    if (typeof value === "string") {
      // Try exact → case-insensitive → normalized whitespace
      result =
        findExact(markdown, value) ??
        findCaseInsensitive(markdown, value) ??
        findNormalized(markdown, value);

      // If it looks like a date (YYYY-MM-DD), try date formats
      if (!result && /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
        result = findDate(markdown, value);
      }

      // If it looks like a dollar amount, try currency formats
      if (!result && /^\$?[\d,.]+$/.test(value)) {
        result = findDollarAmount(markdown, value);
      }
    } else if (typeof value === "number") {
      result = findNumber(markdown, value);
    }

    if (result) {
      const chunk = markdown.slice(result.offset, result.offset + result.length);
      const span: ProvenanceSpan = {
        offset: result.offset,
        length: result.length,
        chunk,
      };

      // Resolve bounding box + per-word locations if text_map available
      if (textMap && textMap.length > 0) {
        const bboxHit = resolveBbox(value, chunk, textMap);
        if (bboxHit) {
          span.page = bboxHit.page;
          span.bbox = bboxHit.bbox;
          if (bboxHit.words) {
            span.words = bboxHit.words;
          }
        }
      }

      provenance[field] = span;
    } else {
      provenance[field] = null;
    }
  }

  return provenance;
}
