/**
 * Per-field deterministic confidence scoring.
 *
 * Replaces the LLM's self-assessed `__confidence` (which is conservatively
 * calibrated noise — unambiguous enum picks routinely come back at ~0.7 and
 * trip the default 0.85 review threshold for no reason) with a deterministic
 * post-extraction score derived from the field's schema and the extracted
 * value itself.
 *
 * Scoring rules (per the per-type matrix):
 *
 *   - enum:    1.0 if value is one of the enum set; 0.0 otherwise.
 *              Enum sets are sourced from `options` (array) or `mappings`
 *              (object whose top-level keys are the canonical values).
 *              Matching is case-sensitive — schemas declare the canonical
 *              spelling and the validator (`validateField` upstream) snaps
 *              casing variants to canonical before we score. If a value
 *              reaches us with the "wrong" case it is treated as wrong.
 *
 *   - integer: 1.0 if value parses to an integer AND (range constraint if
 *              declared) within range; 0.5 if parses without a range
 *              constraint; 0.0 if it doesn't parse to an integer.
 *
 *   - number:  1.0 if value parses to a finite number AND (range constraint
 *              if declared) within range; 0.5 if parses without a range
 *              constraint; 0.0 if it doesn't parse.
 *
 *   - date:    1.0 if value parses as a date in the schema's expected format
 *              (defaults to YYYY-MM-DD); 0.5 if it parses to a valid date
 *              but in the wrong format; 0.0 if it doesn't parse to a date.
 *
 *   - boolean: 1.0 if value is exactly `true` or `false`; 0.0 otherwise
 *              (no string coercion at this stage — validate_field upstream
 *              has already snapped strings to bools when possible).
 *
 *   - string with `pattern` (regex): 1.0 if value matches; 0.0 if not.
 *
 *   - string without pattern: 1.0 if non-empty AND `sourceProvenance` reports
 *              the value was located in the document; 0.7 if non-empty but
 *              provenance did not find it (the LLM may have legitimately
 *              extracted a value reformatted/normalized from the source —
 *              this is the only place we soft-score without a provenance hit
 *              so we don't false-flag every paraphrased extraction); 0.0
 *              if empty.
 *
 *   - null (value is null or undefined): 1.0 if the schema allows null
 *              (i.e. `required` is not truthy) AND provenance reports no
 *              match (i.e. the field is genuinely absent from source);
 *              0.0 if the schema marks the field required.
 *
 *   - unknown type / fallback: treated as `string without pattern`.
 *
 * Doc-level confidence is intended to be `min(per-field scores)` (strict),
 * computed at the caller — this module emits per-field scores only.
 */

import type { ProvenanceSpan } from "./provenance";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal field-schema shape we read.
 *
 * Fields use the YAML schema vocabulary defined under `schemas/examples/` —
 * `type`, `required`, `options`, `mappings`, `pattern`, `min`/`max`,
 * `format`. Unknown properties are ignored.
 */
export interface FieldSchema {
  type?: string;
  required?: boolean;
  options?: unknown[];
  mappings?: Record<string, unknown[]>;
  pattern?: string;
  /** Numeric range — inclusive on both ends. */
  min?: number;
  max?: number;
  /**
   * Expected date format. Defaults to "YYYY-MM-DD". Other recognized values
   * are documented inline in `parseDateInFormat`.
   */
  format?: string;
  [key: string]: unknown;
}

/**
 * Deterministic confidence score in [0.0, 1.0] for a single field.
 *
 * @param value The extracted value (post-normalization / post-validate_field).
 * @param fieldSchema The schema entry for the field (type + constraints).
 * @param sourceProvenance Optional provenance span for this field —
 *        when present and `.offset >= 0` we treat it as a confirmed source
 *        hit. Used for free-text strings and the null-allowed branch.
 */
export function computeFieldConfidence(
  value: unknown,
  fieldSchema: FieldSchema | undefined,
  sourceProvenance?: ProvenanceSpan | null,
): number {
  const schema = fieldSchema ?? {};
  const type = (schema.type as string | undefined) ?? "string";
  const required = Boolean(schema.required);

  // Null / absent value branch — applies to every type.
  if (value === null || value === undefined) {
    if (required) return 0.0;
    // For optional null fields, we want provenance to confirm "actually not
    // in the source" — but lack of provenance is itself a no-match signal.
    // If no provenance map was passed, we still credit a null because the
    // schema explicitly allows it.
    if (sourceProvenance == null) return 1.0;
    // Provenance span exists — null means we couldn't locate anything.
    return 1.0;
  }

  switch (type) {
    case "enum":
      return scoreEnum(value, schema);
    case "mapping":
      // `mapping` uses the same canonical-keys structure as enum; the
      // canonical key set is the valid value set.
      return scoreMapping(value, schema);
    case "integer":
      return scoreInteger(value, schema);
    case "number":
      return scoreNumber(value, schema);
    case "date":
      return scoreDate(value, schema);
    case "boolean":
      return scoreBoolean(value);
    case "string":
      return scoreString(value, schema, sourceProvenance);
    case "array":
      return scoreArray(value, schema, sourceProvenance);
    case "object":
      return scoreObject(value, schema, sourceProvenance);
    default:
      // Unknown type — degrade to free-text string scoring so we don't
      // accidentally flag every field of an unrecognized type.
      return scoreString(value, schema, sourceProvenance);
  }
}

// ---------------------------------------------------------------------------
// Array / object scorers
// ---------------------------------------------------------------------------

/** Round to 3 decimals so scores compare cleanly against thresholds. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The declared sub-field schemas of an object/array-item (either vocabulary). */
function itemProperties(schema: FieldSchema): Record<string, FieldSchema> | undefined {
  const props = (schema.properties ?? schema.fields) as Record<string, FieldSchema> | undefined;
  return props && typeof props === "object" ? props : undefined;
}

/**
 * Confidence for an ARRAY field — the mean of its elements' confidences, each
 * scored recursively from the per-element provenance the resolver already
 * produced (`span.items[i]`). Without this an array falls through to the string
 * scorer and returns 0.0, so every array field trips review regardless of
 * correctness. An empty array is a not-found: 0.0 if required, else 1.0.
 */
function scoreArray(
  value: unknown,
  schema: FieldSchema,
  sourceProvenance?: ProvenanceSpan | null,
): number {
  if (!Array.isArray(value)) return 0.0;
  if (value.length === 0) return schema.required ? 0.0 : 1.0;

  const itemSchema = (schema.items as FieldSchema | undefined) ?? {};
  const itemProvs = sourceProvenance?.items ?? [];
  // Route object items to the object scorer even when `items` omits an explicit
  // `type: object` (a declared `properties`/`fields` shape is enough), so a
  // structured element isn't misrouted to the string scorer and zeroed.
  const objectItems = itemProperties(itemSchema) !== undefined;

  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const itemProv = itemProvs[i] ?? null;
    sum +=
      objectItems && item != null && typeof item === "object" && !Array.isArray(item)
        ? scoreObject(item, itemSchema, itemProv)
        : computeFieldConfidence(item, itemSchema, itemProv);
  }
  return round3(sum / value.length);
}

/**
 * Confidence for an OBJECT field / array-of-objects element — the mean of its
 * declared sub-fields' confidences, each scored recursively from the
 * per-property provenance (`span.properties[name]`). Sub-fields that are absent
 * on the value and not required carry no signal and are skipped (mirroring the
 * scorer's empty-on-both rule). Falls back to a provenance-based free-text score
 * when the schema declares no sub-fields.
 */
function scoreObject(
  value: unknown,
  schema: FieldSchema,
  sourceProvenance?: ProvenanceSpan | null,
): number {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return 0.0;

  const props = itemProperties(schema);
  if (!props) {
    // No declared shape — credit a located object, soft-score otherwise.
    return provenanceHit(sourceProvenance) ? 1.0 : 0.7;
  }

  const obj = value as Record<string, unknown>;
  const propProvs = sourceProvenance?.properties ?? {};

  let sum = 0;
  let n = 0;
  for (const [name, propSchema] of Object.entries(props)) {
    const pv = obj[name];
    if ((pv === null || pv === undefined) && !propSchema.required) continue;
    sum += computeFieldConfidence(pv, propSchema, propProvs[name] ?? null);
    n += 1;
  }
  return n > 0 ? round3(sum / n) : 1.0;
}

// ---------------------------------------------------------------------------
// Per-type scorers
// ---------------------------------------------------------------------------

function scoreEnum(value: unknown, schema: FieldSchema): number {
  const options = Array.isArray(schema.options) ? schema.options : null;
  if (options && options.length > 0) {
    // Case-sensitive: validate_field upstream has already snapped variants
    // to canonical, so a non-canonical value at this point is a real miss.
    return options.includes(value) ? 1.0 : 0.0;
  }
  // No options declared on an enum — fall through to "mapping" semantics
  // since some schemas use `mappings` alone for enum-shaped fields.
  if (schema.mappings && typeof schema.mappings === "object") {
    return scoreMapping(value, schema);
  }
  // Enum with no declared values: treat any non-null value as 1.0; there's
  // no constraint to violate.
  return 1.0;
}

function scoreMapping(value: unknown, schema: FieldSchema): number {
  const mappings = schema.mappings;
  if (!mappings || typeof mappings !== "object") {
    // Mapping with no declared keys: any non-null value passes.
    return 1.0;
  }
  const canonical = Object.keys(mappings);
  if (canonical.length === 0) return 1.0;
  return canonical.includes(String(value)) ? 1.0 : 0.0;
}

function scoreInteger(value: unknown, schema: FieldSchema): number {
  const parsed = parseNumeric(value);
  if (parsed === null) return 0.0;
  if (!Number.isInteger(parsed)) return 0.0;
  return applyRange(parsed, schema);
}

function scoreNumber(value: unknown, schema: FieldSchema): number {
  const parsed = parseNumeric(value);
  if (parsed === null) return 0.0;
  return applyRange(parsed, schema);
}

/**
 * Parse a value to a finite number. Accepts numbers as-is and strings that
 * parse cleanly after stripping currency formatting (`$`, `,`). Returns
 * null when parsing fails or the result is not finite.
 */
function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  // Booleans, objects, arrays — not numeric values for our purposes.
  return null;
}

function applyRange(n: number, schema: FieldSchema): number {
  const hasMin = typeof schema.min === "number";
  const hasMax = typeof schema.max === "number";
  if (!hasMin && !hasMax) {
    // Parses cleanly but no range constraint declared: 0.5 per the rules
    // (we know it's numeric but we have no way to validate it's in-domain).
    return 0.5;
  }
  if (hasMin && n < (schema.min as number)) return 0.0;
  if (hasMax && n > (schema.max as number)) return 0.0;
  return 1.0;
}

function scoreDate(value: unknown, schema: FieldSchema): number {
  if (typeof value !== "string") return 0.0;
  const trimmed = value.trim();
  if (!trimmed) return 0.0;

  const expectedFormat = (schema.format as string | undefined) ?? "YYYY-MM-DD";

  if (parseDateInFormat(trimmed, expectedFormat)) return 1.0;
  // Right date, wrong format — still a valid date, just not what the schema
  // asked for. The validator likely normalized to the canonical form but
  // we score conservatively in case it didn't.
  if (parseAnyDate(trimmed)) return 0.5;
  return 0.0;
}

/**
 * Strict YYYY-MM-DD parser used as the default expected format.
 * Other formats can be added here as schemas opt into them — currently
 * only YYYY-MM-DD is recognized.
 */
function parseDateInFormat(value: string, format: string): boolean {
  if (format === "YYYY-MM-DD" || format === "yyyy-MM-dd") {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return isRealDate(y, mo, d);
  }
  // Unknown format string — fall back to the lenient parser. A format
  // mismatch downgrades to 0.5 via the caller, so we never overshoot.
  return false;
}

/**
 * Lenient date parser: accepts YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY,
 * Month DD, YYYY, and similar common shapes. Used to credit "right date,
 * wrong format" at 0.5.
 */
function parseAnyDate(value: string): boolean {
  // ISO-like
  let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
  // Slash/dash US-or-EU (ambiguous, accept both interpretations)
  m = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const yRaw = Number(m[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    return isRealDate(y, a, b) || isRealDate(y, b, a);
  }
  // Month DD, YYYY  /  DD Month YYYY
  const monthNames = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  m = value.match(new RegExp(`^${monthNames}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i"));
  if (m) return true;
  m = value.match(new RegExp(`^(\\d{1,2})\\s+${monthNames}\\s+(\\d{4})$`, "i"));
  if (m) return true;
  return false;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Use UTC to dodge DST oddities.
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function scoreBoolean(value: unknown): number {
  // Strictly true or false — no truthy/falsy coercion. The upstream
  // validate_field already canonicalizes "yes"/"no" / "Y"/"N" to booleans
  // when the schema marks the field as a boolean, so a non-boolean here
  // means the canonicalization failed and the value is suspect.
  return value === true || value === false ? 1.0 : 0.0;
}

function scoreString(
  value: unknown,
  schema: FieldSchema,
  sourceProvenance?: ProvenanceSpan | null,
): number {
  // Reject non-strings outright (numbers/booleans aren't free-text strings).
  if (typeof value !== "string") {
    // Numbers and booleans can sometimes be coerced to a meaningful string —
    // we accept them only when there's no pattern constraint to violate.
    if (typeof value === "number" || typeof value === "boolean") {
      const s = String(value);
      if (s.length === 0) return 0.0;
      if (schema.pattern) return matchesPattern(s, schema.pattern) ? 1.0 : 0.0;
      return provenanceHit(sourceProvenance) ? 1.0 : 0.7;
    }
    return 0.0;
  }
  if (value.length === 0) return 0.0;

  if (schema.pattern) {
    return matchesPattern(value, schema.pattern) ? 1.0 : 0.0;
  }
  return provenanceHit(sourceProvenance) ? 1.0 : 0.7;
}

function matchesPattern(value: string, pattern: string): boolean {
  try {
    const re = new RegExp(pattern);
    return re.test(value);
  } catch {
    // Malformed pattern in the schema — don't penalize the value for it.
    // The schema author needs to fix their regex; flagging every extraction
    // as low-confidence isn't the right signal.
    return true;
  }
}

function provenanceHit(span: ProvenanceSpan | null | undefined): boolean {
  // A "hit" means the resolver located the value somewhere in the source —
  // either a real markdown offset (LLM path) or a coordinate-based chunk
  // (form-extract uses `offset: -1` because there's no markdown to index).
  if (!span) return false;
  if (span.offset >= 0) return true;
  return Boolean(span.chunk && span.chunk.length > 0);
}

// ---------------------------------------------------------------------------
// Helpers for callers (process.ts uses these)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-field confidence map used for review routing.
 *
 * The extract engine already computes a per-field confidence for every
 * extracted value (`confidence_scores` on the extraction result — provenance
 * strength + validation, see extract/reconcile.ts). Those scores are what
 * the build page shows and what other write paths persist, so review routing
 * must flag off the SAME numbers — recomputing confidence here from the
 * schema alone was a second, divergent opinion on the same extraction
 * (oss-356: review items said 0.0 while the engine said 0.9+).
 *
 * Per field declared in the schema:
 *   - null/undefined value: required → 0.0, optional → 1.0. The engine
 *     scores every null 0.0 ("not_found"), but an optional field that is
 *     legitimately absent from the document is not a review reason.
 *   - empty array (`[]`): treated the same as null — required → 0.0,
 *     optional → 1.0. The engine's provenance formula (0.70·prov + 0.30·val)
 *     scores an empty array 0.30 (prov 0.0, val "passed"), which trips the
 *     review threshold for a legitimately-absent optional list. This is the
 *     symmetric case to a null scalar: "no value" is not a review reason for
 *     an optional field (oss-444).
 *   - non-null value: the engine's score, verbatim.
 *   - non-null value the engine didn't score (defensive — the standard
 *     extraction paths score every extracted field): fall back to the
 *     deterministic schema-based scorer above.
 *
 * `provenanceByField` is the provenance map produced by `resolveProvenance`;
 * it is only consulted on the fallback path.
 */
export function resolveFieldConfidences(
  schemaDef: Record<string, unknown> | undefined,
  extractedValues: Record<string, unknown>,
  engineScores: Record<string, number> | null | undefined,
  provenanceByField?: Record<string, ProvenanceSpan | null | undefined>,
): Record<string, number> {
  const fields = (schemaDef?.fields ?? {}) as Record<string, FieldSchema>;
  const scores: Record<string, number> = {};
  for (const [name, schema] of Object.entries(fields)) {
    const value = extractedValues[name];
    // "No value" — a null/undefined scalar OR an empty array — is scored from
    // the schema alone (required → 0.0, optional → 1.0), NOT from the engine
    // score. The engine scores a null 0.0 and an empty array 0.30; neither is
    // a review reason for a legitimately-absent optional field. Keeping both
    // cases here keeps null scalars and empty lists symmetric (oss-444).
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      scores[name] = Boolean(schema.required) ? 0.0 : 1.0;
      continue;
    }
    const engine = engineScores?.[name];
    scores[name] =
      typeof engine === "number" && Number.isFinite(engine)
        ? engine
        : computeFieldConfidence(value, schema, provenanceByField?.[name] ?? null);
  }
  return scores;
}

/**
 * Aggregate per-field scores into a single doc-level confidence using the
 * strict `min` policy — the document is only as confident as its weakest
 * field. Returns `null` for empty score sets so callers can distinguish
 * "no fields scored" from "all fields scored 0".
 */
export function aggregateDocConfidence(
  fieldScores: Record<string, number>,
): number | null {
  const values = Object.values(fieldScores).filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;
  let min = values[0]!;
  for (const v of values) if (v < min) min = v;
  return min;
}

/**
 * Find the worst-scoring field below `threshold`. Mirrors the existing
 * `findLowestConfidenceField` shape so the routing code can swap one for
 * the other without restructuring.
 */
export function findLowestField(
  fieldScores: Record<string, number>,
  threshold: number,
): { name: string; confidence: number } | null {
  let worst: { name: string; confidence: number } | null = null;
  for (const [name, raw] of Object.entries(fieldScores)) {
    const c = Number(raw);
    if (!Number.isFinite(c)) continue;
    if (c < threshold && (worst === null || c < worst.confidence)) {
      worst = { name, confidence: c };
    }
  }
  return worst;
}
