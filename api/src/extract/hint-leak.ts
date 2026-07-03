/**
 * Hint-example leak guard.
 *
 * Extraction hints routinely include worked examples ("below the caption the
 * value is 'ACME OWNERS ASSOCIATION'"). When the model can't find a real value
 * in the chunks it was shown, it sometimes returns the hint's example verbatim
 * instead of null — a fabricated-but-plausible value that provenance can never
 * locate. The leak signature is the conjunction of two signals:
 *
 *   (a) the value has ZERO provenance in the section text, and
 *   (b) the value appears verbatim (whitespace/case-normalized) in the
 *       field's own hint text.
 *
 * Either signal alone is legitimate — reformatted values miss provenance, and
 * a hint example can genuinely appear in the document (in which case (a) fails
 * and the value is kept). Together they mean the model copied its instructions.
 * Guarded values are nulled so the field reads as not-found instead of wrong.
 *
 * Generic — keyed only on the schema's own hint text; no domain logic.
 */

import type { Chunk } from "./document-map";
import { computeProvenanceStrength } from "./reconcile";

/**
 * Minimum normalized length for a leak match. Below this, containment in the
 * hint is too likely to be coincidence (state codes, format fragments like
 * "PO BOX", short tokens quoted while describing a layout).
 */
const MIN_LEAK_LENGTH = 10;

/** Collapse whitespace runs and lowercase, so a value matches a hint example
 * even when the hint wraps it across lines. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Gather every piece of hint text attached to a field spec, including
 * conditional variants (`extraction_hint_by`) and hints declared on nested
 * array-item / object property specs. Returned pre-normalized.
 */
export function collectHintText(fieldSpec: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  const visit = (spec: unknown): void => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
    const s = spec as Record<string, unknown>;
    if (typeof s.extraction_hint === "string") parts.push(s.extraction_hint);
    const by = s.extraction_hint_by;
    if (by && typeof by === "object" && !Array.isArray(by)) {
      for (const variants of Object.values(by as Record<string, unknown>)) {
        if (variants && typeof variants === "object" && !Array.isArray(variants)) {
          for (const hint of Object.values(variants as Record<string, unknown>)) {
            if (typeof hint === "string") parts.push(hint);
          }
        }
      }
    }
    visit(s.items);
    const props = (s.properties ?? s.fields) as Record<string, unknown> | undefined;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const child of Object.values(props)) visit(child);
    }
  };
  visit(fieldSpec);
  return normalize(parts.join("\n"));
}

/** True when `value` is long enough to be meaningful and appears verbatim
 * (normalized) inside the field's hint text. */
export function matchesHintText(value: string, normalizedHint: string): boolean {
  if (!normalizedHint) return false;
  const v = normalize(value);
  if (v.length < MIN_LEAK_LENGTH) return false;
  return normalizedHint.includes(v);
}

/** A string leaf is a confirmed leak when it matches the hint AND has zero
 * provenance in the section chunks. */
function isLeakedLeaf(
  value: unknown,
  normalizedHint: string,
  chunks: Chunk[],
  sourceText?: string,
): boolean {
  if (typeof value !== "string") return false;
  if (!matchesHintText(value, normalizedHint)) return false;
  return computeProvenanceStrength(value, chunks, "string", sourceText) === 0;
}

/**
 * Null every extracted value that was copied verbatim from its field's own
 * extraction hint and cannot be located anywhere in the section text.
 *
 * - Scalar string fields are set to null.
 * - String array items that leak are removed.
 * - Object properties (top-level objects and array-of-object items) that leak
 *   are nulled; an array item whose properties all end up null is removed.
 *
 * Mutates `extracted` in place and returns the names of affected fields so
 * the caller can rescore them and surface the guard in the trace.
 */
export function stripHintLeaks(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  sectionChunks: Chunk[],
  scalarSourceTexts?: Record<string, string>,
): string[] {
  const affected: string[] = [];

  for (const [fieldName, value] of Object.entries(extracted)) {
    if (value == null) continue;
    const hint = collectHintText(fields[fieldName]);
    if (!hint) continue;

    if (typeof value === "string") {
      if (isLeakedLeaf(value, hint, sectionChunks, scalarSourceTexts?.[fieldName])) {
        extracted[fieldName] = null;
        affected.push(fieldName);
      }
      continue;
    }

    if (Array.isArray(value)) {
      let changed = false;
      const kept = value.filter((item) => {
        if (typeof item === "string") {
          const leaked = isLeakedLeaf(item, hint, sectionChunks);
          if (leaked) changed = true;
          return !leaked;
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          for (const [prop, pv] of Object.entries(obj)) {
            if (isLeakedLeaf(pv, hint, sectionChunks)) {
              obj[prop] = null;
              changed = true;
            }
          }
          // An item stripped down to nothing is itself a leak artifact.
          return Object.values(obj).some((pv) => pv != null);
        }
        return true;
      });
      if (changed) {
        extracted[fieldName] = kept;
        affected.push(fieldName);
      }
      continue;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      let changed = false;
      for (const [prop, pv] of Object.entries(obj)) {
        if (isLeakedLeaf(pv, hint, sectionChunks)) {
          obj[prop] = null;
          changed = true;
        }
      }
      if (changed) {
        if (Object.values(obj).every((pv) => pv == null)) {
          extracted[fieldName] = null;
        }
        affected.push(fieldName);
      }
    }
  }

  return affected;
}
