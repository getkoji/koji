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

/**
 * Numeric-scalar leak threshold: how many digits a value must carry before a
 * hint echo is treated as a leak. String leaks require MIN_LEAK_LENGTH chars
 * of distinctiveness; a bare number has no such length, so we gate on digit
 * count instead. Four digits (e.g. a "9,486.00" worked example) is enough to
 * be distinctive; smaller round examples (a "$460" part premium, a "2" in
 * prose) are too common to attribute to the hint.
 */
const MIN_LEAK_DIGITS = 4;

/** Matches a currency/number literal in hint text: grouped thousands
 * (1,000,000 / 9,486.00) or a plain run of digits, each with optional decimals. */
const HINT_NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Canonical numeric value of a formatted literal ("9,486.00" → 9486), or null. */
function canonicalNumber(raw: string): number | null {
  const n = parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

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

/**
 * True when a numeric value equals a numeric literal in the hint text,
 * compared by value so "9486" matches a "9,486.00" worked example. Gated on
 * MIN_LEAK_DIGITS so only distinctive amounts qualify. Accepts a number or a
 * numeric-looking string (some schemas type amounts as strings).
 */
function matchesHintNumber(value: number | string, normalizedHint: string): boolean {
  if (!normalizedHint) return false;
  const digits = String(value).replace(/[^0-9]/g, "");
  if (digits.length < MIN_LEAK_DIGITS) return false;
  const target = canonicalNumber(String(value));
  if (target === null) return false;
  for (const m of normalizedHint.matchAll(HINT_NUMBER_RE)) {
    if (canonicalNumber(m[0]) === target) return true;
  }
  return false;
}

/** A leaf is a confirmed leak when it matches the hint AND has zero provenance
 * in the section chunks. Strings match verbatim (normalized substring); numbers
 * — and numeric-looking strings — match a hint literal by numeric value, so a
 * reformatted echo ("9,486.00" → 9486) is caught (oss-391). */
function isLeakedLeaf(
  value: unknown,
  normalizedHint: string,
  chunks: Chunk[],
  sourceText?: string,
): boolean {
  const isNumericString = typeof value === "string" && /^[\d,]+(?:\.\d+)?$/.test(value.trim());
  if (typeof value === "number" || isNumericString) {
    if (!matchesHintNumber(value as number | string, normalizedHint)) return false;
    const fieldType = typeof value === "number" ? "number" : "string";
    return computeProvenanceStrength(value, chunks, fieldType, sourceText) === 0;
  }
  if (typeof value !== "string") return false;
  if (!matchesHintText(value, normalizedHint)) return false;
  return computeProvenanceStrength(value, chunks, "string", sourceText) === 0;
}

/**
 * True when a spec's values are CANONICAL — an enum/mapping domain the schema
 * declares rather than text transcribed from the document. Canonical values
 * (e.g. a mapping's `general_liability`) by design never appear verbatim in
 * the source AND legitimately appear in the field's hint (worked examples
 * explaining the mapping), so the leak signature is meaningless for them —
 * guarding would null every correctly mapped value.
 */
function isCanonicalValueSpec(spec: Record<string, unknown> | undefined): boolean {
  if (!spec) return false;
  const t = spec.type as string | undefined;
  if (t === "enum" || t === "mapping") return true;
  if (Array.isArray(spec.options) && spec.options.length > 0) return true;
  if (spec.mappings && typeof spec.mappings === "object") return true;
  return false;
}

/** The declared sub-field specs of an object/array-item (either vocabulary). */
function propSpecs(
  spec: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  const props = (spec?.properties ?? spec?.fields) as
    | Record<string, Record<string, unknown>>
    | undefined;
  return props && typeof props === "object" ? props : {};
}

/**
 * Null every extracted value that was copied verbatim from its field's own
 * extraction hint and cannot be located anywhere in the section text.
 *
 * - Scalar string fields are set to null.
 * - String array items that leak are removed.
 * - Object properties (top-level objects and array-of-object items) that leak
 *   are nulled; an array item whose properties all end up null is removed.
 * - Enum/mapping-typed leaves are exempt — their canonical values are
 *   schema-declared, not transcribed (see isCanonicalValueSpec).
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
    const fieldSpec = fields[fieldName];
    if (isCanonicalValueSpec(fieldSpec)) continue;
    const hint = collectHintText(fieldSpec);
    if (!hint) continue;

    if (typeof value === "string" || typeof value === "number") {
      if (isLeakedLeaf(value, hint, sectionChunks, scalarSourceTexts?.[fieldName])) {
        extracted[fieldName] = null;
        affected.push(fieldName);
      }
      continue;
    }

    if (Array.isArray(value)) {
      const itemSpec = fieldSpec?.items as Record<string, unknown> | undefined;
      const itemCanonical = isCanonicalValueSpec(itemSpec);
      const itemProps = propSpecs(itemSpec);
      let changed = false;
      const kept = value.filter((item) => {
        if (typeof item === "string") {
          const leaked = !itemCanonical && isLeakedLeaf(item, hint, sectionChunks);
          if (leaked) changed = true;
          return !leaked;
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          for (const [prop, pv] of Object.entries(obj)) {
            if (isCanonicalValueSpec(itemProps[prop])) continue;
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
      const props = propSpecs(fieldSpec);
      const obj = value as Record<string, unknown>;
      let changed = false;
      for (const [prop, pv] of Object.entries(obj)) {
        if (isCanonicalValueSpec(props[prop])) continue;
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
