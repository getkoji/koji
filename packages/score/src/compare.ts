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
 *   - a `score` in [0,1] (partial credit: an array scores the F1 of its
 *     quality-weighted precision and recall over matched elements; an object
 *     scores the mean of its scored keys),
 *   - a `match` boolean (score === 1),
 *   - a `diff` describing what differs, for the UI to render.
 *
 * Elements are matched by a schema-declared `element_key` when present (else by
 * greedy best-overlap), and sub-fields the schema marks `informational` are
 * excluded from scoring. All of this is optional — passing no schema still
 * yields F1 scoring with greedy matching over every sub-field.
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

/** `key` is the element's `element_key` value (when the schema declares one and
 *  the element carries it) — a compact identity label so clients can report
 *  per-element false positives ("extra") and false negatives ("missing")
 *  without dumping whole formatted elements. */
export type ArrayElemDiff =
  | { status: "matched"; expected: string; key?: string }
  | { status: "changed"; expected: string; got: string; diff: ValueDiff; key?: string }
  | { status: "missing"; expected: string; key?: string }
  | { status: "extra"; got: string; key?: string };

export interface ArrayDiff {
  kind: "array";
  expectedCount: number;
  gotCount: number;
  matchedCount: number; // elements that matched fully or partially
  /** F1 of (precision, recall). Also the array's `score`. */
  score: number;
  /** Quality-weighted precision: matched sub-field credit / gotCount. */
  precision: number;
  /** Quality-weighted recall: matched sub-field credit / expectedCount. */
  recall: number;
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

/**
 * Parse a date-like scalar to `YYYY-MM-DD`, or null when it isn't a date.
 *
 * Deliberately format-driven rather than `new Date(s)`: the Date constructor
 * accepts far too much ("Ste 300" parses on some runtimes) and silently applies
 * a timezone shift to bare ISO strings, which moves the day. Only the shapes
 * this corpus actually uses are recognised, and each is assembled by hand.
 *
 * Two-digit years are read as 2000-2068 / 1969-1999, matching the POSIX pivot.
 * Ambiguous numeric dates are read month-first (US convention) — where a
 * schema needs day-first, that belongs in the declared `match:` policy (A2),
 * not in a global guess.
 */
function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 6) return null;

  const pad = (n: number) => String(n).padStart(2, "0");
  const expandYear = (y: number) => (y < 100 ? (y <= 68 ? 2000 + y : 1900 + y) : y);
  const build = (y: number, m: number, d: number): string | null => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const year = expandYear(y);
    // Reject impossible days (2026-02-31) by round-tripping through UTC.
    const probe = new Date(Date.UTC(year, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${year}-${pad(m)}-${pad(d)}`;
  };

  // ISO: 2026-03-26 (also tolerates 2026/03/26)
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return build(+m[1]!, +m[2]!, +m[3]!);

  // Numeric, month-first: 03/26/2026, 3-26-26, 26.03.2026 handled below
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const [, a, b, y] = m;
    const monthFirst = build(+y!, +a!, +b!);
    // Only fall back to day-first when month-first is impossible (26.03.2026).
    return monthFirst ?? build(+y!, +b!, +a!);
  }

  const MONTHS = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

  // Month name first: March 26, 2026 / Mar. 26 2026 / Mar 26th, 2026
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mo = monthIndex(m[1]!);
    return mo ? build(+m[3]!, mo, +m[2]!) : null;
  }

  // Day first: 26 March 2026 / 26th of March, 2026
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mo = monthIndex(m[2]!);
    return mo ? build(+m[3]!, mo, +m[1]!) : null;
  }

  return null;
}

// ── Declared equivalence policy ──

/**
 * How a field's values are compared. Declared per field as `match:` in the
 * schema, so "is 'Delaware' the same as 'State of Delaware'?" is a visible
 * decision an author makes and a customer can argue with, rather than a
 * behaviour buried in the scorer.
 *
 *   normalized  case, whitespace and punctuation differences forgiven, plus
 *               date and quantity equivalence. THE DEFAULT for every type.
 *   exact       byte-for-byte. Nothing is forgiven.
 *   contains    `normalized`, and additionally equal when one side contains
 *               the other. For values the document states with a wrapper the
 *               schema does not want: "Delaware" vs "State of Delaware".
 *   numeric     both sides must parse as quantities; compared within
 *               `tolerance` (default 0.01). A non-numeric value fails.
 *   date        both sides must parse as dates; compared as calendar days.
 *               A non-date value fails.
 *   enum        must resolve to the same member of the schema's `options` or
 *               `mappings`, case-insensitively.
 *
 * `normalized` is the default for EVERY type, not a per-type default. That
 * keeps this purely additive: declaring nothing scores exactly as it did
 * before this policy existed, so adopting it cannot silently move a number.
 * Tightening a field is an explicit act.
 */
export type MatchMode = "normalized" | "exact" | "contains" | "numeric" | "date" | "enum";

const MATCH_MODES: readonly MatchMode[] = [
  "normalized",
  "exact",
  "contains",
  "numeric",
  "date",
  "enum",
];

export interface MatchPolicy {
  mode: MatchMode;
  /** `numeric` only. Absolute tolerance; defaults to 0.01. */
  tolerance: number;
}

const DEFAULT_POLICY: MatchPolicy = { mode: "normalized", tolerance: 0.01 };

/**
 * Read a field's declared policy.
 *
 * An unrecognised mode throws rather than falling back. A typo in `match:`
 * would otherwise change how a field is scored while looking like it had been
 * configured, which is the exact class of silent disagreement this policy
 * exists to end.
 */
export function matchPolicy(spec?: CompareSpec): MatchPolicy {
  const declared = (spec as Record<string, unknown> | undefined)?.match;
  if (declared === undefined || declared === null) return DEFAULT_POLICY;

  const raw =
    typeof declared === "string"
      ? { mode: declared }
      : (declared as Record<string, unknown>);
  const mode = raw.mode;

  if (typeof mode !== "string" || !MATCH_MODES.includes(mode as MatchMode)) {
    throw new Error(
      `unknown match mode ${JSON.stringify(mode)} — expected one of ${MATCH_MODES.join(", ")}`,
    );
  }

  let tolerance = DEFAULT_POLICY.tolerance;
  if (raw.tolerance !== undefined) {
    const parsed = Number(raw.tolerance);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`match tolerance must be a non-negative number, got ${JSON.stringify(raw.tolerance)}`);
    }
    tolerance = parsed;
  }

  return { mode: mode as MatchMode, tolerance };
}

/** Collapse every run of non-alphanumerics to one space. */
function punct(s: string): string {
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

/** Parse a quantity, tolerating currency symbols and thousands separators. */
function toQuantity(s: string): number | null {
  if (!/^[$,\d.\s-]+$/.test(s)) return null;
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** The canonical members of a field's vocabulary, from `options` or `mappings`. */
function enumMembers(spec?: CompareSpec): string[] {
  const raw = spec as Record<string, unknown> | undefined;
  const options = raw?.options;
  if (Array.isArray(options)) return options.map((o) => String(o));
  const mappings = raw?.mappings;
  if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) {
    return Object.keys(mappings as Record<string, unknown>);
  }
  return [];
}

/**
 * Resolve a value to its canonical vocabulary member, or null.
 *
 * Checks the canonical names first, then the aliases a `mappings` entry lists,
 * so a schema that maps synonyms onto a canonical value scores them as equal.
 */
function toEnumMember(value: string, spec?: CompareSpec): string | null {
  const needle = punct(value.toLowerCase());
  for (const member of enumMembers(spec)) {
    if (punct(member.toLowerCase()) === needle) return member;
  }
  const mappings = (spec as Record<string, unknown> | undefined)?.mappings;
  if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) {
    for (const [canonical, aliases] of Object.entries(mappings as Record<string, unknown>)) {
      const list = Array.isArray(aliases) ? aliases : [aliases];
      for (const alias of list) {
        if (alias != null && punct(String(alias).toLowerCase()) === needle) return canonical;
      }
    }
  }
  return null;
}

/** Compare two scalars under a field's declared policy. */
function scalarMatch(expected: unknown, got: unknown, spec?: CompareSpec): boolean {
  const policy = matchPolicy(spec);

  if (policy.mode === "exact") {
    return String(expected) === String(got ?? "");
  }

  const e = String(expected).trim().toLowerCase();
  const a = String(got ?? "").trim().toLowerCase();

  if (policy.mode === "numeric") {
    const eq = toQuantity(e);
    const aq = toQuantity(a);
    if (eq === null || aq === null) return false;
    return Math.abs(eq - aq) <= policy.tolerance;
  }

  if (policy.mode === "date") {
    const ed = toIsoDate(e);
    const ad = toIsoDate(a);
    if (ed === null || ad === null) return false;
    return ed === ad;
  }

  if (policy.mode === "enum") {
    const em = toEnumMember(e, spec);
    const am = toEnumMember(a, spec);
    // With no declared vocabulary there is nothing to resolve against, so fall
    // through to a normalized comparison rather than failing every value.
    if (enumMembers(spec).length === 0) return normalizedMatch(expected, got, policy);
    return em !== null && em === am;
  }

  if (normalizedMatch(expected, got, policy)) return true;

  if (policy.mode === "contains") {
    const ep = punct(e);
    const ap = punct(a);
    if (ep.length > 0 && ap.length > 0 && (ep.includes(ap) || ap.includes(ep))) return true;
  }

  return false;
}

/** The default comparison: case, whitespace, punctuation, dates and quantities. */
function normalizedMatch(expected: unknown, got: unknown, policy: MatchPolicy): boolean {
  if (expected === got) return true;
  const e = String(expected).trim().toLowerCase();
  const a = String(got ?? "").trim().toLowerCase();
  if (e === a) return true;

  // Date comparison, before the numeric path — "03/26/2026" would otherwise be
  // read by parseFloat as 3 and compared as a quantity. Both sides must parse
  // as dates for this to decide; a one-sided parse falls through so a date
  // against a non-date is scored by the checks below.
  const eDate = toIsoDate(e);
  if (eDate !== null) {
    const aDate = toIsoDate(a);
    if (aDate !== null) return eDate === aDate;
  }

  // Numeric comparison with currency/thousands stripping and small tolerance.
  // Confirm-only: a genuine quantity match returns true; a numeric mismatch
  // falls through to the punctuation check below (so "704-376-9896" vs
  // "704.376.9896", which parseFloat reads as 704 vs 704.376, isn't rejected
  // here as a number when it's really a formatting-only phone difference).
  const eNum = toQuantity(e);
  const aNum = toQuantity(a);
  if (eNum !== null && aNum !== null && Math.abs(eNum - aNum) <= policy.tolerance) {
    return true;
  }

  // Punctuation-insensitive comparison: collapse every run of non-alphanumeric
  // characters to a single space so a formatting-only difference is not scored
  // as a mismatch — e.g. "CHARLOTTE, NC" vs "CHARLOTTE NC", "704-376-9896" vs
  // "704.376.9896". This forgives punctuation/whitespace ONLY: because the
  // alphanumerics must still be identical in the same order, it never masks a
  // content difference (a missing "Ste 300", a different PO box number, or a
  // dropped "Company" all still fail).
  const ep = punct(e);
  if (ep.length > 0 && ep === punct(a)) return true;

  return false;
}

// ── Core comparison ──

/** The schema node describing a value being compared. `undefined` when the
 *  caller has no schema (scoring still works — just without key-matching or
 *  informational sub-fields). */
export type CompareSpec = Record<string, unknown> | undefined;

/** Declared sub-field schemas of an object/array-item, in either vocabulary. */
function subFieldSpecs(spec: CompareSpec): Record<string, Record<string, unknown>> | undefined {
  const props = (spec?.properties ?? spec?.fields) as Record<string, Record<string, unknown>> | undefined;
  return props && typeof props === "object" ? props : undefined;
}

/** A sub-field the schema marks as informational is not scored (cosmetic
 *  wording, raw passthroughs) — it neither helps nor hurts an element's score. */
function isInformational(subSpec: Record<string, unknown> | undefined): boolean {
  const hints = subSpec?.hints as Record<string, unknown> | undefined;
  return hints?.informational === true;
}

export function compareValues(expected: unknown, got: unknown, spec?: CompareSpec): CompareResult {
  // Both empty → full match (a field with no expected array is not a failure).
  if (isNullish(expected) && isNullish(got)) {
    return { score: 1, match: true, diff: { kind: "scalar", expected: "—", got: "—", match: true } };
  }

  if (Array.isArray(expected) && Array.isArray(got)) {
    return compareArrays(expected, got, spec);
  }

  if (isPlainObject(expected) && isPlainObject(got)) {
    return compareObjects(expected, got, spec);
  }

  // Scalar path (and type-mismatch fallback, e.g. expected array but got null).
  const match = scalarMatch(expected, got, spec);
  return {
    score: match ? 1 : 0,
    match,
    diff: { kind: "scalar", expected: formatValue(expected), got: formatValue(got), match },
  };
}

function compareObjects(
  expected: Record<string, unknown>,
  got: Record<string, unknown>,
  spec?: CompareSpec,
): CompareResult {
  const specs = subFieldSpecs(spec);
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
    // Skip sub-fields the schema marks informational — cosmetic wording that
    // shouldn't drag an element's accuracy down.
    if (isInformational(specs?.[key])) continue;
    // Skip keys absent (or empty) on both sides — they carry no signal.
    if (isNullish(expected[key]) && isNullish(got[key])) continue;
    const sub = compareValues(expected[key], got[key], specs?.[key]);
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

/** The value of an element's match key (the sub-field named by `element_key`). */
function keyOf(item: unknown, key: string): unknown {
  if (!isPlainObject(item)) return undefined;
  return item[key];
}

function compareArrays(expected: unknown[], got: unknown[], spec?: CompareSpec): CompareResult {
  if (expected.length === 0 && got.length === 0) {
    return {
      score: 1,
      match: true,
      diff: { kind: "array", expectedCount: 0, gotCount: 0, matchedCount: 0, precision: 1, recall: 1, score: 1, elements: [] },
    };
  }

  const elementSpec = spec?.items as CompareSpec;
  const elementKey = (spec?.hints as Record<string, unknown> | undefined)?.element_key as string | undefined;

  // Assign each expected element to at most one got element.
  const gotUsed = new Array(got.length).fill(false);
  const paired = new Map<number, { j: number; result: CompareResult }>();

  const useKey =
    !!elementKey &&
    expected.length > 0 &&
    got.length > 0 &&
    isPlainObject(expected[0]) &&
    isPlainObject(got[0]);

  if (useKey) {
    // Match elements by a stable identity key (e.g. coverage_code / role /
    // loc_number). An element is a match iff both sides carry the same key —
    // so a wrong sub-field can't mispair it, and finding/missing whole elements
    // is measured honestly by recall/precision rather than fuzzy overlap.
    for (let i = 0; i < expected.length; i++) {
      const ek = keyOf(expected[i], elementKey!);
      if (isNullish(ek)) continue;
      for (let j = 0; j < got.length; j++) {
        if (gotUsed[j]) continue;
        const gk = keyOf(got[j], elementKey!);
        if (!isNullish(gk) && scalarMatch(ek, gk)) {
          gotUsed[j] = true;
          paired.set(i, { j, result: compareValues(expected[i], got[j], elementSpec) });
          break;
        }
      }
    }
  } else {
    // No key (or scalar elements): greedy best-overlap pairing, order-insensitive.
    const pairs: Array<{ i: number; j: number; score: number; result: CompareResult }> = [];
    for (let i = 0; i < expected.length; i++) {
      for (let j = 0; j < got.length; j++) {
        const result = compareValues(expected[i], got[j], elementSpec);
        if (result.score > 0) pairs.push({ i, j, score: result.score, result });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const expUsed = new Array(expected.length).fill(false);
    for (const p of pairs) {
      if (expUsed[p.i] || gotUsed[p.j]) continue;
      expUsed[p.i] = true;
      gotUsed[p.j] = true;
      paired.set(p.i, { j: p.j, result: p.result });
    }
  }

  // The element's identity label for per-element FP/FN reporting.
  const keyFor = (item: unknown): { key?: string } => {
    if (!elementKey) return {};
    const k = keyOf(item, elementKey);
    return isNullish(k) ? {} : { key: formatValue(k) };
  };

  // Sub-field credit summed over matched pairs (each in (0,1]). This weights
  // precision/recall by how good each matched element is, not just the count.
  let creditSum = 0;
  let matchedCount = 0;
  const elements: ArrayElemDiff[] = [];
  for (let i = 0; i < expected.length; i++) {
    const pair = paired.get(i);
    if (!pair) {
      elements.push({ status: "missing", expected: formatValue(expected[i]), ...keyFor(expected[i]) });
      continue;
    }
    creditSum += pair.result.score;
    matchedCount += 1;
    if (pair.result.match) {
      elements.push({ status: "matched", expected: formatValue(expected[i]), ...keyFor(expected[i]) });
    } else {
      elements.push({
        status: "changed",
        expected: formatValue(expected[i]),
        got: formatValue(got[pair.j]),
        diff: pair.result.diff,
        ...keyFor(expected[i]),
      });
    }
  }
  for (let j = 0; j < got.length; j++) {
    if (!gotUsed[j]) elements.push({ status: "extra", got: formatValue(got[j]), ...keyFor(got[j]) });
  }

  // F1 of quality-weighted precision and recall. Precision falls only on
  // spurious/wrong extras; recall falls only on misses — so finding a real
  // extra element no longer double-penalizes the way a max()-denominator did,
  // and precision/recall are reported separately for diagnosis.
  const precision = got.length > 0 ? creditSum / got.length : expected.length === 0 ? 1 : 0;
  const recall = expected.length > 0 ? creditSum / expected.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    score: f1,
    match: f1 >= 1 - EPS,
    diff: {
      kind: "array",
      expectedCount: expected.length,
      gotCount: got.length,
      matchedCount,
      precision,
      recall,
      score: f1,
      elements,
    },
  };
}
