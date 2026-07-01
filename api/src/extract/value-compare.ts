/**
 * Structural value comparison for validation.
 *
 * The Validate feature compares extracted field values against ground truth.
 * Field values are no longer just scalars — schemas support arrays and nested
 * objects — so a flat `String(value)` comparison both mis-scores (every object
 * stringifies to "[object Object]", so equal-length arrays always "match") and
 * mis-displays (the UI shows "[object Object]" instead of the value).
 *
 * `compareValues` walks the value structurally and returns:
 *   - a `score` in [0,1] (partial credit: an array scores the fraction of its
 *     elements that matched; an object scores the mean of its keys),
 *   - a `match` boolean (score === 1),
 *   - a `diff` describing what differs, for the UI to render.
 *
 * This is fully generic — no field names, document types, or domain knowledge.
 */

const EPS = 1e-9;

// ── Diff shapes (mirrored in the dashboard) ──

export interface ScalarDiff {
  kind: "scalar";
  expected: string;
  got: string;
  match: boolean;
}

export type ArrayElemDiff =
  | { status: "matched"; expected: string }
  | { status: "changed"; expected: string; got: string; diff: ValueDiff }
  | { status: "missing"; expected: string }
  | { status: "extra"; got: string };

export interface ArrayDiff {
  kind: "array";
  expectedCount: number;
  gotCount: number;
  matchedCount: number; // elements that matched fully or partially
  score: number;
  elements: ArrayElemDiff[];
}

export interface ObjectFieldDiff {
  key: string;
  expected: string;
  got: string;
  diff: ValueDiff;
}

export interface ObjectDiff {
  kind: "object";
  score: number;
  fields: ObjectFieldDiff[]; // mismatched keys only
}

export type ValueDiff = ScalarDiff | ArrayDiff | ObjectDiff;

export interface CompareResult {
  score: number;
  match: boolean;
  diff: ValueDiff;
}

// ── Helpers ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNullish(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * Compact, human-readable rendering of a value for diff display.
 * Objects → `{ key: val, key2: val2 }`, arrays → `[a, b, …+n]`, depth-limited.
 */
export function formatValue(v: unknown, depth = 0): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (depth > 1) return `[${v.length} items]`;
    const parts = v.slice(0, 3).map((x) => formatValue(x, depth + 1));
    if (v.length > 3) parts.push(`…+${v.length - 3}`);
    return `[${parts.join(", ")}]`;
  }
  if (isPlainObject(v)) {
    if (depth > 1) return "{…}";
    const keys = Object.keys(v);
    const parts = keys.slice(0, 4).map((k) => `${k}: ${formatValue(v[k], depth + 1)}`);
    if (keys.length > 4) parts.push("…");
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return String(v);
}

/** Normalize a scalar for tolerant equality (trim, case-fold, number/currency, date). */
function scalarMatch(expected: unknown, got: unknown): boolean {
  if (expected === got) return true;
  const e = String(expected).trim().toLowerCase();
  const a = String(got ?? "").trim().toLowerCase();
  if (e === a) return true;

  // Numeric comparison with currency/thousands stripping and small tolerance.
  const eNum = parseFloat(e.replace(/[$,]/g, ""));
  const aNum = parseFloat(a.replace(/[$,]/g, ""));
  if (!Number.isNaN(eNum) && !Number.isNaN(aNum)) {
    // Only treat as numeric match when the whole string is numeric-ish,
    // otherwise "3 cats" would equal "3 dogs".
    if (/^[$,\d.\s-]+$/.test(e) && /^[$,\d.\s-]+$/.test(a)) {
      return Math.abs(eNum - aNum) < 0.01;
    }
  }
  return false;
}

// ── Core comparison ──

export function compareValues(expected: unknown, got: unknown): CompareResult {
  // Both empty → full match (a field with no expected array is not a failure).
  if (isNullish(expected) && isNullish(got)) {
    return { score: 1, match: true, diff: { kind: "scalar", expected: "—", got: "—", match: true } };
  }

  if (Array.isArray(expected) && Array.isArray(got)) {
    return compareArrays(expected, got);
  }

  if (isPlainObject(expected) && isPlainObject(got)) {
    return compareObjects(expected, got);
  }

  // Scalar path (and type-mismatch fallback, e.g. expected array but got null).
  const match = scalarMatch(expected, got);
  return {
    score: match ? 1 : 0,
    match,
    diff: { kind: "scalar", expected: formatValue(expected), got: formatValue(got), match },
  };
}

function compareObjects(
  expected: Record<string, unknown>,
  got: Record<string, unknown>,
): CompareResult {
  const keys = new Set([...Object.keys(expected), ...Object.keys(got)]);
  const fields: ObjectFieldDiff[] = [];
  let sum = 0;
  let n = 0;
  for (const key of keys) {
    // Skip `__`-prefixed provenance metadata (`__source_text`,
    // `__source_context`). The model emits these inline on extracted objects;
    // ground truth never carries them, so scoring them as unexpected keys
    // silently caps every array item and nested object below its true accuracy.
    // They belong on the separate provenance channel, not the scored value.
    if (key.startsWith("__")) continue;
    // Skip keys absent (or empty) on both sides — they carry no signal.
    if (isNullish(expected[key]) && isNullish(got[key])) continue;
    const sub = compareValues(expected[key], got[key]);
    sum += sub.score;
    n += 1;
    if (!sub.match) {
      fields.push({
        key,
        expected: formatValue(expected[key]),
        got: formatValue(got[key]),
        diff: sub.diff,
      });
    }
  }
  const score = n > 0 ? sum / n : 1;
  return { score, match: score >= 1 - EPS, diff: { kind: "object", score, fields } };
}

function compareArrays(expected: unknown[], got: unknown[]): CompareResult {
  if (expected.length === 0 && got.length === 0) {
    return {
      score: 1,
      match: true,
      diff: { kind: "array", expectedCount: 0, gotCount: 0, matchedCount: 0, score: 1, elements: [] },
    };
  }

  // Order-insensitive pairing: score every (expected, got) pair, then greedily
  // assign the highest-scoring pairs first so reordering doesn't cause false
  // failures. O(n*m) — array fields are small.
  const pairs: Array<{ i: number; j: number; score: number; result: CompareResult }> = [];
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < got.length; j++) {
      const result = compareValues(expected[i], got[j]);
      if (result.score > 0) pairs.push({ i, j, score: result.score, result });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const expUsed = new Array(expected.length).fill(false);
  const gotUsed = new Array(got.length).fill(false);
  const paired = new Map<number, { j: number; result: CompareResult }>();
  let scoreSum = 0;
  for (const p of pairs) {
    if (expUsed[p.i] || gotUsed[p.j]) continue;
    expUsed[p.i] = true;
    gotUsed[p.j] = true;
    paired.set(p.i, { j: p.j, result: p.result });
    scoreSum += p.score;
  }

  // Build the element-level diff in expected order, then trailing extras.
  const elements: ArrayElemDiff[] = [];
  let matchedCount = 0;
  for (let i = 0; i < expected.length; i++) {
    const pair = paired.get(i);
    if (!pair) {
      elements.push({ status: "missing", expected: formatValue(expected[i]) });
    } else if (pair.result.match) {
      matchedCount += 1;
      elements.push({ status: "matched", expected: formatValue(expected[i]) });
    } else {
      matchedCount += 1; // partial — counts toward "matched" headline
      elements.push({
        status: "changed",
        expected: formatValue(expected[i]),
        got: formatValue(got[pair.j]),
        diff: pair.result.diff,
      });
    }
  }
  for (let j = 0; j < got.length; j++) {
    if (!gotUsed[j]) elements.push({ status: "extra", got: formatValue(got[j]) });
  }

  // Denominator penalizes both missing and extra elements.
  const denom = Math.max(expected.length, got.length);
  const score = denom > 0 ? scoreSum / denom : 1;
  return {
    score,
    match: score >= 1 - EPS,
    diff: {
      kind: "array",
      expectedCount: expected.length,
      gotCount: got.length,
      matchedCount,
      score,
      elements,
    },
  };
}
