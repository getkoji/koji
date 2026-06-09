/**
 * Reconciliation and confidence scoring — TypeScript port of the Python
 * pipeline's reconcile, compute_provenance_strength, compute_field_confidence,
 * and _snap_to_source functions.
 *
 * 100% deterministic — no LLM calls.
 */

import type { Chunk } from "./document-map";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  extracted: Record<string, unknown>;
  sources: Record<string, string>; // field → group that provided it
  confidence: Record<string, string>; // field → "high"/"medium"/"low"/"not_found"
  confidence_scores: Record<string, number>; // field → 0.0-1.0
}

export interface ConfidenceResult {
  confidence: Record<string, string>;
  confidence_scores: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Confidence scoring weights
// ---------------------------------------------------------------------------

const W_PROV = 0.70;
const W_VAL = 0.30;

// ---------------------------------------------------------------------------
// Provenance strength scoring (0.0 - 1.0)
// ---------------------------------------------------------------------------

/**
 * Compute how well an extracted value can be found in source text.
 *
 * Returns a continuous score:
 *   1.0  — exact substring match
 *   0.9  — case-insensitive match
 *   0.85 — normalized whitespace match
 *   0.8  — date/number format alternative found
 *   0.0  — not found
 *
 * For arrays, scores each item individually and averages.
 */
export function computeProvenanceStrength(
  value: unknown,
  chunks: Chunk[],
  fieldType: string = "string",
): number {
  if (value === null || value === undefined) return 0.0;

  // Arrays: average of item scores
  if (Array.isArray(value)) {
    if (value.length === 0) return 0.0;
    const itemScores = value.map((item) =>
      computeProvenanceStrength(item, chunks, "string"),
    );
    return itemScores.reduce((a, b) => a + b, 0) / itemScores.length;
  }

  const needle = String(value).trim();
  if (!needle) return 0.0;

  const source = chunks.map((c) => c.content).join("\n");
  if (!source) return 0.0;

  // 1. Exact substring
  if (source.includes(needle)) return 1.0;

  // 2. Case-insensitive
  if (source.toLowerCase().includes(needle.toLowerCase())) return 0.9;

  // 3. Normalized whitespace
  const normalizedNeedle = needle.split(/\s+/).join(" ").toLowerCase();
  const normalizedSource = source.split(/\s+/).join(" ").toLowerCase();
  if (normalizedSource.includes(normalizedNeedle)) return 0.85;

  // 4. Date format alternatives (YYYY-MM-DD → common input formats)
  if (typeof value === "string" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
    const parts = value.split("-");
    if (parts.length === 3) {
      const [y, m, d] = parts;
      const alternatives = [
        `${m}/${d}/${y}`,
        `${d}/${m}/${y}`,
        `${m}-${d}-${y}`,
        `${m}.${d}.${y}`,
      ];
      for (const alt of alternatives) {
        if (source.includes(alt)) return 0.8;
      }
    }
  }

  // 5. Number format alternatives (strip commas, try with $)
  if (
    typeof value === "number" ||
    typeof value === "string" && /^[\d,.]+$/.test(value)
  ) {
    const numericStr = String(value).replace(/,/g, "");
    const sourceStripped = source.replace(/,/g, "");
    if (sourceStripped.includes(numericStr)) return 0.8;
  }

  return 0.0;
}

// ---------------------------------------------------------------------------
// Field confidence scoring
// ---------------------------------------------------------------------------

/**
 * Compute confidence score from deterministic signals.
 *
 * score = 0.70 * provenance + 0.30 * validation
 *
 * llmConfidence parameter is retained for API compatibility but ignored.
 */
export function computeFieldConfidence(opts: {
  provenanceStrength: number;
  validationPassed: boolean;
  llmConfidence?: number | null;
}): number {
  const valBonus = opts.validationPassed ? 1.0 : 0.0;
  const score = W_PROV * opts.provenanceStrength + W_VAL * valBonus;
  return Math.max(0.0, Math.min(score, 1.0));
}

// ---------------------------------------------------------------------------
// Score label
// ---------------------------------------------------------------------------

/**
 * Convert a numeric confidence score to a string label.
 */
export function scoreLabel(score: number): string {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  if (score > 0) return "low";
  return "not_found";
}

// ---------------------------------------------------------------------------
// Field validation (inline — mirrors Python validate_field)
// ---------------------------------------------------------------------------

function validateField(
  _name: string,
  value: unknown,
  spec: Record<string, unknown>,
): { value: unknown; isValid: boolean; issue: string | null } {
  if (value === null || value === undefined) {
    if (spec.required) {
      return { value: null, isValid: false, issue: "required field is null" };
    }
    return { value: null, isValid: true, issue: null };
  }

  const fieldType = (spec.type as string) || "string";
  let result = value;
  let issue: string | null = null;

  if (fieldType === "date" && typeof value === "string") {
    const dateMatch = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dateMatch) {
      result = `${dateMatch[1]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
    } else {
      issue = `could not parse date: ${value}`;
    }
  } else if (fieldType === "number") {
    if (typeof value === "string") {
      const cleaned = value.replace(/\$/g, "").replace(/,/g, "").trim();
      const num = parseFloat(cleaned);
      if (isNaN(num)) {
        issue = `could not parse number: ${value}`;
      } else {
        result = num === Math.floor(num) ? Math.floor(num) : num;
      }
    }
  } else if (fieldType === "enum") {
    const options = (spec.options as string[]) || [];
    if (options.length > 0 && !options.includes(value as string)) {
      const valueLower = String(value).toLowerCase();
      let matched = false;
      for (const opt of options) {
        if (
          opt.toLowerCase() === valueLower ||
          opt.toLowerCase().includes(valueLower) ||
          valueLower.includes(opt.toLowerCase())
        ) {
          result = opt;
          matched = true;
          break;
        }
      }
      if (!matched) {
        issue = `value '${value}' not in allowed options`;
      }
    }
  }

  return { value: result, isValid: issue === null, issue };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Merge and reconcile results from multiple extraction groups.
 *
 * - Scalar fields: first non-null candidate wins
 * - Array fields: concatenate and deduplicate (by JSON.stringify for objects)
 * - Tracks which group provided each field
 */
export function reconcile(
  groupResults: Record<string, unknown>[],
  schemaDef: Record<string, unknown>,
): ReconcileResult {
  const fields = (schemaDef.fields || {}) as Record<
    string,
    Record<string, unknown>
  >;
  const merged: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const confidence: Record<string, string> = {};
  const confidenceScores: Record<string, number> = {};

  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    const fieldType = (fieldSpec.type as string) || "string";
    const candidates: { value: unknown; groupIndex: number }[] = [];

    for (let i = 0; i < groupResults.length; i++) {
      const result = groupResults[i]!;
      if (fieldName in result && result[fieldName] !== null && result[fieldName] !== undefined) {
        candidates.push({ value: result[fieldName], groupIndex: i });
      }
    }

    if (candidates.length === 0) {
      merged[fieldName] = null;
      sources[fieldName] = "none";
      confidence[fieldName] = "not_found";
      confidenceScores[fieldName] = 0.0;
      continue;
    }

    if (fieldType === "array") {
      // Concatenate and deduplicate
      const allItems: unknown[] = [];
      const seen = new Set<string>();
      let firstGroup: number | null = null;

      for (const { value, groupIndex } of candidates) {
        if (firstGroup === null) firstGroup = groupIndex;
        if (Array.isArray(value)) {
          for (const item of value) {
            const itemKey =
              typeof item === "object" && item !== null
                ? JSON.stringify(item, Object.keys(item as Record<string, unknown>).sort())
                : String(item);
            if (!seen.has(itemKey)) {
              seen.add(itemKey);
              allItems.push(item);
            }
          }
        }
      }

      merged[fieldName] = allItems;
      sources[fieldName] = `group_${firstGroup}`;

      // Confidence: no route chunks in standalone reconcile → prov = 0
      const prov = computeProvenanceStrength(allItems, [], fieldType);
      const score = computeFieldConfidence({
        provenanceStrength: prov,
        validationPassed: true, // arrays skip type validation
      });
      confidenceScores[fieldName] = score;
      confidence[fieldName] = scoreLabel(score);
    } else {
      // Scalar: first non-null wins
      const winner = candidates[0]!;
      const { value, isValid } = validateField(
        fieldName,
        winner.value,
        fieldSpec,
      );

      merged[fieldName] = value;
      sources[fieldName] = `group_${winner.groupIndex}`;

      // Confidence: no route chunks in standalone reconcile → prov = 0
      const prov = computeProvenanceStrength(value, [], fieldType);
      const score = computeFieldConfidence({
        provenanceStrength: prov,
        validationPassed: isValid,
      });
      confidenceScores[fieldName] = score;
      confidence[fieldName] = scoreLabel(score);
    }
  }

  return {
    extracted: merged,
    sources,
    confidence,
    confidence_scores: confidenceScores,
  };
}

// ---------------------------------------------------------------------------
// Snap-to-source (verbatim fields)
// ---------------------------------------------------------------------------

/**
 * Simple character-level similarity ratio (equivalent to Python's
 * difflib.SequenceMatcher.ratio). Uses the longest common subsequence
 * length approach: ratio = 2 * matches / (len(a) + len(b)).
 */
function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Longest common subsequence via DP
  const m = a.length;
  const n = b.length;

  // Use two rows instead of full matrix for memory efficiency
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
      } else {
        curr[j] = Math.max(prev[j]!, curr[j - 1]!);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  const lcsLen = prev[n]!;
  return (2 * lcsLen) / (m + n);
}

/**
 * Find the best matching substring in the source chunks for a value.
 *
 * Used for fields with `verbatim: true`. The LLM's extraction may
 * paraphrase or truncate; this snaps the output back to the actual
 * document text. Uses a sliding-window approach with similarity ratio.
 *
 * Returns the best matching substring if the similarity ratio exceeds
 * `minRatio`, otherwise returns the original value unchanged.
 */
export function snapToSource(
  value: string,
  chunks: Chunk[],
  minRatio: number = 0.5,
): string {
  if (!value || chunks.length === 0) return value;

  const sourceText = chunks.map((c) => c.content).join("\n");
  const valueLower = value.trim().toLowerCase();
  let bestMatch = value;
  let bestRatio = minRatio;

  // Slide a window roughly the size of the value across the source
  const words = sourceText.split(/\s+/);
  const valWordCount = value.split(/\s+/).length;
  const windowSizes = [
    valWordCount,
    valWordCount + 3,
    valWordCount + 6,
    valWordCount - 2,
  ];

  for (const windowSize of windowSizes) {
    if (windowSize < 2) continue;
    for (let i = 0; i <= words.length - windowSize; i++) {
      const candidate = words.slice(i, i + windowSize).join(" ");
      const ratio = similarityRatio(valueLower, candidate.toLowerCase());
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestMatch = candidate;
      }
    }
  }

  return bestMatch;
}
