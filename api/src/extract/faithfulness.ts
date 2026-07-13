/**
 * Faithfulness gate — null numeric values the model invented.
 *
 * The extraction prompt tells the model to leave an unprinted numeric field
 * `null`, but models routinely placeholder-fill `0` (or an estimate) instead.
 * Those fabricated numbers are indistinguishable from real ones downstream and
 * are especially dangerous for money fields: a not-stated deductible surfacing
 * as a real-looking `$0` is worse than an honest `null`.
 *
 * This pass runs on the RAW parsed model response — while each object still
 * carries the `__source_text` the model was asked to copy verbatim from the
 * document — and nulls any NUMBER that does not appear (as a bounded numeric
 * match) within its own object's cited source text. A value the model actually
 * read off the page is present in the text it cited; a value it invented is
 * not.
 *
 * Deliberately conservative (see oss-440):
 *   - NUMERIC values only. Strings/enums have legitimate region-misses
 *     (normalization, aliases, multi-line) and would false-null.
 *   - Only when a source text is available for the value. If the model gave no
 *     `__source_text` for the value we cannot verify it, so we keep it.
 *   - Row granularity: an array item's numbers are checked against that item's
 *     single `__source_text` string. A fabricated number that coincidentally
 *     equals another field's value printed in the same row survives — closing
 *     that needs per-FIELD source text inside rows (future work).
 *
 * Domain-generic: operates on numeric leaves and their cited text with no
 * knowledge of field names or document types.
 */

import { numericAnchoredInText } from "./provenance";

export interface NulledNumeric {
  /** Dotted path to the nulled leaf, e.g. `coverages[0].limits[1].deductible`. */
  path: string;
  /** The fabricated value that was removed. */
  value: number;
}

/**
 * The source text available to verify the direct scalar children of an object.
 *
 * The extraction prompt emits `__source_text` two ways:
 *   - on an array ITEM, a single verbatim string for the whole row;
 *   - at the top level (and for scalar-bearing objects), a MAP of
 *     field-name → verbatim string.
 * `rowText` captures the former; `fieldMap` the latter.
 */
interface ObjectSource {
  rowText?: string;
  fieldMap?: Record<string, string>;
}

function toFieldMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const map: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") map[k] = val;
  }
  return map;
}

function sourceForObject(obj: Record<string, unknown>): ObjectSource {
  // Per-FIELD source text (a map cited for each of the row's own fields) is
  // preferred: it lets a fabricated number be checked against ITS field's
  // cited text, not the whole row — so a `0` invented for one field can't
  // borrow a genuine `$0` printed for another field in the same row.
  const perField = toFieldMap(obj.__field_source_text);
  if (perField) return { fieldMap: perField };

  // Fallback (top-level scalar map, or an array row that only cited a single
  // row-level string): the top-level `__source_text` is a field→text map; an
  // array item's is one verbatim string covering the whole row.
  const st = obj.__source_text;
  if (typeof st === "string") return { rowText: st };
  const map = toFieldMap(st);
  if (map) return { fieldMap: map };
  return {};
}

/** The cited text a given scalar child should be verifiable against. */
function regionFor(source: ObjectSource, key: string): string | undefined {
  if (source.rowText != null) return source.rowText;
  return source.fieldMap?.[key];
}

function walk(obj: Record<string, unknown>, path: string, nulled: NulledNumeric[]): void {
  const source = sourceForObject(obj);

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith("__")) continue; // provenance/meta keys, not data
    const childPath = path ? `${path}.${key}` : key;

    if (typeof val === "number") {
      const region = regionFor(source, key);
      // No cited text → cannot verify → keep (conservative).
      if (region == null || region === "") continue;
      if (!numericAnchoredInText(region, val)) {
        obj[key] = null;
        nulled.push({ path: childPath, value: val });
      }
      continue;
    }

    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const item = val[i];
        if (item && typeof item === "object" && !Array.isArray(item)) {
          walk(item as Record<string, unknown>, `${childPath}[${i}]`, nulled);
        }
      }
      continue;
    }

    if (val && typeof val === "object") {
      walk(val as Record<string, unknown>, childPath, nulled);
    }
  }
}

/**
 * Null every numeric leaf in `parsed` that the model could not have read off
 * the page — i.e. that does not appear as a standalone number within the
 * verbatim source text the model cited for it. Mutates `parsed` in place and
 * returns the list of removed values (for logging / telemetry).
 *
 * MUST be called on the raw parsed model response BEFORE `__source_text` is
 * harvested/stripped, so nested rows still carry the text used to verify them.
 */
export function nullUnanchoredNumerics(parsed: Record<string, unknown>): NulledNumeric[] {
  const nulled: NulledNumeric[] = [];
  walk(parsed, "", nulled);
  return nulled;
}
