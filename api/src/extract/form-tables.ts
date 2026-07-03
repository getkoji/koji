/**
 * Form-table grammar interpreter (oss-367).
 *
 * Schemas can declare deterministic text-table extractors in a top-level
 * `forms:` block. Each spec locates a table region in the parsed markdown
 * (anchor → end), runs a named-group row grammar over the normalized region
 * text, and emits rows for ONE array field. The parser's rows become the
 * AUTHORITATIVE row set for that field (`seed_rows`): row membership is
 * decided deterministically, and LLM-extracted rows join by the field's
 * `element_key` to contribute the sub-fields the grammar didn't capture.
 *
 * The interpreter is fully generic — regexes, transforms, and vocabulary
 * references all come from the schema. It knows nothing about any document
 * domain.
 *
 * Spec shape (YAML):
 *
 *   forms:
 *     - id: premium_summary
 *       detect: "SUMMARY OF PREMIUMS CHARGED"     # optional presence gate
 *       anchor: "SUMMARY OF PREMIUMS CHARGED"     # region start (regex)
 *       end: "ANNUAL TOTAL|PAYMENTS"              # region end (regex, optional)
 *       field: coverages                          # target array field
 *       row:
 *         pattern: "(?<label>[A-Z][A-Za-z /&]+ Coverage Part)\\s*\\$\\s*(?<amount>[\\d,]+|INCL)?"
 *         require: [label]                        # groups that must be non-empty
 *         skip_when_blank: [amount]               # blank group → row not emitted
 *       set:
 *         label: "{label}"
 *         coverage_code: { resolve: "{label}", via: coverage_code }
 *         premium: { money: "{amount}", null_tokens: [INCL] }
 *
 * Region text is normalized before matching: table pipes become spaces and
 * whitespace collapses, so the same grammar matches plain lines, pipe-table
 * rows, and parser-flattened run-on lines.
 */
import { arrayItemProperties } from "./schema-tree";

export interface FormRowSpec {
  pattern: string;
  require?: string[];
  skip_when_blank?: string[];
}

export type SetRule =
  | string
  | { money: string; null_tokens?: string[] }
  | { resolve: string; via: string };

export interface FormTableSpec {
  id?: string;
  detect?: string;
  anchor: string;
  end?: string;
  field: string;
  /** Cap on region size when `end` never matches (chars). */
  max_region?: number;
  row: FormRowSpec;
  set: Record<string, SetRule>;
}

export interface FormTableResult {
  rows: Array<Record<string, unknown>>;
  /** The matched source text per row, index-aligned with `rows`. */
  sourceLines: string[];
  specId: string;
}

const DEFAULT_MAX_REGION = 20_000;

function compile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null; // a malformed spec pattern must not break extraction
  }
}

/** Pipes → spaces, whitespace collapsed — one grammar for plain lines,
 *  pipe-table rows, and flattened run-on lines. */
function normalizeRegion(text: string): string {
  return text.replace(/\|/g, " ").replace(/[ \t]+/g, " ");
}

function substitute(template: string, groups: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, g) => groups[g] ?? "");
}

/** Parse a money-ish capture to a number; configured tokens and blanks → null. */
function moneyValue(raw: string, nullTokens: string[]): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (nullTokens.some((t) => s.toUpperCase() === t.toUpperCase())) return null;
  const digits = s.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  return Number(digits);
}

/**
 * Resolve a text value through a mapping vocabulary declared on a sub-field of
 * the target array field (`{ resolve: "{label}", via: coverage_code }`). The
 * code whose LONGEST alias appears in the value (case-insensitive) wins — so a
 * more specific alias beats a generic one.
 */
function resolveVia(
  value: string,
  via: string,
  fieldSpec: Record<string, unknown> | undefined,
): string | null {
  const props = fieldSpec ? arrayItemProperties(fieldSpec) : undefined;
  const sub = props?.[via] as Record<string, unknown> | undefined;
  const mappings = sub?.mappings as Record<string, unknown> | undefined;
  if (!mappings) return null;
  const hay = value.toLowerCase();
  let best: { code: string; len: number } | null = null;
  for (const [code, rawAliases] of Object.entries(mappings)) {
    const aliases = Array.isArray(rawAliases) ? rawAliases : [];
    for (const a of aliases) {
      if (typeof a !== "string" || !a) continue;
      if (hay.includes(a.toLowerCase()) && (!best || a.length > best.len)) {
        best = { code, len: a.length };
      }
    }
  }
  return best?.code ?? null;
}

/** Run one spec over the markdown. Returns null when inactive (detect miss,
 *  anchor miss, bad pattern, or zero rows). */
export function runFormTableSpec(
  markdown: string,
  spec: FormTableSpec,
  fieldSpec: Record<string, unknown> | undefined,
): FormTableResult | null {
  if (spec.detect) {
    const d = compile(spec.detect, "i");
    if (!d || !d.test(markdown)) return null;
  }
  const anchor = compile(spec.anchor, "i");
  if (!anchor) return null;
  const am = anchor.exec(markdown);
  if (!am) return null;
  const start = am.index;
  let endIdx = start + (spec.max_region ?? DEFAULT_MAX_REGION);
  if (spec.end) {
    const endRe = compile(spec.end, "ig");
    if (endRe) {
      endRe.lastIndex = start + am[0].length;
      const em = endRe.exec(markdown);
      if (em) endIdx = Math.min(endIdx, em.index + em[0].length + 200);
    }
  }
  const region = normalizeRegion(markdown.slice(start, endIdx));

  const rowRe = compile(spec.row.pattern, "g");
  if (!rowRe) return null;

  const rows: Array<Record<string, unknown>> = [];
  const sourceLines: string[] = [];
  for (const m of region.matchAll(rowRe)) {
    const groups: Record<string, string | undefined> = m.groups ?? {};
    if ((spec.row.require ?? []).some((g) => !(groups[g] ?? "").trim())) continue;
    if ((spec.row.skip_when_blank ?? []).some((g) => !(groups[g] ?? "").trim())) continue;

    const row: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(spec.set ?? {})) {
      if (typeof rule === "string") {
        const v = substitute(rule, groups).trim();
        row[key] = v.length > 0 ? v : null;
      } else if ("money" in rule) {
        row[key] = moneyValue(substitute(rule.money, groups), rule.null_tokens ?? []);
      } else if ("resolve" in rule) {
        row[key] = resolveVia(substitute(rule.resolve, groups), rule.via, fieldSpec);
      }
    }
    rows.push(row);
    sourceLines.push(m[0].trim().slice(0, 500));
  }
  if (rows.length === 0) return null;
  return { rows, sourceLines, specId: spec.id ?? spec.anchor.slice(0, 40) };
}

/** Normalized identity for the keyed join (mirrors the engine's row keying). */
function keyOf(row: unknown, elementKey: string): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const k = (row as Record<string, unknown>)[elementKey];
  if (k === null || k === undefined) return null;
  const s = String(k).trim().toLowerCase().replace(/\s+/g, " ");
  return s.length > 0 ? s : null;
}

export interface SeedMergeResult {
  rows: Array<Record<string, unknown>>;
  sourceLines: string[];
  enriched: number;
  droppedLlmRows: number;
}

/**
 * `seed_rows` merge: the parser rows ARE the row set. An LLM row that shares
 * the element key enriches its parser row with the sub-fields the grammar
 * didn't set (non-null LLM values fill parser nulls/absences; parser-captured
 * values always win). LLM rows with no matching parser row are dropped;
 * parser rows with no LLM match stay as parsed.
 */
export function seedRowsMerge(
  parserRows: Array<Record<string, unknown>>,
  parserSources: string[],
  llmRows: unknown[],
  llmSources: string[] | undefined,
  elementKey: string,
): SeedMergeResult {
  const llmByKey = new Map<string, { row: Record<string, unknown>; src: string | undefined }>();
  llmRows.forEach((r, i) => {
    const k = keyOf(r, elementKey);
    if (k !== null && !llmByKey.has(k) && r && typeof r === "object") {
      llmByKey.set(k, { row: r as Record<string, unknown>, src: llmSources?.[i] });
    }
  });

  let enriched = 0;
  const rows: Array<Record<string, unknown>> = [];
  const sourceLines: string[] = [];
  const usedKeys = new Set<string>();
  parserRows.forEach((p, i) => {
    const k = keyOf(p, elementKey);
    const match = k !== null ? llmByKey.get(k) : undefined;
    if (match && k !== null) {
      usedKeys.add(k);
      enriched += 1;
      const merged: Record<string, unknown> = { ...match.row };
      for (const [key, v] of Object.entries(p)) {
        if (v !== null && v !== undefined) merged[key] = v; // parser wins where it captured
      }
      rows.push(merged);
    } else {
      rows.push({ ...p });
    }
    sourceLines.push(parserSources[i] ?? "");
  });

  const droppedLlmRows = llmRows.length - usedKeys.size;
  return { rows, sourceLines, enriched, droppedLlmRows };
}

/**
 * Apply every active `forms:` spec to the extraction result, in place. Keeps
 * per-element `source_texts` aligned with the merged rows (the parser's
 * matched line is the row's provenance). Returns a report line per applied
 * spec for the normalization warnings.
 */
export function applyFormTables(
  markdown: string,
  schemaDef: Record<string, unknown>,
  extracted: Record<string, unknown>,
  sourceTexts: Record<string, string[]> | undefined,
): string[] {
  const specs = schemaDef.forms as FormTableSpec[] | undefined;
  if (!Array.isArray(specs) || specs.length === 0) return [];
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const report: string[] = [];

  for (const spec of specs) {
    if (!spec || typeof spec !== "object" || !spec.field || !spec.anchor || !spec.row?.pattern) continue;
    const fieldSpec = fields[spec.field];
    if (!fieldSpec || (fieldSpec.type as string) !== "array") continue;
    const hints = fieldSpec.hints as Record<string, unknown> | undefined;
    const elementKey = hints?.element_key as string | undefined;

    const parsed = runFormTableSpec(markdown, spec, fieldSpec);
    if (!parsed) continue;

    const llmRows = Array.isArray(extracted[spec.field]) ? (extracted[spec.field] as unknown[]) : [];
    const llmSources = sourceTexts?.[spec.field];
    const llmAligned = llmSources && llmSources.length === llmRows.length ? llmSources : undefined;

    if (elementKey) {
      const merged = seedRowsMerge(parsed.rows, parsed.sourceLines, llmRows, llmAligned, elementKey);
      extracted[spec.field] = merged.rows;
      if (sourceTexts) sourceTexts[spec.field] = merged.sourceLines;
      report.push(
        `${spec.field}: ${merged.rows.length} row(s) seeded from form table '${parsed.specId}' ` +
          `(${merged.enriched} enriched by extraction, ${merged.droppedLlmRows} extraction row(s) dropped)`,
      );
    } else {
      // Without an element key there is no join — the parser rows replace the
      // extraction outright (still deterministic, just un-enriched).
      extracted[spec.field] = parsed.rows;
      if (sourceTexts) sourceTexts[spec.field] = parsed.sourceLines;
      report.push(`${spec.field}: ${parsed.rows.length} row(s) from form table '${parsed.specId}' (no element_key — extraction rows replaced)`);
    }
  }
  return report;
}
