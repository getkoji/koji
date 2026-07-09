/**
 * Extraction pipeline — runs in-process in the API server.
 *
 * Builds a prompt from schema fields + document markdown, calls the LLM
 * with JSON mode, parses the response into field values with confidence
 * scores, then applies normalization and validation.
 *
 * This is a streamlined single-pass extraction (no document map / routing /
 * gap-fill) that matches the Python pipeline's prompt format and response
 * shape. The full intelligent pipeline (chunking, routing, multi-group)
 * stays in Python until it is fully ported.
 */

import type { ModelProvider } from "./providers";
import { normalizeExtracted } from "./normalize";
import { validateExtracted } from "./validate";
import { arrayItemProperties, objectProperties, resolveVocab } from "./schema-tree";
import { resolveProvenance, type ProvenanceMap, type TextMap } from "./provenance";
import { applyFormTables } from "./form-tables";
import type { FitReport } from "./fit";
import type { ParseChunk } from "../parse/chunk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  model: string;
  strategy: string;
  schema: string;
  elapsed_ms: number;
  extracted: Record<string, unknown>;
  confidence: Record<string, string>;
  confidence_scores: Record<string, number>;
  normalization?: {
    applied: Array<{ field: string; transform: string }>;
    warnings: string[];
  };
  validation?: {
    ok: boolean;
    issues: Array<{ rule: string; field: string | null; message: string }>;
  };
  /** Document-fit verdict — present when the schema declares a `fit` block. */
  fit?: FitReport;
  /** Field-level text provenance: where each value was found in the source markdown. */
  provenance?: ProvenanceMap;
  /** Per-item verbatim source text for array-of-objects fields (from LLM). */
  source_texts?: Record<string, string[]>;
  /** All key-value pairs found in the document via pattern matching (no LLM). */
  kv_pairs?: Array<{ label: string; value: string }>;
  /** Fields that were filled by gap-fill retries (intelligent pipeline). */
  gap_filled?: string[];
  /** Fields nulled by the hint-example leak guard (intelligent pipeline) —
   * the model returned text copied from the field's own extraction_hint with
   * no source in the document. See extract/hint-leak.ts. */
  hint_leaks?: string[];
  /** Document map summary (intelligent pipeline). */
  document_map_summary?: Record<string, unknown>;
  /** Routing plan (intelligent pipeline). */
  routing_plan?: Record<string, unknown>;
  /** Extraction group summary (intelligent pipeline). */
  groups?: Array<{ fields: string[]; chunkCount: number }>;
}

// ---------------------------------------------------------------------------
// Prompt building — matches Python build_group_prompt format
// ---------------------------------------------------------------------------

function describeArrayItem(spec: Record<string, unknown>): string {
  const itemSpec = spec.items as Record<string, unknown> | undefined;
  if (!itemSpec || typeof itemSpec !== "object") return "";

  const itemType = itemSpec.type as string | undefined;
  if (itemType === "object") {
    const properties = itemSpec.properties as Record<string, unknown> | undefined;
    if (!properties) return " of objects";
    const parts = Object.entries(properties).map(([n, s]) => describeProperty(n, s));
    parts.push("__source_text: string — copy the EXACT verbatim text from the document that this item was extracted from");
    return ` of objects with properties {${parts.join(", ")}}`;
  }
  if (itemType === "array") return " of arrays" + describeArrayItem(itemSpec);
  if (itemType) return ` of ${itemType}`;
  return "";
}

function describeProperty(name: string, spec: unknown): string {
  if (!spec || typeof spec !== "object") return `${name}: string`;
  const s = spec as Record<string, unknown>;
  const t = (s.type as string) ?? "string";
  if (t === "array") return `${name}: array${describeArrayItem(s)}`;
  if (t === "object") {
    const nested = s.properties as Record<string, unknown> | undefined;
    if (!nested) return `${name}: object`;
    const parts = Object.entries(nested).map(([n, sp]) => describeProperty(n, sp));
    return `${name}: object with properties {${parts.join(", ")}}`;
  }
  return `${name}: ${t}`;
}

function buildPrompt(
  markdown: string,
  schemaDef: Record<string, unknown>,
): string {
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const schemaName = (schemaDef.name as string) ?? "document";

  const fieldDescriptions: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object") continue;
    const fieldType = (spec.type as string) ?? "string";
    const required = Boolean(spec.required);
    const description = (spec.description as string) ?? "";
    const reqLabel = required ? " (REQUIRED)" : "";
    let descLabel = description ? ` \u2014 ${description}` : "";

    let typeLabel = fieldType;
    if (fieldType === "array") typeLabel = "array" + describeArrayItem(spec);

    const mappings = spec.mappings as Record<string, unknown[]> | undefined;
    const options = (spec.options ?? spec.enum) as unknown[] | undefined;

    if (mappings && typeof mappings === "object") {
      const parts: string[] = [];
      for (const [canonical, aliases] of Object.entries(mappings)) {
        const aliasList = (aliases as unknown[])
          .filter((a) => String(a) !== String(canonical))
          .map(String)
          .join(", ");
        parts.push(aliasList ? `${canonical} (${aliasList})` : String(canonical));
      }
      descLabel += ` [pick from: ${parts.join(", ")}]`;
    } else if (Array.isArray(options) && options.length > 0) {
      descLabel += ` [pick from: ${options.map(String).join(", ")}]`;
    }

    fieldDescriptions.push(`  - ${name}: ${typeLabel}${reqLabel}${descLabel}`);
  }

  const fieldsBlock = fieldDescriptions.join("\n");

  // Extraction notes (hints)
  const noteLines: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hint = typeof spec === "object" ? (spec as any)?.extraction_hint : undefined;
    if (typeof hint === "string" && hint.trim()) {
      noteLines.push(`- **${name}**: ${hint.trim()}`);
    }
  }
  const notesSection = noteLines.length > 0
    ? `\n## Extraction notes\n\n${noteLines.join("\n")}\n`
    : "";

  // Schema config extras
  const cfg = schemaDef as Record<string, unknown>;
  const extraInstructions: string[] = [];

  const locale = (cfg.locale ?? {}) as Record<string, unknown>;
  const localeFallback = (locale.fallback ?? {}) as Record<string, string>;
  const dateLocale = localeFallback.date_format ?? (cfg.date_locale as string);
  const defaultCurrency = localeFallback.currency ?? (cfg.default_currency as string);

  if (dateLocale) {
    extraInstructions.push(
      `Dates in this document use ${dateLocale} format. ` +
      `When you encounter an ambiguous date like 04/06/2018, ` +
      `interpret it according to ${dateLocale} ordering. ` +
      `Output all dates as YYYY-MM-DD regardless of input format.`,
    );
  }
  if (defaultCurrency) {
    extraInstructions.push(`When no explicit currency code is present, assume ${defaultCurrency}.`);
  }
  if (cfg.blank_form_aware) {
    extraInstructions.push(
      "If this document appears to be a BLANK unfilled form with placeholder text " +
      "(underscores, empty brackets, 'MM/DD/YYYY' placeholders, '___________'), " +
      "return null for ALL fields. Do not extract from form labels or instructions \u2014 " +
      "only extract actual filled-in data.",
    );
  }

  let dateInstruction = "Dates as YYYY-MM-DD.";
  if (dateLocale) dateInstruction = `Dates as YYYY-MM-DD (input uses ${dateLocale}).`;
  const extraBlock = extraInstructions.length > 0 ? "\n\n" + extraInstructions.join("\n") : "";

  return `Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract

${fieldsBlock}
${notesSection}
## Document sections

${markdown}

## Instructions

Return a FLAT JSON object with the listed field NAMES as top-level keys \u2014 do NOT nest the result under a schema name or a wrapper object. Example: return \`{"field_a": ..., "field_b": ...}\`, not \`{"${schemaName}": {"field_a": ..., "field_b": ...}}\`. ${dateInstruction} Numbers as numbers (not strings). Booleans as true/false (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data \u2014 only extract what is explicitly in the text. For each object in an array field, include a "__source_text" property with the EXACT verbatim text from the document where you found that item. Copy 1-3 consecutive lines exactly as they appear — do not paraphrase or reformat. Also include a top-level "__source_text" object mapping each field name to the EXACT verbatim text from the document for that field's value — the characters as they appear, before any formatting or normalization. And include a "__source_context" object mapping each field name to the full line or sentence where the value appears, for disambiguation. Example: if extracting effective_date from "Policy Period: From 12-04-17 To 12-04-18", return {"effective_date": "2017-12-04", "__source_text": {"effective_date": "12-04-17"}, "__source_context": {"effective_date": "Policy Period: From 12-04-17 To 12-04-18"}}.

${extraBlock}

JSON:`;
}

// ---------------------------------------------------------------------------
// JSON parsing with fallback
// ---------------------------------------------------------------------------

function parseJsonResponse(raw: string): Record<string, unknown> | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON object from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  // Strip the LLM's self-emitted `__confidence` at parse time so
  // downstream code can't accidentally rely on it. See
  // extract/field-confidence.ts for the deterministic replacement.
  if (parsed && typeof parsed === "object") {
    delete parsed.__confidence;
    for (const v of Object.values(parsed)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        delete (v as Record<string, unknown>).__confidence;
      }
    }
  }
  return parsed;
}

/**
 * Unwrap a result the LLM wrapped under a single non-field key.
 * See Python _unwrap_nested_result for rationale.
 */
function unwrapNestedResult(
  result: Record<string, unknown>,
  expectedFields: Set<string>,
): Record<string, unknown> {
  if (!result || expectedFields.size === 0) return result;
  // If any expected field is already top-level, it's already flat
  for (const f of expectedFields) {
    if (f in result) return result;
  }
  // Look for exactly one nested dict whose keys overlap with expected
  const candidates = Object.values(result).filter(
    (v): v is Record<string, unknown> =>
      v != null && typeof v === "object" && !Array.isArray(v) &&
      Object.keys(v).some((k) => expectedFields.has(k)),
  );
  if (candidates.length === 1) return candidates[0]!;
  return result;
}

// ---------------------------------------------------------------------------
// Confidence scoring — matches Python pipeline.reconcile
// ---------------------------------------------------------------------------

function scoreLabel(score: number): string {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  if (score > 0) return "low";
  return "not_found";
}

// Confidence scoring weights — provenance + validation only.
// LLM self-assessed confidence removed: untrustworthy signal that added
// prompt overhead without improving accuracy.
const W_PROV = 0.70;
const W_VAL = 0.30;

/**
 * Compatibility shim — historically extracted `__confidence` from parsed
 * LLM responses. Now a no-op: `__confidence` is stripped at parse time
 * (see parseJsonResponse) and confidence is computed deterministically
 * in `extract/field-confidence.ts`. Retained for back-compat callers.
 */
export function extractLlmConfidence(
  parsed: Record<string, unknown>,
): Record<string, number> {
  // Defensive double-strip in case a caller hands us an object that
  // didn't come through parseJsonResponse.
  delete parsed.__confidence;
  return {};
}

/**
 * Extract __reasoning from a parsed LLM response.
 * Removes the key from the parsed object so downstream code never sees it.
 */
export function extractLlmReasoning(
  parsed: Record<string, unknown>,
): Record<string, string> {
  const raw = parsed.__reasoning;
  delete parsed.__reasoning;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Extract and strip `__source_text` from array-of-objects items.
 * Returns a map of field name → source texts (one per array item).
 * Mutates `parsed` by deleting `__source_text` from each item.
 */
export function extractSourceTexts(
  parsed: Record<string, unknown>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const texts: string[] = [];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const src = obj.__source_text;
        delete obj.__source_text;
        texts.push(typeof src === "string" ? src : "");
      } else {
        texts.push("");
      }
    }
    if (texts.some((t) => t.length > 0)) {
      result[field] = texts;
    }
  }
  return result;
}

function extractScalarSourceTexts(parsed: Record<string, unknown>): Record<string, string> {
  const raw = parsed.__source_text;
  delete parsed.__source_text;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

function extractSourceContexts(parsed: Record<string, unknown>): Record<string, string> {
  const raw = parsed.__source_context;
  delete parsed.__source_context;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

/**
 * Recursively delete every `__`-prefixed key from an extracted value.
 *
 * The model emits provenance inline (`__source_text` on array items,
 * `__source_context` maps). Those are harvested to the separate provenance
 * channel upstream (`extractSourceTexts`/`extractSourceContexts`), but that
 * harvest is shallow — it only reaches top-level array items. Nested items
 * (e.g. `coverages[].limits[]`) keep their `__source_text`, and no path strips
 * `__source_context` off array items at all. Left inline they pollute the
 * persisted output and the API response, and — because ground truth never
 * carries them — they cap array/object scores in Validate. This sweep is the
 * single point that guarantees `extracted` is free of provenance keys at any
 * depth, regardless of what the harvest reached.
 */
export function stripProvenanceKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripProvenanceKeys(item);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("__")) {
        delete obj[key];
      } else {
        stripProvenanceKeys(obj[key]);
      }
    }
  }
}

/**
 * A scalar string value that is actually a label/caption rather than data — the
 * characters a field's label ends with, not the value the label introduces.
 * Generic (no field names, no document types): a value that ends with a colon is
 * a caption. Real scalar data effectively never ends in ':'.
 */
export function isCaptionValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 1 && value.trim().endsWith(":");
}

/**
 * Deterministic backstop for the `hints.reject_caption` opt-in: null any scalar
 * field whose extracted value is a caption/label instead of the value beneath
 * it, so the engine never *emits* a caption. Nulling routes the field to review
 * (a not-found is safer than a confidently-wrong label). Opt-in per field, so
 * schemas that don't set the hint are unaffected. Returns the fields it nulled.
 */
export function rejectCaptionValues(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
): string[] {
  const nulled: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hints = spec.hints as Record<string, unknown> | undefined;
    if (hints?.reject_caption !== true) continue;
    if (isCaptionValue(extracted[name])) {
      extracted[name] = null;
      nulled.push(name);
    }
  }
  return nulled;
}

/**
 * Compile a pattern hint (a regex string or a list of them) into
 * case-insensitive RegExps. Invalid patterns are skipped rather than failing
 * the field — a schema-author typo shouldn't drop extraction.
 */
function compilePatternList(raw: unknown): RegExp[] {
  const patterns = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== "string" || !p) continue;
    try {
      compiled.push(new RegExp(p, "i"));
    } catch {
      // Skip a malformed pattern — a schema-author bug shouldn't break extraction.
    }
  }
  return compiled;
}

/** Collect every string leaf in an array element (the element itself when it's
 *  a string, all nested string values when it's an object/array). */
function collectStringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringLeaves(v, out);
  }
}

/** Normalized identity value of a row's `element_key` sub-field, or null when
 *  the row doesn't carry it (non-object row, missing/empty key). */
function rowKeyOf(row: unknown, elementKey: string): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const k = (row as Record<string, unknown>)[elementKey];
  if (k === null || k === undefined) return null;
  const s = String(k).trim().toLowerCase().replace(/\s+/g, " ");
  return s.length > 0 ? s : null;
}

/** How much of a row is filled in — non-null, non-empty, non-provenance
 *  sub-fields. Used to pick which duplicate of a keyed row to keep. */
function rowRichness(row: unknown): number {
  if (!row || typeof row !== "object" || Array.isArray(row)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (k.startsWith("__")) continue;
    if (v === null || v === undefined || v === "") continue;
    n += 1;
  }
  return n;
}

/**
 * Collapse duplicate array rows that share an `element_key` value. Multi-pass
 * extraction produces one row VARIANT per place a logical element appears — a
 * summary table, the element's own section, a sub-limit table each yield the
 * same key with different local sub-values — and the exact-JSON union dedup
 * can't see through the sub-field drift. Declaring `element_key` is the
 * schema's statement that the key identifies an element uniquely (scoring
 * already pairs at most one row per key), so same-key rows collapse to the
 * richest one (most filled sub-fields; tie → the earliest, which came from the
 * highest-ranked route). Rows that don't carry the key are kept as-is. Keeps
 * per-element `source_texts` index-aligned. Returns per-field collapse counts
 * for the normalization report.
 */
export function collapseKeyedRows(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  sourceTexts?: Record<string, string[]>,
): Array<{ field: string; collapsed: number }> {
  const report: Array<{ field: string; collapsed: number }> = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hints = spec.hints as Record<string, unknown> | undefined;
    const elementKey = hints?.element_key;
    if (typeof elementKey !== "string" || !elementKey) continue;
    const value = extracted[name];
    if (!Array.isArray(value) || value.length < 2) continue;

    // Pick the winner index per key: richest row, earliest on ties.
    const winnerByKey = new Map<string, number>();
    for (let i = 0; i < value.length; i++) {
      const key = rowKeyOf(value[i], elementKey);
      if (key === null) continue;
      const cur = winnerByKey.get(key);
      if (cur === undefined || rowRichness(value[i]) > rowRichness(value[cur])) {
        winnerByKey.set(key, i);
      }
    }
    const keep = value.map((row, i) => {
      const key = rowKeyOf(row, elementKey);
      return key === null || winnerByKey.get(key) === i;
    });
    if (keep.every(Boolean)) continue;
    extracted[name] = value.filter((_, i) => keep[i]);
    const st = sourceTexts?.[name];
    if (st && st.length === value.length && sourceTexts) {
      sourceTexts[name] = st.filter((_, i) => keep[i]);
    }
    report.push({ field: name, collapsed: keep.filter((k) => !k).length });
  }
  return report;
}

/**
 * Deterministic backstop for the `hints.skip_row_when` opt-in on array fields:
 * drop any element whose string values — or whose verbatim per-row source line —
 * match one of the schema-provided patterns. A repeated structure often lists
 * rows that carry a marker meaning "present in the layout but not actually
 * applicable" ("$0", "Not Covered", "If Included") — enumeration faithfully
 * emits them, and this filter is where they get dropped. Keeps the
 * index-aligned per-element `source_texts` in sync so provenance highlighting
 * doesn't shift onto the wrong row. Opt-in per field; returns per-field drop
 * counts for the normalization report.
 */
export function skipMarkedRows(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  sourceTexts?: Record<string, string[]>,
): Array<{ field: string; dropped: number }> {
  const report: Array<{ field: string; dropped: number }> = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hints = spec.hints as Record<string, unknown> | undefined;
    const patterns = compilePatternList(hints?.skip_row_when);
    if (patterns.length === 0) continue;
    const value = extracted[name];
    if (!Array.isArray(value) || value.length === 0) continue;
    // When per-element source_texts are index-aligned with the array, the
    // patterns also run against each row's verbatim source line — a row can
    // be marked not-applicable purely by its surroundings (a checkbox glyph,
    // an option/menu marker) while its extracted values look like real data.
    const st = sourceTexts?.[name];
    const aligned = st && st.length === value.length ? st : undefined;
    const keep = value.map((el, i) => {
      const leaves: string[] = [];
      collectStringLeaves(el, leaves);
      const src = aligned?.[i];
      if (src) leaves.push(src);
      return !leaves.some((s) => patterns.some((re) => re.test(s)));
    });
    if (keep.every(Boolean)) continue;
    extracted[name] = value.filter((_, i) => keep[i]);
    if (aligned && sourceTexts) {
      sourceTexts[name] = aligned.filter((_, i) => keep[i]);
    }
    report.push({ field: name, dropped: keep.filter((k) => !k).length });
  }
  return report;
}

/** Normalize a line/caption for matching: strip markdown, collapse spaces, drop
 *  a trailing colon, lowercase. */
function normalizeCaption(s: string): string {
  return s
    .replace(/[*_#>|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:\s*$/, "")
    .toLowerCase();
}

/** Strip leading/trailing markdown decoration from a recovered value line. */
function stripMarkdown(s: string): string {
  return s.replace(/^[*_#>|`\s-]+/, "").replace(/[*_`|\s]+$/, "").trim();
}

/**
 * Find the source line matching `caption` and return the first following
 * non-empty line that isn't itself a caption — the value the label introduces.
 * Returns null when the label isn't found or the next non-empty line is another
 * label (no value beneath it).
 */
export function valueAfterLabel(caption: string, markdown: string): string | null {
  const core = normalizeCaption(caption);
  if (!core) return null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (normalizeCaption(lines[i]!) !== core) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!.trim();
      if (!candidate) continue;
      if (isCaptionValue(candidate)) return null; // next non-empty is another label
      const value = stripMarkdown(candidate);
      return value.length > 0 ? value : null;
    }
    return null;
  }
  return null;
}

/**
 * Recovery variant of the caption guard, for the `hints.take_value_after_label`
 * opt-in. When a scalar comes back as its own label caption, take the value from
 * the line after that label in the source instead of nulling to review —
 * belt-and-suspenders for label→value scalars (pairs with isolate/reject_caption).
 * Falls back to null when no following value is found, so it never emits the
 * caption. Returns the fields it recovered and the fields it nulled.
 */
export function recoverCaptionValues(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  markdown: string,
): { recovered: string[]; nulled: string[] } {
  const recovered: string[] = [];
  const nulled: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hints = spec.hints as Record<string, unknown> | undefined;
    if (hints?.take_value_after_label !== true) continue;
    const val = extracted[name];
    if (!isCaptionValue(val)) continue;
    const next = valueAfterLabel(val as string, markdown);
    if (next != null) {
      extracted[name] = next;
      recovered.push(name);
    } else {
      extracted[name] = null; // never emit the caption
      nulled.push(name);
    }
  }
  return { recovered, nulled };
}

function buildConfidence(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  provenance?: import("./provenance").ProvenanceMap,
  validation?: { ok: boolean; issues: Array<{ field: string | null; message: string }> },
  llmConfidence?: Record<string, number>,
): { confidence: Record<string, string>; confidence_scores: Record<string, number> } {
  const confidence: Record<string, string> = {};
  const confidenceScores: Record<string, number> = {};

  const failedFields = new Set(
    (validation?.issues ?? []).filter((i) => i.field).map((i) => i.field!),
  );

  for (const fieldName of Object.keys(fields)) {
    const value = extracted[fieldName];
    const prov = provenance?.[fieldName];

    // Null value
    if (value == null) {
      confidenceScores[fieldName] = 0;
      confidence[fieldName] = "not_found";
      continue;
    }

    // Provenance strength: text was found in source → 1.0.
    // bbox is for UI highlighting, not confidence scoring.
    let provStrength = 0;
    if (prov && prov.offset >= 0) {
      provStrength = 1.0;
    }

    // Validation bonus
    const valBonus = failedFields.has(fieldName) ? 0 : 1;

    // Deterministic scoring: provenance + validation only
    let score = W_PROV * provStrength + W_VAL * valBonus;
    score = Math.max(0, Math.min(score, 1));
    score = Math.round(score * 1000) / 1000;

    confidenceScores[fieldName] = score;
    confidence[fieldName] = scoreLabel(score);
  }

  return { confidence, confidence_scores: confidenceScores };
}

// ---------------------------------------------------------------------------
// Validate field (matches Python pipeline.validate_field)
// ---------------------------------------------------------------------------

/**
 * Fold a value for enum/mapping alias matching: lowercase, trim, and collapse
 * internal whitespace runs to a single space. So "Building", " building", and
 * "each  occurrence\n" all match their canonical option/alias regardless of the
 * casing and spacing the model happened to emit.
 *
 * Used ONLY for the match; the value written to the output is always the
 * schema's canonical option/code, and any verbatim-label sibling (e.g.
 * `applies_to_raw`) is a separate field left untouched. Mirrors the scorer-side
 * normalization in `_resolve_mapping` (cli/test_runner.py) so extraction-time
 * canonicalization and validate scoring agree.
 */
function foldVocabValue(v: unknown): string {
  return String(v).trim().toLowerCase().replace(/\s+/g, " ");
}

export function validateField(
  name: string,
  value: unknown,
  spec: Record<string, unknown>,
): [unknown, boolean, string | null] {
  if (value == null) {
    if (spec.required) return [null, false, "required field is null"];
    return [null, true, null];
  }

  const fieldType = (spec.type as string) ?? "string";
  let issues: string | null = null;
  let result: unknown = value;

  if (fieldType === "date" && typeof result === "string") {
    const dateMatch = result.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dateMatch) {
      result = `${dateMatch[1]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
    } else {
      issues = `could not parse date: ${result}`;
    }
  } else if (fieldType === "boolean") {
    if (typeof result === "boolean") {
      // already a boolean
    } else if (typeof result === "string") {
      const lower = result.toLowerCase().trim();
      if (["true", "yes", "y", "1", "x", "✓", "☑"].includes(lower)) {
        result = true;
      } else if (["false", "no", "n", "0", "", "☐"].includes(lower)) {
        result = false;
      } else {
        issues = `could not parse boolean: ${result}`;
      }
    } else if (typeof result === "number") {
      result = result !== 0;
    }
  } else if (fieldType === "number") {
    if (typeof result === "string") {
      const cleaned = result.replace(/[$,]/g, "").trim();
      const num = parseFloat(cleaned);
      if (isNaN(num)) {
        issues = `could not parse number: ${result}`;
      } else {
        result = num === Math.floor(num) ? Math.floor(num) : num;
      }
    }
  } else if (fieldType === "enum") {
    const options = (spec.options ?? []) as unknown[];
    if (options.length > 0 && !options.includes(result)) {
      const valueLower = foldVocabValue(result);
      let matched = false;
      for (const opt of options) {
        const optLower = foldVocabValue(opt);
        if (optLower === valueLower || optLower.includes(valueLower) || valueLower.includes(optLower)) {
          result = opt;
          matched = true;
          break;
        }
      }
      if (!matched) issues = `value '${result}' not in allowed options`;
    }
  } else if (fieldType === "mapping") {
    const mappings = (spec.mappings ?? {}) as Record<string, unknown[]>;
    if (Object.keys(mappings).length > 0) {
      const valueStr = String(result);
      const valueLower = foldVocabValue(valueStr);
      if (valueStr in mappings) {
        // Already a canonical code — keep verbatim. (A value that equals a
        // declared code wins over being an alias of another code.)
        result = valueStr;
      } else {
        let matched = false;
        for (const [canonical, aliases] of Object.entries(mappings)) {
          if (valueLower === foldVocabValue(canonical)) {
            result = canonical;
            matched = true;
            break;
          }
          for (const alias of aliases) {
            if (valueLower === foldVocabValue(alias)) {
              result = canonical;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (!matched) {
          for (const [canonical, aliases] of Object.entries(mappings)) {
            for (const alias of aliases) {
              const aliasLower = foldVocabValue(alias);
              if (aliasLower.includes(valueLower) || valueLower.includes(aliasLower)) {
                result = canonical;
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (!matched) issues = `value '${result}' not in allowed mappings`;
        }
      }
    }
  }

  return [result, issues == null, issues];
}

/** A field-level issue surfaced by {@link validateFields} (e.g. a conditional
 *  vocabulary that resolved to the wrong branch). `field` is a path like
 *  `items[1].category`. */
export interface FieldIssue {
  field: string;
  message: string;
}

/**
 * Apply {@link validateField} (type coercion, mapping/enum resolution) across an
 * extracted object, recursing into array-of-objects items and nested objects so
 * the same per-field logic runs at every depth. Mutates `extracted` in place and
 * returns any field-level issues (currently: conditional-vocabulary failures).
 *
 * Two passes per scope: fields WITHOUT `vocab_by` first (so the sibling a
 * conditional field depends on is already coerced), then `vocab_by` fields,
 * whose effective vocabulary is selected from the now-resolved siblings via
 * {@link resolveVocab}. Descent decisions come from the shared
 * {@link arrayItemProperties} / {@link objectProperties} primitives, so this
 * stays in lockstep with how normalize, prompt rendering, and post-extract
 * validation walk the tree.
 */
export function validateFields(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
  pathPrefix = "",
): FieldIssue[] {
  const issues: FieldIssue[] = [];

  // Pass 1 — everything except conditional (`vocab_by`) fields. Recurse into
  // containers here so each nested scope runs its own two passes.
  for (const [fieldName, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object") continue;
    if (spec.vocab_by) continue;
    const value = extracted[fieldName];
    const path = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;

    const itemProps = arrayItemProperties(spec);
    if (itemProps && Array.isArray(value)) {
      value.forEach((row, i) => {
        if (row && typeof row === "object" && !Array.isArray(row)) {
          issues.push(...validateFields(row as Record<string, unknown>, itemProps, `${path}[${i}]`));
        }
      });
      continue;
    }

    const objProps = objectProperties(spec);
    if (objProps && value && typeof value === "object" && !Array.isArray(value)) {
      issues.push(...validateFields(value as Record<string, unknown>, objProps, path));
      continue;
    }

    const [validated] = validateField(fieldName, value ?? null, spec);
    extracted[fieldName] = validated;
  }

  // Pass 2 — conditional fields. Siblings are resolved now, so pick the branch.
  for (const [fieldName, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object" || !spec.vocab_by) continue;
    const path = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;
    const value = extracted[fieldName] ?? null;
    const { spec: resolved, status, sibling } = resolveVocab(spec, extracted);

    const [validated, ok, msg] = validateField(fieldName, value, resolved);
    extracted[fieldName] = validated;

    if (status === "unmatched" && value != null) {
      const sv = sibling ? `${sibling.field}=${JSON.stringify(sibling.value)}` : "its condition";
      issues.push({ field: path, message: `no conditional vocabulary branch for ${sv}` });
    } else if (status === "matched" && !ok && msg) {
      const sv = sibling ? `${sibling.field}=${JSON.stringify(sibling.value)}` : "the selected branch";
      issues.push({ field: path, message: `value not valid for ${sv}: ${msg}` });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract fields from markdown using the given schema and LLM provider.
 *
 * Builds a prompt, calls the provider, parses the JSON response, runs
 * field validation, normalization, and schema validation.
 *
 * Returns the same response shape as the Python extract service.
 */
export async function extractFields(
  markdown: string,
  schemaDef: Record<string, unknown>,
  provider: ModelProvider,
  model: string,
  textMap?: TextMap,
  chunks?: readonly ParseChunk[],
): Promise<ExtractionResult> {
  // Delegate to the intelligent pipeline (chunk → route → parallel extract → gap-fill → reconcile).
  // This replaces the old single-shot approach that stuffed the entire document into one LLM call.
  const { intelligentExtract } = await import("./intelligent-pipeline");
  const result = await intelligentExtract(markdown, schemaDef, provider, model, textMap, chunks);

  // Provenance is harvested to `result.source_texts` inside the pipeline, but
  // that harvest is shallow. Sweep any `__`-prefixed key left inline (nested
  // array items, `__source_context` on array items) so the persisted output,
  // the API response, and Validate scoring never see provenance as a data key.
  stripProvenanceKeys(result.extracted);

  // A fit gate with `on_misfit: reject` short-circuits extraction — there is
  // nothing to validate or normalize. The `fit` block already explains why.
  if (result.fit?.extraction_skipped) {
    result.normalization = { applied: [], warnings: [] };
    result.validation = { ok: true, issues: [] };
    return result;
  }

  // KV pairs: extract if schema opts in (orthogonal to the pipeline)
  const includeKVPairs = Boolean(schemaDef.include_kv_pairs);
  if (includeKVPairs) {
    const { extractKVPairs } = await import("./kv-pairs");
    result.kv_pairs = extractKVPairs(markdown).map(({ label, value }) => ({ label, value }));
  }

  // Field validation + type normalization (mapping resolution, enum snapping,
  // etc.) — recurses into array-of-objects items and nested objects so a
  // `type: mapping` or `number` field works at any depth, not just top level.
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;

  // `take_value_after_label` recovery: if a scalar came back as its own label
  // caption, take the value from the line after that label in the source
  // instead of nulling. Runs before the reject_caption backstop so a recovered
  // field is no longer caption-shaped by the time that runs.
  const captionRecovery = recoverCaptionValues(result.extracted, fields, markdown);

  // `reject_caption` backstop: null any scalar that came back as its own label
  // caption so the engine never emits a caption. Runs before validation so a
  // nulled required field surfaces as not-found (→ review), not a wrong value.
  const captionNulled = rejectCaptionValues(result.extracted, fields);

  // `forms:` table grammars (oss-367): deterministic parsers seed the
  // authoritative row set for their target array fields; LLM rows join by
  // element_key to enrich. Runs FIRST in the array post-processing chain so
  // collapse/skip operate on the seeded set.
  const formReports = applyFormTables(markdown, schemaDef, result.extracted, result.source_texts);

  // `element_key` collapse: multi-pass extraction (per_section groups,
  // enumerate_rows) emits one row variant per place a logical element appears;
  // same-key rows collapse to the richest. Runs before skip_row_when so the
  // skip counts reflect the collapsed set.
  const collapsedRows = collapseKeyedRows(result.extracted, fields, result.source_texts);

  // `skip_row_when` backstop: drop array rows whose values match a
  // schema-provided pattern — rows a table lists but marks as not applicable.
  // Deterministic and after every extraction pass (including enumerate_rows),
  // so a marked row never ships regardless of which pass produced it. Runs
  // before validation so dropped rows aren't validated.
  const skippedRows = skipMarkedRows(result.extracted, fields, result.source_texts);

  const vocabIssues = validateFields(result.extracted, fields);

  // Post-extraction normalization (derived fields, etc.)
  const [normalized, normReport] = normalizeExtracted(result.extracted, schemaDef);
  result.extracted = normalized;
  result.normalization = {
    applied: normReport.applied,
    warnings: [
      ...normReport.warnings,
      ...captionRecovery.recovered.map(
        (f) => `${f}: recovered the value from the line after its label (take_value_after_label)`,
      ),
      ...captionRecovery.nulled.map(
        (f) => `${f}: caption with no value beneath it — routed to review (take_value_after_label)`,
      ),
      ...captionNulled.map(
        (f) => `${f}: dropped a caption/label value (reject_caption) — value routed to review`,
      ),
      ...formReports,
      ...collapsedRows.map(
        ({ field, collapsed }) => `${field}: collapsed ${collapsed} duplicate row(s) by element_key`,
      ),
      ...skippedRows.map(
        ({ field, dropped }) => `${field}: dropped ${dropped} row(s) matching skip_row_when`,
      ),
    ],
  };

  // Post-extraction validation. Conditional-vocabulary failures from field
  // resolution are merged into the same report so a wrong sibling↔value pairing
  // surfaces in review like any other validation issue.
  const validationReport = validateExtracted(normalized, schemaDef);
  result.validation = {
    ok: validationReport.ok && vocabIssues.length === 0,
    issues: [
      ...validationReport.issues,
      ...vocabIssues.map((i) => ({ rule: "conditional_vocab", field: i.field, message: i.message })),
    ],
  };

  return result;
}
