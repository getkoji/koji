/**
 * Field dependency wave logic — deterministic topological sort of schema
 * fields into extraction waves. Ported from services/extract/pipeline.py.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface SchemaDef {
  fields?: Record<string, FieldSpec>;
  [key: string]: unknown;
}

export interface FieldSpec {
  type?: string;
  depends_on?: string[];
  extraction_hint?: string;
  extraction_hint_by?: Record<string, Record<string, string>>;
  /**
   * Gate field extraction on already-extracted parent values. The field
   * is omitted from the LLM prompt entirely when a parent's value is
   * NOT in the allowed list. More reliable than asking the LLM to
   * "return null" since the field never reaches the model.
   *
   *   skip_unless:
   *     form_type: ["8-K", "8-K/A"]
   *
   * Skipped fields are recorded as null with "skipped" confidence in
   * the pipeline output.
   */
  skip_unless?: Record<string, unknown[]>;
  [key: string]: unknown;
}

// ── toposortFields ─────────────────────────────────────────────────

/**
 * Topologically sort schema fields into extraction waves.
 *
 * Each wave is a list of field names that can be extracted in parallel.
 * Wave N depends only on values produced by waves 0..N-1. A field with
 * no `depends_on` lands in wave 0.
 *
 * Throws on: reference to unknown field, self-dependency, circular dependency.
 *
 * Schemas with no `depends_on` declarations return a single wave containing
 * every field.
 */
export function toposortFields(schemaDef: SchemaDef): string[][] {
  const fields = schemaDef.fields ?? {};
  const fieldNames = Object.keys(fields);

  // Build dependency edges
  const depends = new Map<string, Set<string>>();
  for (const name of fieldNames) {
    depends.set(name, new Set());
  }

  for (const [name, spec] of Object.entries(fields)) {
    if (spec === null || typeof spec !== "object") continue;
    const raw = (spec as FieldSpec).depends_on;
    if (!Array.isArray(raw)) continue;
    for (const parent of raw) {
      if (typeof parent !== "string") continue;
      if (!(parent in fields)) {
        throw new Error(
          `Field '${name}' depends_on unknown field '${parent}'`,
        );
      }
      if (parent === name) {
        throw new Error(`Field '${name}' cannot depend on itself`);
      }
      depends.get(name)!.add(parent);
    }
  }

  const waves: string[][] = [];
  const resolved = new Set<string>();
  const remaining = new Set(fieldNames);

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const name of remaining) {
      const deps = depends.get(name)!;
      let allResolved = true;
      for (const d of deps) {
        if (!resolved.has(d)) {
          allResolved = false;
          break;
        }
      }
      if (allResolved) ready.push(name);
    }
    ready.sort();

    if (ready.length === 0) {
      const cycle = [...remaining].sort().join(", ");
      throw new Error(
        `Circular field dependency detected among: ${cycle}`,
      );
    }

    waves.push(ready);
    for (const name of ready) {
      resolved.add(name);
      remaining.delete(name);
    }
  }

  return waves;
}

// ── resolveConditionalHints ────────────────────────────────────────

/**
 * Return a copy of `fieldSpec` with `extraction_hint` resolved from
 * `extraction_hint_by` against already-extracted values.
 *
 * Resolution picks the first parent whose extracted value matches a
 * declared key. If no match, returns the original fieldSpec unchanged.
 * The original fieldSpec is never mutated.
 */
export function resolveConditionalHints(
  fieldSpec: FieldSpec,
  extractedSoFar: Record<string, unknown>,
): FieldSpec {
  if (fieldSpec === null || typeof fieldSpec !== "object") {
    return fieldSpec;
  }

  const byParent = fieldSpec.extraction_hint_by;
  if (byParent === null || typeof byParent !== "object" || Object.keys(byParent).length === 0) {
    return fieldSpec;
  }

  for (const [parentName, valueMap] of Object.entries(byParent)) {
    if (valueMap === null || typeof valueMap !== "object") continue;

    const parentValue =
      extractedSoFar !== null && typeof extractedSoFar === "object"
        ? extractedSoFar[parentName]
        : undefined;

    if (parentValue === null || parentValue === undefined) continue;

    // Exact match first, then string coercion
    let matched: unknown = (valueMap as Record<string, unknown>)[parentValue as string];
    if (matched === null || matched === undefined) {
      matched = (valueMap as Record<string, unknown>)[String(parentValue)];
    }

    if (typeof matched === "string" && matched.trim()) {
      return { ...fieldSpec, extraction_hint: matched };
    }
  }

  return fieldSpec;
}

// ── shouldSkipField ────────────────────────────────────────────────

/**
 * Return true when this field's `skip_unless` condition is NOT met
 * against already-extracted values — i.e. the field should be skipped.
 *
 *   skip_unless:
 *     form_type: ["8-K", "8-K/A"]
 *
 * Semantics, matching the Python reference:
 *
 *   - Missing or non-object `skip_unless` → never skips (return false).
 *   - For each (parent, allowed[]) pair: if the parent's extracted value
 *     is null/undefined OR its string form is NOT in `allowed`, skip.
 *   - Non-list `allowed` values are ignored (defensive — bad schema).
 *   - All conditions are AND'd: any failing parent triggers a skip.
 *
 * String coercion on both sides means a numeric or boolean parent value
 * can match a string-encoded allowed list ("42" vs 42) the way schema
 * authors expect.
 */
export function shouldSkipField(
  fieldSpec: FieldSpec,
  extractedSoFar: Record<string, unknown>,
): boolean {
  const skipUnless = fieldSpec.skip_unless;
  if (!skipUnless || typeof skipUnless !== "object") return false;

  for (const [parentName, allowed] of Object.entries(skipUnless)) {
    if (!Array.isArray(allowed)) continue;
    const parentValue = extractedSoFar[parentName];
    if (parentValue === null || parentValue === undefined) return true;
    const parentStr = String(parentValue);
    const allowedStrs = allowed.map((v) => String(v));
    if (!allowedStrs.includes(parentStr)) return true;
  }
  return false;
}

// ── resolveWaveFields ──────────────────────────────────────────────

/**
 * Build a shallow schema copy whose `fields` block contains only the
 * given wave's fields with conditional hints resolved.
 *
 * Fields whose `skip_unless` condition is not met are omitted — they
 * never reach the LLM prompt. Callers (the wave loop in
 * intelligent-pipeline.ts) record those fields as null with "skipped"
 * confidence. Use `getSkippedFields` to enumerate the skip set without
 * having to diff `wave` against the returned schema.
 */
export function resolveWaveFields(
  schemaDef: SchemaDef,
  wave: string[],
  extractedSoFar: Record<string, unknown>,
): SchemaDef {
  const allFields = schemaDef.fields ?? {};
  const resolvedFields: Record<string, FieldSpec> = {};

  for (const name of wave) {
    const spec = allFields[name];
    if (!spec) continue;
    if (shouldSkipField(spec as FieldSpec, extractedSoFar)) continue;
    resolvedFields[name] = resolveConditionalHints(spec as FieldSpec, extractedSoFar);
  }

  return { ...schemaDef, fields: resolvedFields };
}

/**
 * Enumerate the names within `wave` whose `skip_unless` condition is
 * not met given the already-extracted values. Returned names will NOT
 * appear in the schema produced by `resolveWaveFields`.
 */
export function getSkippedFields(
  schemaDef: SchemaDef,
  wave: string[],
  extractedSoFar: Record<string, unknown>,
): string[] {
  const allFields = schemaDef.fields ?? {};
  const skipped: string[] = [];
  for (const name of wave) {
    const spec = allFields[name];
    if (!spec) continue;
    if (shouldSkipField(spec as FieldSpec, extractedSoFar)) skipped.push(name);
  }
  return skipped;
}
