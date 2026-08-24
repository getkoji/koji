/**
 * Starter schema — a first-draft YAML skeleton derived from the document in
 * front of us, for the agentic schema builder to refine.
 *
 * This replaces a set of eight built-in vertical templates (an insurance
 * policy, an ACORD 25 certificate, an invoice, a contract, a bank statement, a
 * tax form, a medical record, a generic fallback) that a hardcoded regex
 * classifier picked between. That approach could only ever be right for the
 * industries someone had thought to enumerate: a lease, a lab result, a bill of
 * lading, or a permit got the empty "generic" template, while a document that
 * merely mentioned "policy number" got insurance field names — carrier, named
 * insured, premium — proposed for it.
 *
 * Nothing here knows what kind of document it is reading. The skeleton is built
 * from the label/value pairs the document itself yields, with types inferred
 * from the shape of each value. A document about anything at all gets a
 * starting point drawn from its own contents, which is both more useful than a
 * canned template and free of any industry assumption.
 */

import type { KVPair } from "./kv-pairs";

/** How many fields a starter skeleton proposes before it stops. */
const MAX_STARTER_FIELDS = 15;

/** Reserved YAML-ish names and words that make poor field identifiers. */
const RESERVED_FIELD_NAMES = new Set(["name", "description", "fields", "type", "items", "true", "false", "null"]);

/**
 * Turn a human label into a snake_case field name.
 * `"Effective Date"` → `effective_date`, `"Total (USD)"` → `total_usd`.
 */
export function toFieldName(label: string): string {
  const snake = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (!snake) return "";
  // A field name can't lead with a digit; prefix rather than drop the label.
  const safe = /^\d/.test(snake) ? `field_${snake}` : snake;
  return RESERVED_FIELD_NAMES.has(safe) ? `${safe}_value` : safe;
}

/**
 * Infer a schema type from what a value looks like. Deliberately shallow —
 * this is a first draft for a human (and a model) to correct, not a decision
 * anything downstream depends on.
 */
export function inferFieldType(value: string): "date" | "number" | "boolean" | "string" {
  const v = value.trim();
  if (!v) return "string";

  // ISO, slash, and dotted dates, plus "12 March 2026" / "March 12, 2026".
  const isoDate = /^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/;
  const numericDate = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;
  const writtenDate =
    /^(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4}$|^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}$/i;
  if (isoDate.test(v) || numericDate.test(v) || writtenDate.test(v)) return "date";

  if (/^(?:yes|no|true|false|y|n)$/i.test(v)) return "boolean";

  // Numeric once a leading/trailing currency mark and a trailing percent are
  // set aside: digits with any grouping and decimal convention. Deliberately
  // agnostic about which separator means what — `1,200.50` and `1.200,50` and
  // `980,00` are all numbers, and which reading is right is the extractor's
  // `normalize` to decide, not this draft's.
  const core = v
    .replace(/^[^\w\s-]+\s*/, "")
    .replace(/\s*[^\w\s%]+$/, "")
    .replace(/\s*%$/, "")
    .trim();
  if (/^-?\d[\d.,]*$/.test(core) && /\d/.test(core)) return "number";

  return "string";
}

/**
 * Fewer than this many usable pairs and the document hasn't told us enough to
 * be worth seeding from — better to leave the editor alone than to fill it
 * with noise.
 */
const MIN_STARTER_FIELDS = 3;

/**
 * Does this label read like something a person wrote as a field name?
 *
 * Real documents — especially scanned ones — yield plenty of pairs whose
 * "label" is an OCR artifact (`AdOOGSYNSNI`), a form code (`NI 00 62 01`), or a
 * sentence fragment (`What you`). Proposing those as schema fields is worse
 * than proposing nothing. Every test here is about the shape of the text, not
 * about what any document is for.
 */
function labelQuality(label: string): number {
  const trimmed = label.trim();
  const words = trimmed.split(/\s+/);
  if (words.length > 4) return 0;

  const letters = trimmed.replace(/[^a-z]/gi, "");
  if (letters.length < 3) return 0;
  // Mostly digits: a form code or a value on the wrong side of the colon.
  if (letters.length < trimmed.replace(/\s/g, "").length * 0.6) return 0;
  // No vowel: not a word in any language written with this alphabet.
  if (!/[aeiouy]/i.test(letters)) return 0;

  // A word a person typed is lowercase, UPPERCASE, or Title Case. Anything else
  // in a word this long is garbled glyphs (`AdOOGSYNSNI`), not a label.
  for (const w of words) {
    const alpha = w.replace(/[^a-z]/gi, "");
    if (alpha.length < 5) continue;
    const isLower = alpha === alpha.toLowerCase();
    const isUpper = alpha === alpha.toUpperCase();
    const isTitle = /^[A-Z][a-z]+$/.test(alpha);
    if (!isLower && !isUpper && !isTitle) return 0;
  }

  // Prefer multi-word, capitalised labels — what a form actually prints.
  let score = 1;
  if (words.length > 1) score += 1;
  if (/^[A-Z]/.test(trimmed)) score += 1;
  return score;
}

/** Is this pair worth proposing as a field, and how strongly? */
function seedQuality(label: string, value: string, fieldName: string): number {
  if (!fieldName || fieldName.length < 2 || fieldName.length > 60) return 0;
  const quality = labelQuality(label);
  if (quality === 0) return 0;

  const v = value.trim();
  // A pair with no value tells us nothing about the field's type.
  if (!v) return quality - 1;

  let score = quality;
  // A field that carries a datum — a date, an amount, a flag — is a better
  // thing to extract than one carrying a paragraph. This is what separates the
  // fields on a form from the prose around it, in any document.
  if (inferFieldType(v) !== "string") score += 2;
  if (v.length <= 40) score += 1;
  return score;
}

/** Escape a string for a double-quoted YAML scalar. */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a starter schema from a document's key-value pairs.
 *
 * Returns null when the document yielded nothing usable — the caller should
 * then leave the editor alone and let the model propose from the document text
 * rather than seeding an empty husk.
 */
export function buildStarterSchema(
  schemaName: string,
  kvPairs: Array<Pick<KVPair, "label" | "value">>,
): string | null {
  // Rank by how much each pair looks like a field, keeping document order
  // within a rank. A real document's first pairs are often its noisiest — a
  // masthead fragment, a form code — and taking them in document order fills
  // the draft with those instead of the fields further down that a person
  // would recognise.
  const ranked = kvPairs
    .map((pair, index) => ({ pair, index, fieldName: toFieldName(pair.label) }))
    .map((entry) => ({ ...entry, quality: seedQuality(entry.pair.label, entry.pair.value, entry.fieldName) }))
    .filter((entry) => entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  const lines: string[] = [];
  const used = new Set<string>();

  for (const { pair, fieldName } of ranked) {
    if (used.size >= MAX_STARTER_FIELDS) break;
    if (used.has(fieldName)) continue;
    used.add(fieldName);

    lines.push(`  ${fieldName}:`);
    lines.push(`    type: ${inferFieldType(pair.value)}`);
    // Carry the document's own wording through as guidance: it is the most
    // accurate description of the field available, and it is the document's,
    // not ours.
    lines.push(`    extraction_guidance: ${yamlQuote(pair.label)}`);
  }

  // Too little signal to seed from. The caller leaves the editor as it is and
  // lets the model propose from the document text, which beats a draft full of
  // fields nobody would recognise.
  if (used.size < MIN_STARTER_FIELDS) return null;

  return [
    `name: ${schemaName}`,
    `description: Draft schema proposed from the uploaded document`,
    `fields:`,
    ...lines,
    "",
  ].join("\n");
}
