/**
 * Key-value pair extractor — pulls structured label-value pairs from
 * parsed markdown without any LLM call.
 *
 * Patterns detected:
 *   - "Label: Value" (colon-separated, single line)
 *   - "Label:  Value" (multiple spaces after colon)
 *   - "| Label | Value |" (markdown table rows)
 *   - "**Label**: Value" (bold labels)
 *   - "Label\nValue" (label on one line, value on next — common in forms)
 *
 * Returns deduplicated, cleaned pairs sorted by position in document.
 * Zero LLM cost — pure pattern matching.
 */

export interface KVPair {
  label: string;
  value: string;
  /** Approximate character offset in the source markdown */
  position: number;
}

// Common noise labels to exclude
const NOISE_LABELS = new Set([
  "http", "https", "www", "page", "date", "time",
  "note", "notes", "see", "ref", "reference",
]);

/**
 * What makes a string on the left of a colon a *label* rather than prose.
 *
 * Purely structural: a leading capital, an internal capital (Title Case), or a
 * `#` marker. This used to carry a word list that included `policy`, `insured`,
 * `carrier`, and `premium` — so an insurance document's lowercase labels were
 * recognised and a shipping manifest's, a lab report's, or a lease's were not.
 * Every document type the engine has never heard of was quietly worse served
 * than the one industry someone had in mind.
 *
 * The structural signals below already catch the labels those words caught,
 * because a label in a real document is capitalised. Nothing here knows what
 * the document is about.
 */
const LABEL_INDICATORS = /^[A-Z]|[a-z]\s[A-Z]|#/;

/**
 * Extract all key-value pairs from parsed markdown.
 */
export function extractKVPairs(markdown: string): KVPair[] {
  const pairs: KVPair[] = [];
  const seen = new Set<string>();

  // Pattern 1: "Label: Value" (colon-separated)
  // Captures multi-word labels and multi-word values
  const colonPattern = /^([A-Z][\w\s/&.-]{1,50}):\s+(.{1,200})/gm;
  let match;
  while ((match = colonPattern.exec(markdown)) !== null) {
    const label = cleanLabel(match[1]!);
    const value = cleanValue(match[2]!);
    if (isValidPair(label, value, seen)) {
      pairs.push({ label, value, position: match.index });
      seen.add(normalizeKey(label));
    }
  }

  // Pattern 2: **Bold Label**: Value (markdown bold)
  const boldPattern = /\*\*([^*]{2,50})\*\*:\s*(.{1,200})/g;
  while ((match = boldPattern.exec(markdown)) !== null) {
    const label = cleanLabel(match[1]!);
    const value = cleanValue(match[2]!);
    if (isValidPair(label, value, seen)) {
      pairs.push({ label, value, position: match.index });
      seen.add(normalizeKey(label));
    }
  }

  // Pattern 3: Markdown table rows | Label | Value |
  const tablePattern = /\|\s*([^|]{2,50}?)\s*\|\s*([^|]{1,200}?)\s*\|/g;
  while ((match = tablePattern.exec(markdown)) !== null) {
    const label = cleanLabel(match[1]!);
    const value = cleanValue(match[2]!);
    // Skip table headers (all dashes or header-like content)
    if (/^-+$/.test(label) || /^-+$/.test(value)) continue;
    if (isValidPair(label, value, seen)) {
      pairs.push({ label, value, position: match.index });
      seen.add(normalizeKey(label));
    }
  }

  // Sort by position in document
  pairs.sort((a, b) => a.position - b.position);

  return pairs;
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/\*+/g, "")      // strip markdown bold/italic
    .replace(/^#+\s*/, "")    // strip heading markers
    .replace(/\s+/g, " ")     // normalize whitespace
    .trim();
}

function cleanValue(raw: string): string {
  return raw
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\|.*$/, "")     // stop at pipe (table boundaries)
    .trim();
}

function normalizeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A short label with a short value — the shape of a data cell rather than
 * prose. Used to keep lowercase labels that capitalisation alone would drop.
 */
function isDataShapedPair(label: string, value: string): boolean {
  const words = label.trim().split(/\s+/);
  if (words.length > 4) return false;
  if (!/^[\w][\w\s/&.#-]*$/.test(label)) return false;
  // Prose runs long and ends in a full stop; a data value does neither.
  return value.length <= 60 && !/[.!?]$/.test(value.trim());
}

function isValidPair(label: string, value: string, seen: Set<string>): boolean {
  // Too short or too long
  if (label.length < 2 || label.length > 60) return false;
  if (value.length < 1 || value.length > 300) return false;

  // Noise filter
  if (NOISE_LABELS.has(label.toLowerCase())) return false;

  // Must look like a label. Capitalisation is the primary signal; a lowercase
  // label still counts when the pair is short and data-shaped, which is what a
  // lowercased table cell looks like ("quantity | 42"). Before, a lowercase
  // label survived only if it contained one of a handful of insurance words,
  // so `policy number` was kept and `specimen id` was dropped.
  if (!LABEL_INDICATORS.test(label) && !isDataShapedPair(label, value)) return false;

  // Value shouldn't be another label pattern
  if (/^[A-Z][\w\s]{2,30}:/.test(value)) return false;

  // Dedup
  const key = normalizeKey(label);
  if (seen.has(key)) return false;

  return true;
}

/**
 * Summary stats for quick overview — what SHAPES of value the document
 * carries, not what it is about.
 *
 * `hasNames` used to test for `insured|policyholder|applicant|holder` and a few
 * company suffixes, which reported "no names" for a document full of patient,
 * tenant, or claimant names. It now looks for the shape of a proper noun: two
 * or more consecutive capitalised words in a value.
 */
export function kvPairsSummary(pairs: KVPair[]): {
  total: number;
  hasAmounts: boolean;
  hasDates: boolean;
  hasNames: boolean;
} {
  const blob = pairs.map((p) => p.label + " " + p.value).join(" ");
  return {
    total: pairs.length,
    // Any currency symbol before a number, not one locale's.
    hasAmounts: /[^\w\s]\s?\d[\d,.]*/.test(blob) || /\d[\d,]*\.\d{2}\b/.test(blob),
    hasDates:
      /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(blob) || /\b\d{4}-\d{2}-\d{2}\b/.test(blob),
    hasNames: pairs.some((p) => /\b[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*)+/.test(p.value)),
  };
}
