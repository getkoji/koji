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
  /**
   * How parser rows and LLM rows combine (default `seed_rows`):
   *   - `seed_rows` — parser rows ARE the row set; unmatched LLM rows dropped.
   *   - `union`     — parser rows still win on conflict by element key, but LLM
   *     rows the grammar didn't capture are KEPT. Makes a partial grammar safe
   *     to ship: if the parse degrades and the grammar sees only a subset of
   *     rows, it enriches rather than deletes the LLM's correct rows.
   */
  mode?: "seed_rows" | "union";
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

/** Flag letters V8 accepts as `RegExp` flags that a LEADING inline group can set. */
const TRANSLATABLE_INLINE_FLAGS = new Set(["i", "m", "s"]);

/**
 * Translate a LEADING PCRE/Python-style inline-flag group into JS `RegExp`
 * flags. `(?i)ABC` → pattern `ABC` with `i` merged into the flags argument;
 * `(?im)` handles the combined form. V8 throws on a leading `(?i)` ("Invalid
 * group"), so without this a schema author's PCRE-style pattern silently fails
 * to compile and no-ops the whole grammar. SCOPED groups (`(?i:ABC)`) are left
 * untouched — V8 supports those. If the leading group carries a flag JS can't
 * express (e.g. `x`), it is left in place so the existing compile guard fails
 * safe rather than us producing a subtly different regex.
 */
function translateLeadingInlineFlags(pattern: string, flags: string): { pattern: string; flags: string } {
  // Match `(?<letters>)` at the very start — NOT `(?letters:` (scoped) and NOT
  // `(?<name>` (named group): the char after the flag letters must be `)`.
  const m = /^\(\?([a-z]+)\)/.exec(pattern);
  if (!m) return { pattern, flags };
  const letters = m[1]!;
  if (![...letters].every((c) => TRANSLATABLE_INLINE_FLAGS.has(c))) {
    return { pattern, flags }; // unsupported flag (e.g. x) — leave for fail-safe
  }
  const merged = new Set([...flags, ...letters]);
  return { pattern: pattern.slice(m[0].length), flags: [...merged].join("") };
}

function compile(pattern: string, flags: string): RegExp | null {
  try {
    const t = translateLeadingInlineFlags(pattern, flags);
    return new RegExp(t.pattern, t.flags);
  } catch (err) {
    // A malformed spec pattern must not break extraction — but a silent no-op
    // (which drops the whole grammar) is a costly failure to debug, so say so.
    console.warn(
      `[koji-extract] forms: pattern failed to compile, spec skipped: ${JSON.stringify(pattern)} — ${(err as Error).message}`,
    );
    return null;
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

/** Build one output row from a row-pattern match, or null when the match is
 *  filtered out by `require`/`skip_when_blank`. */
function buildRow(
  m: RegExpMatchArray,
  spec: FormTableSpec,
  fieldSpec: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const groups: Record<string, string | undefined> = m.groups ?? {};
  if ((spec.row.require ?? []).some((g) => !(groups[g] ?? "").trim())) return null;
  if ((spec.row.skip_when_blank ?? []).some((g) => !(groups[g] ?? "").trim())) return null;

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
  return row;
}

/**
 * Run one spec over the markdown. Returns null when inactive (detect miss,
 * anchor miss, bad pattern, or zero rows).
 *
 * The whole markdown is normalized ONCE up front (pipes → spaces, horizontal
 * whitespace collapsed) so `detect`, `anchor`, `end`, and the row grammar all
 * match against the SAME text. Matching the anchor/end against raw markdown
 * while matching rows against normalized text silently dropped tables whose
 * heading carried a pipe or a double space — common in parser output — which
 * made the grammar return nothing even when the rows were plainly present.
 *
 * EVERY anchor-delimited region is scanned, not just the first. A repeated
 * structure (e.g. a running-header phrase that reappears each section, with an
 * `end` token between sections) yields one region per section; their rows are
 * unioned, deduped by match offset so overlapping carves never double-count.
 * Scanning only the first region truncated the deterministic row floor to the
 * first section — or, when the first anchor hit a boilerplate header followed
 * immediately by an `end` token, to nothing.
 */
export function runFormTableSpec(
  markdown: string,
  spec: FormTableSpec,
  fieldSpec: Record<string, unknown> | undefined,
): FormTableResult | null {
  const normalized = normalizeRegion(markdown);

  if (spec.detect) {
    const d = compile(spec.detect, "i");
    if (!d || !d.test(normalized)) return null;
  }
  const anchor = compile(spec.anchor, "ig");
  if (!anchor) return null;
  const rowRe = compile(spec.row.pattern, "g");
  if (!rowRe) return null;
  const endRe = spec.end ? compile(spec.end, "ig") : null;
  const maxRegion = spec.max_region ?? DEFAULT_MAX_REGION;

  const rows: Array<Record<string, unknown>> = [];
  const sourceLines: string[] = [];
  const seenOffsets = new Set<number>(); // absolute offsets already emitted

  let cursor = 0;
  let matchedAnchor = false;
  while (cursor <= normalized.length) {
    anchor.lastIndex = cursor;
    const am = anchor.exec(normalized);
    if (!am) break;
    matchedAnchor = true;
    const start = am.index;

    // Region runs anchor → end (first `end` after this anchor), capped by
    // max_region. A small trailing buffer keeps a row that sits just past the
    // end token. The next section is searched from just after the end token so
    // no section is skipped; offset dedup makes the small overlap harmless.
    let regionEnd = Math.min(normalized.length, start + maxRegion);
    let nextCursor = regionEnd;
    if (endRe) {
      endRe.lastIndex = start + am[0].length;
      const em = endRe.exec(normalized);
      if (em) {
        regionEnd = Math.min(regionEnd, em.index + em[0].length + 200);
        nextCursor = em.index + em[0].length;
      }
    }

    const region = normalized.slice(start, regionEnd);
    for (const m of region.matchAll(rowRe)) {
      const abs = start + (m.index ?? 0);
      if (seenOffsets.has(abs)) continue;
      seenOffsets.add(abs);
      const row = buildRow(m, spec, fieldSpec);
      if (!row) continue;
      rows.push(row);
      sourceLines.push(m[0].trim().slice(0, 500));
    }

    // Guarantee forward progress even for a zero-width anchor or a degenerate
    // end that resolves before the anchor.
    cursor = Math.max(nextCursor, start + Math.max(am[0].length, 1));
  }

  if (!matchedAnchor) return null;
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
  /** Keyed LLM rows the grammar didn't capture, kept under `union` mode. */
  keptLlmRows: number;
}

/**
 * Merge parser rows with LLM rows by element key. Parser-captured values always
 * win where the grammar set them; LLM values fill the sub-fields the grammar
 * didn't. Two modes decide what happens to LLM rows with no matching parser row:
 *
 *   - `seed_rows` (default) — the parser rows ARE the row set; unmatched LLM
 *     rows are dropped. Correct when the grammar reliably captures every bound
 *     row.
 *   - `union` — unmatched keyed LLM rows are appended (after the parser rows),
 *     so a partial grammar enriches rather than deletes the LLM's correct rows.
 *     Parser rows still win on conflict. LLM rows with no element key can't be
 *     positioned or de-duplicated and are dropped in both modes.
 *
 * Parser rows with no LLM match stay as parsed.
 */
export function seedRowsMerge(
  parserRows: Array<Record<string, unknown>>,
  parserSources: string[],
  llmRows: unknown[],
  llmSources: string[] | undefined,
  elementKey: string,
  mode: "seed_rows" | "union" = "seed_rows",
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

  // Union: keep the keyed LLM rows the grammar didn't capture, appended after
  // the parser rows in LLM order. Parser rows already won every shared key.
  let keptLlmRows = 0;
  if (mode === "union") {
    for (const [k, { row, src }] of llmByKey) {
      if (usedKeys.has(k)) continue;
      usedKeys.add(k);
      rows.push({ ...row });
      sourceLines.push(src ?? "");
      keptLlmRows += 1;
    }
  }

  const droppedLlmRows = llmRows.length - usedKeys.size;
  return { rows, sourceLines, enriched, droppedLlmRows, keptLlmRows };
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
      const mode = spec.mode === "union" ? "union" : "seed_rows";
      const merged = seedRowsMerge(parsed.rows, parsed.sourceLines, llmRows, llmAligned, elementKey, mode);
      extracted[spec.field] = merged.rows;
      if (sourceTexts) sourceTexts[spec.field] = merged.sourceLines;
      const disposition =
        mode === "union"
          ? `${merged.keptLlmRows} kept from extraction, ${merged.droppedLlmRows} unkeyed extraction row(s) dropped`
          : `${merged.droppedLlmRows} extraction row(s) dropped`;
      report.push(
        `${spec.field}: ${merged.rows.length} row(s) ${mode === "union" ? "unioned" : "seeded"} from form table ` +
          `'${parsed.specId}' (${merged.enriched} enriched by extraction, ${disposition})`,
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
