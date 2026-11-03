/**
 * Grid identity — which row is which element (oss-538 / D2), and which column
 * is which sub-field (oss-539 / D3).
 *
 * The idea
 * --------
 * `form-tables.ts` already does row-authoritative extraction, and it works:
 * a hand-authored regex grammar in a schema's `forms:` block reaches ~95% on
 * the layout it was written for. What it does not do is **transfer**. A grammar
 * is written against one issuer's spelling, spacing and column order; the next
 * issuer's version of the same table needs a new grammar. That is the whole
 * reason form-level extractors stalled: accuracy was never the problem,
 * generalization was.
 *
 * The thing that *does* transfer is the schema's own vocabulary. A schema that
 * declares the elements its array can contain (`mappings` / `options` on the
 * row-key sub-field) and the sub-fields each element carries has already said
 * everything needed to read any layout of that table — what is missing is a
 * decision procedure that maps this document's row labels and column headers
 * onto those declarations. That decision is a {@link SelectProvider} `Choice`:
 * a pick from an enumerated set, so the answer is always one of the schema's
 * own names, fabrication is impossible, and the distribution is the confidence.
 *
 * Deterministic first, Choice only for the remainder
 * --------------------------------------------------
 * Most headers and most row labels resolve by literal alias match against the
 * schema — free, exact, reproducible. The selector is asked only about the
 * cells that did not, and only up to a budget. So a well-declared schema on a
 * conventional layout costs zero model calls, and an unfamiliar layout costs a
 * handful of single-token choices rather than a whole-table reconstruction.
 *
 * Identity, never absolute indices
 * --------------------------------
 * The positional path's column *count* is not logical — it over-splits, with
 * phantom blank columns. What holds is that a value and its header share an
 * index. Everything here is written against that invariant: a header is matched
 * to a sub-field and the resulting column index is carried as an opaque handle.
 * A phantom column has an empty header, matches nothing, and is skipped.
 *
 * Engine-generic: every name, alias and option in this module comes from the
 * caller's schema. Nothing here knows what kind of document it is reading.
 */

import {
  ABSTAIN,
  SelectNoAnswerError,
  SelectRequestError,
  SelectUnavailableError,
  type SelectCandidate,
  type SelectProvider,
} from "../select";
import { columnFill, dataRows, headerCells, type Grid, type GridCell } from "./grid";
import type { FieldSpec } from "./schema-tree";

/** Default ceiling on `select` calls per field, across rows and columns. */
export const DEFAULT_SELECT_BUDGET = 24;

/** Sample values shown to the selector when it is asked about a column. */
const COLUMN_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Text folding — one normalization for every literal comparison here
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation to spaces, collapse runs. `"Unit Price ($)"`
 *  and `"unit_price"` both fold to `"unit price"`. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How well two folded strings match, as a rank: 2 for equality, 1 when one
 * wholly contains the other as a whole-word run, 0 for no match.
 *
 * Containment is what makes `"amount"` match an `"Amount (USD)"` header without
 * matching `"amounts payable elsewhere"`. The rank matters because containment
 * is not antisymmetric between sub-fields: a `Unit Price` header contains both
 * `unit_price` and a sibling `price`, and only the exact one is right. Scanning
 * for the best rank rather than the first hit is what stops iteration order
 * deciding that.
 */
function foldRank(a: string, b: string): 0 | 1 | 2 {
  if (!a || !b) return 0;
  if (a === b) return 2;
  const contains =
    a.includes(` ${b} `) || a.startsWith(`${b} `) || a.endsWith(` ${b}`) ||
    b.includes(` ${a} `) || b.startsWith(`${a} `) || b.endsWith(` ${a}`);
  return contains ? 1 : 0;
}

// ---------------------------------------------------------------------------
// D3 — column identity
// ---------------------------------------------------------------------------

/** How a column's sub-field was decided. */
export type IdentityVia = "alias" | "select" | "position" | "none";

export interface ColumnIdentity {
  /** 1-based physical column index in the grid. */
  col: number;
  /** The sub-field this column holds, or `null` when it holds none. */
  subField: string | null;
  via: IdentityVia;
  /** [0,1]. 1 for a literal match; the selector's own number otherwise. */
  confidence: number;
  /** The header text the decision was made from. */
  header: string;
}

export interface ColumnMap {
  /** Sub-field name -> 1-based column index. At most one column per sub-field. */
  byField: Map<string, number>;
  /** Every column considered, in order, with how it was decided. */
  columns: ColumnIdentity[];
  /** `select` calls spent. */
  selectCalls: number;
}

export interface IdentityOptions {
  /** The selector used for the cells literal matching could not resolve. */
  select?: SelectProvider | null;
  /** Ceiling on `select` calls. Default {@link DEFAULT_SELECT_BUDGET}. */
  budget?: number;
  /** Per-sub-field header aliases declared by the schema (`grid.columns`). */
  aliases?: Record<string, string[]>;
  /**
   * What the schema says about the array field being read — its `description`.
   *
   * The selector is deciding what a column or a row *is*, and the schema author
   * has usually already written that down in prose ("Rate is the unit price,
   * Amount is the line total"). Withholding it and then asking a model to infer
   * the same thing from a bare sub-field name is self-inflicted: measured on a
   * corpus of itemized tables, a selector shown only the names abstains on the
   * columns the description explains. Truncated, because this is context for one
   * question, not a prompt.
   */
  context?: string;
  /** Collects one line per selector call / failure, for the run report. */
  trace?: string[];
}

/** Schema context, clipped to a size that is an aside rather than a prompt. */
const MAX_CONTEXT = 700;
function clipContext(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= MAX_CONTEXT ? t : `${t.slice(0, MAX_CONTEXT)}…`;
}

/** The literal spellings a sub-field answers to: its own name, any declared
 *  alias, and a `label`/`title` if the spec carries one. */
function subFieldAliases(
  name: string,
  spec: FieldSpec | undefined,
  declared: string[] | undefined,
): string[] {
  const out = [name];
  for (const key of ["label", "title"]) {
    const v = spec?.[key];
    if (typeof v === "string" && v) out.push(v);
  }
  for (const a of declared ?? []) if (typeof a === "string" && a) out.push(a);
  return out;
}

/** A short, non-identifying description of a sub-field for the selector's
 *  option note: the schema's own first sentence, capped. */
function shortNote(spec: FieldSpec | undefined): string | undefined {
  const d = spec?.description;
  if (typeof d !== "string" || !d.trim()) return undefined;
  const first = d.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  const line = first.trim().slice(0, 160);
  return line || undefined;
}

/**
 * Decide which sub-field each column of `grid` holds.
 *
 * Pass 1 is literal: a header matches a sub-field when their folded forms are
 * equal or one contains the other as a whole-word run. Where two columns map to
 * the same sub-field, the one with more non-empty cells wins — an over-split
 * header leaves its words in several physical columns but the data lands in
 * exactly one.
 *
 * Pass 2 asks the selector, once per unresolved non-empty header, choosing
 * among the sub-fields pass 1 did not take. Abstention is allowed and means
 * "this column is not one of them", which is the common and correct answer for
 * a column the schema does not model.
 */
export async function identifyColumns(
  grid: Grid,
  subFields: Record<string, FieldSpec>,
  opts: IdentityOptions = {},
): Promise<ColumnMap> {
  const names = Object.keys(subFields);
  const headers = headerCells(grid);
  const columns: ColumnIdentity[] = [];
  const byField = new Map<string, number>();
  let selectCalls = 0;

  // Pass 1 — literal alias match.
  const candidates = new Map<string, number[]>(); // sub-field -> candidate columns
  for (let c = 1; c <= grid.columnCount; c++) {
    const header = headers[c - 1]?.text ?? "";
    const folded = fold(header);
    // Best match wins, not first: exact beats containment, and a longer alias
    // beats a shorter one at the same rank (the `form-tables.ts` convention —
    // a more specific spelling is the more specific statement).
    let hit: string | null = null;
    let best = { rank: 0, len: 0 };
    if (folded) {
      for (const name of names) {
        for (const alias of subFieldAliases(name, subFields[name], opts.aliases?.[name])) {
          const needle = fold(alias);
          const rank = foldRank(folded, needle);
          if (rank === 0) continue;
          if (rank > best.rank || (rank === best.rank && needle.length > best.len)) {
            best = { rank, len: needle.length };
            hit = name;
          }
        }
      }
    }
    columns.push({ col: c, subField: hit, via: hit ? "alias" : "none", confidence: hit ? 1 : 0, header });
    if (hit) {
      const list = candidates.get(hit) ?? [];
      list.push(c);
      candidates.set(hit, list);
    }
  }

  // One column per sub-field: the fullest candidate keeps it, the rest are freed.
  for (const [name, cols] of candidates) {
    const winner = cols.reduce((best, c) => (columnFill(grid, c) > columnFill(grid, best) ? c : best), cols[0]!);
    byField.set(name, winner);
    for (const c of cols) {
      if (c === winner) continue;
      const entry = columns[c - 1]!;
      entry.subField = null;
      entry.via = "none";
      entry.confidence = 0;
    }
  }

  // Pass 2 — Choice over whatever is left.
  const selector = opts.select;
  const budget = opts.budget ?? DEFAULT_SELECT_BUDGET;
  if (selector) {
    for (const entry of columns) {
      if (selectCalls >= budget) break;
      if (entry.subField) continue;
      if (!fold(entry.header)) continue; // phantom / blank column
      const open = names.filter((n) => !byField.has(n));
      if (open.length === 0) break;

      const options: SelectCandidate[] = open.map((n) => ({
        value: n,
        ...(shortNote(subFields[n]) ? { note: shortNote(subFields[n])! } : {}),
      }));
      const samples = dataRows(grid)
        .map((r) => r.cells[entry.col - 1]?.text ?? "")
        .filter((t) => t.length > 0)
        .slice(0, COLUMN_SAMPLES);
      // A header with nothing under it is an over-split artifact, not a
      // column. Asking about it spends budget and, worse, can hand a sub-field
      // an empty column and lock the real one out.
      if (samples.length === 0) continue;

      selectCalls += 1;
      const res = await runSelect(
        selector,
        {
          ...(opts.context ? { about_this_list: clipContext(opts.context) } : {}),
          column_header: entry.header,
          example_values: samples,
        },
        options,
        "A table column has the header and example values above. Which of the listed fields does this column hold? " +
          "Choose none if the column holds something that is not in the list.",
        opts.trace,
      );
      if (!res || res.choice === ABSTAIN) continue;
      entry.subField = res.choice;
      entry.via = "select";
      entry.confidence = res.answerConfidence;
      byField.set(res.choice, entry.col);
    }
  }

  return { byField, columns, selectCalls };
}

// ---------------------------------------------------------------------------
// D2 — row identity
// ---------------------------------------------------------------------------

/** One element the array may contain, as the schema declares it. */
export interface ElementOption {
  /** The canonical value written into the row's key sub-field. */
  value: string;
  /** Every spelling the document may use, longest-first at match time. */
  aliases: string[];
}

export interface RowIdentity {
  /** 0-based index into {@link Grid.rows}. */
  rowIndex: number;
  /** The canonical element this row is, or `null` under positional identity. */
  key: string | null;
  via: IdentityVia;
  confidence: number;
  /** The text the decision was made from. */
  label: string;
}

export interface RowMap {
  rows: RowIdentity[];
  selectCalls: number;
}

/**
 * The element vocabulary declared for a row-key sub-field: `mappings`
 * (canonical code -> aliases) or a flat `options`/`enum` list. Returns an empty
 * array when the sub-field declares none, which is the signal to fall back to
 * positional row identity.
 */
export function elementVocabulary(spec: FieldSpec | undefined): ElementOption[] {
  if (!spec || typeof spec !== "object") return [];
  const mappings = spec.mappings as Record<string, unknown> | undefined;
  if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) {
    const out: ElementOption[] = [];
    for (const [value, rawAliases] of Object.entries(mappings)) {
      const aliases = (Array.isArray(rawAliases) ? rawAliases : [])
        .filter((a): a is string => typeof a === "string" && a.length > 0);
      out.push({ value, aliases: [value, ...aliases] });
    }
    if (out.length > 0) return out;
  }
  const options = (spec.options ?? spec.enum) as unknown[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    return options
      .filter((o) => o !== null && o !== undefined)
      .map((o) => ({ value: String(o), aliases: [String(o)] }));
  }
  return [];
}

/** The text a row's identity is read from: its key column when one was mapped,
 *  otherwise the row's first non-empty cell. Both are deterministic. */
function rowLabel(cells: readonly GridCell[], keyCol: number | undefined): string {
  if (keyCol !== undefined) return cells[keyCol - 1]?.text ?? "";
  return cells.find((c) => c.text.length > 0)?.text ?? "";
}

/** The vocabulary entry whose LONGEST alias appears in `label`. A more specific
 *  alias beats a generic one, matching `form-tables.ts`'s `resolveVia`. */
function literalElement(label: string, vocabulary: readonly ElementOption[]): string | null {
  const hay = fold(label);
  if (!hay) return null;
  let best: { value: string; len: number } | null = null;
  for (const opt of vocabulary) {
    for (const alias of opt.aliases) {
      const needle = fold(alias);
      if (!needle) continue;
      if (hay.includes(needle) && (!best || needle.length > best.len)) {
        best = { value: opt.value, len: needle.length };
      }
    }
  }
  return best?.value ?? null;
}

/**
 * Decide which element of the schema's vocabulary each data row is.
 *
 * With no vocabulary the rows are their own elements and every row is kept in
 * document order (`via: "position"`) — the correct answer for a free-form list
 * such as an itemized list, where "which element is this?" has no schema-side
 * answer and only the column mapping carries information.
 *
 * With a vocabulary, a row that matches no alias and that the selector abstains
 * on gets `key: null` and `via: "none"`. The caller decides what that means;
 * `grid-tables.ts` drops it, because a row the schema cannot name cannot be
 * merged by key and would otherwise enter the output unaddressable.
 */
export async function identifyRows(
  grid: Grid,
  vocabulary: readonly ElementOption[],
  keyCol: number | undefined,
  opts: IdentityOptions = {},
): Promise<RowMap> {
  const rows: RowIdentity[] = [];
  let selectCalls = 0;

  if (vocabulary.length === 0) {
    for (const { index, cells } of dataRows(grid)) {
      rows.push({ rowIndex: index, key: null, via: "position", confidence: 1, label: rowLabel(cells, keyCol) });
    }
    return { rows, selectCalls };
  }

  const selector = opts.select;
  const budget = opts.budget ?? DEFAULT_SELECT_BUDGET;
  const options: SelectCandidate[] = vocabulary.map((v) => ({
    value: v.value,
    ...(v.aliases.length > 1 ? { note: `written as: ${v.aliases.slice(1, 6).join(", ")}` } : {}),
  }));

  for (const { index, cells } of dataRows(grid)) {
    const label = rowLabel(cells, keyCol);
    const literal = literalElement(label, vocabulary);
    if (literal) {
      rows.push({ rowIndex: index, key: literal, via: "alias", confidence: 1, label });
      continue;
    }
    if (!selector || selectCalls >= budget || !fold(label)) {
      rows.push({ rowIndex: index, key: null, via: "none", confidence: 0, label });
      continue;
    }
    selectCalls += 1;
    const res = await runSelect(
      selector,
      {
        ...(opts.context ? { about_this_list: clipContext(opts.context) } : {}),
        row_label: label,
        row_cells: cells.map((c) => c.text),
      },
      options,
      "A table row has the label and cells above. Which of the listed entries does this row describe? " +
        "Choose none if the row is not one of them (a total, a heading, or a note).",
      opts.trace,
    );
    if (!res || res.choice === ABSTAIN) {
      rows.push({ rowIndex: index, key: null, via: "none", confidence: res?.answerConfidence ?? 0, label });
      continue;
    }
    rows.push({ rowIndex: index, key: res.choice, via: "select", confidence: res.answerConfidence, label });
  }

  return { rows, selectCalls };
}

// ---------------------------------------------------------------------------
// Shared selector call
// ---------------------------------------------------------------------------

/**
 * One `select` call, with every failure turned into "no answer".
 *
 * A selector is an *optional* refinement over literal matching here: the
 * deterministic grid read is the product, and a model that is unavailable, over
 * budget, rate-limited or simply unable to resolve its own answer must degrade
 * to "this cell stays unidentified" rather than take the extraction down. The
 * contract errors are distinguished only so the trace says which happened.
 */
async function runSelect(
  selector: SelectProvider,
  state: Record<string, unknown>,
  options: readonly SelectCandidate[],
  instructions: string,
  trace?: string[],
): Promise<{ choice: string; answerConfidence: number } | null> {
  if (options.length === 0) return null;
  if (options.length > selector.maxOptions) {
    trace?.push(`grid: ${options.length} options exceeds ${selector.name}'s ${selector.maxOptions} — not asked`);
    return null;
  }
  try {
    const res = await selector.select(state, options, instructions, { allowAbstain: true });
    return { choice: res.choice, answerConfidence: res.answerConfidence };
  } catch (err) {
    if (err instanceof SelectUnavailableError) {
      trace?.push(`grid: selector ${selector.name} unavailable — literal matches only`);
    } else if (err instanceof SelectRequestError || err instanceof SelectNoAnswerError) {
      trace?.push(`grid: selector ${selector.name} gave no usable answer (${(err as Error).message})`);
    } else {
      trace?.push(`grid: selector ${selector.name} failed (${(err as Error).message})`);
    }
    return null;
  }
}
