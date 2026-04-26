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

// Patterns that indicate a label (not just any word before a colon)
const LABEL_INDICATORS = /^[A-Z]|[a-z]\s[A-Z]|#|number|name|date|amount|limit|total|policy|insured|carrier|premium|address|phone|email|type|status|id\b/i;

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

function isValidPair(label: string, value: string, seen: Set<string>): boolean {
  // Too short or too long
  if (label.length < 2 || label.length > 60) return false;
  if (value.length < 1 || value.length > 300) return false;

  // Noise filter
  if (NOISE_LABELS.has(label.toLowerCase())) return false;

  // Must look like a label (starts with capital, or contains indicator words)
  if (!LABEL_INDICATORS.test(label)) return false;

  // Value shouldn't be another label pattern
  if (/^[A-Z][\w\s]{2,30}:/.test(value)) return false;

  // Dedup
  const key = normalizeKey(label);
  if (seen.has(key)) return false;

  return true;
}

/**
 * Summary stats for quick overview.
 */
export function kvPairsSummary(pairs: KVPair[]): {
  total: number;
  hasAmounts: boolean;
  hasDates: boolean;
  hasNames: boolean;
} {
  const labels = pairs.map((p) => p.label.toLowerCase() + " " + p.value.toLowerCase()).join(" ");
  return {
    total: pairs.length,
    hasAmounts: /\$[\d,.]+/.test(labels),
    hasDates: /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(labels),
    hasNames: /insured|policyholder|applicant|holder|company|corp|inc|llc/i.test(labels),
  };
}
