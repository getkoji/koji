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

// ── resolveWaveFields ──────────────────────────────────────────────

/**
 * Build a shallow schema copy whose `fields` block contains only the
 * given wave's fields with conditional hints resolved.
 */
export function resolveWaveFields(
  schemaDef: SchemaDef,
  wave: string[],
  extractedSoFar: Record<string, unknown>,
): SchemaDef {
  const allFields = schemaDef.fields ?? {};
  const resolvedFields: Record<string, FieldSpec> = {};

  for (const name of wave) {
    if (name in allFields) {
      resolvedFields[name] = resolveConditionalHints(allFields[name] as FieldSpec, extractedSoFar);
    }
  }

  return { ...schemaDef, fields: resolvedFields };
}
