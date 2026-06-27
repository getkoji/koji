/**
 * `keep_raw` companion fields.
 *
 * When a field declares `keep_raw: true`, Koji emits a first-class
 * `<field>_raw` companion alongside the (canonicalized) value, holding the
 * document's **verbatim** text for that value — e.g. the carrier's printed
 * "Each Occurrence" next to the canonical `each_occurrence`.
 *
 * The verbatim text is read from the resolved provenance span's `chunk`
 * (`markdown.slice(offset, offset+length)`), so it works at any depth — the
 * provenance map carries per-array-item and per-object-property spans. This
 * runs after extraction/normalization, so the main value keeps its canonical
 * form and the `_raw` companion is left untouched by validation/normalization.
 */

import type { ProvenanceMap, ProvenanceSpan } from "./provenance";
import { arrayItemProperties, objectProperties } from "./schema-tree";

type Fields = Record<string, Record<string, unknown>>;
type SpanMap = Record<string, ProvenanceSpan | null> | undefined;

/** True when any field in the tree (at any depth) declares `keep_raw`. */
export function schemaHasKeepRaw(fields: Fields | undefined): boolean {
  if (!fields) return false;
  for (const spec of Object.values(fields)) {
    if (!spec || typeof spec !== "object") continue;
    if (spec.keep_raw) return true;
    const itemProps = arrayItemProperties(spec);
    if (itemProps && schemaHasKeepRaw(itemProps)) return true;
    const objProps = objectProperties(spec);
    if (objProps && schemaHasKeepRaw(objProps)) return true;
  }
  return false;
}

/**
 * Populate `<field>_raw` companions in `extracted` from `provenance`, recursing
 * into array items and nested objects. Mutates `extracted` in place.
 */
export function applyKeepRaw(
  extracted: Record<string, unknown>,
  fields: Fields,
  provenance: ProvenanceMap | undefined,
): void {
  walk(extracted, fields, provenance);
}

function walk(obj: Record<string, unknown>, fields: Fields, spanMap: SpanMap): void {
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object") continue;
    const value = obj[name];
    const span = spanMap?.[name] ?? null;

    const itemProps = arrayItemProperties(spec);
    if (itemProps && Array.isArray(value)) {
      value.forEach((row, i) => {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          walk(row as Record<string, unknown>, itemProps, span?.items?.[i]?.properties);
        }
      });
      continue;
    }

    const objProps = objectProperties(spec);
    if (objProps && value && typeof value === "object" && !Array.isArray(value)) {
      walk(value as Record<string, unknown>, objProps, span?.properties);
      continue;
    }

    if (spec.keep_raw && value != null) {
      const raw = span?.chunk;
      const key = `${name}_raw`;
      if (typeof raw === "string" && raw && !(key in obj)) {
        obj[key] = raw;
      }
    }
  }
}
