/**
 * Deterministic cell read and the grid extraction stage (oss-540 / D4, and the
 * orchestration of oss-537/538/539).
 *
 * The read itself has no model in it
 * ----------------------------------
 * Once row identity (D2) and column identity (D3) are decided, a value is a
 * lookup: `cellAt(grid, row, col)`. Nothing is generated, so nothing can be
 * fabricated — the output is a substring of the document, and its provenance is
 * the cell's own bounding box (or character span), known before the value is
 * read rather than matched back afterwards. That is the property the whole
 * track exists for: on a table-backed array field there is no post-hoc
 * provenance match and no faithfulness gate to run, because the value never
 * left the page.
 *
 * It is opt-in, and that is deliberate
 * ------------------------------------
 * A field takes this path only when its schema declares a `grid:` block. Every
 * existing schema therefore behaves exactly as before — the LLM rows, the
 * `forms:` overlay, `element_key` collapse and `skip_row_when` all run on the
 * same inputs they always did.
 *
 * That is not caution for its own sake. This stage rewrites the row set of an
 * array field, and a great deal already depends on that row set: `source_texts`
 * is index-aligned with it, `collapseKeyedRows` and `skipMarkedRows` run over
 * it, `validateFields` coerces into it, `provenance.items[]` indexes into it,
 * and `applyFormTables` may be seeding the very same field from a regex
 * grammar. Switching the producer of those rows on by default would change all
 * of that for documents nobody re-measured. Shipping it opt-in means the blast
 * radius of this stage is exactly the set of fields that asked for it.
 *
 * Interaction with `forms:` is defined, not accidental: grid extraction runs
 * inside `intelligentExtract`, so `applyFormTables` runs *after* it and a
 * regex grammar still wins on a field that declares both. A schema should
 * declare one or the other; declaring both is legal and the grammar is the
 * more specific statement.
 *
 * Engine-generic: the row vocabulary, the column names and every alias come
 * from the caller's schema. This module contains no document category, no field
 * name and no domain vocabulary.
 */

import type { BBox, ParseChunk } from "../parse/chunk";
import { LlmChoiceSelectProvider, type SelectProvider } from "../select";
import { seedRowsMerge } from "./form-tables";
import { buildGrids, cellAt, dataRows, type Grid, type GridCell } from "./grid";
import {
  DEFAULT_SELECT_BUDGET,
  elementVocabulary,
  fold,
  identifyColumns,
  identifyRows,
  type ColumnMap,
  type RowMap,
} from "./grid-identity";
import { applyDeclaredTransforms } from "./normalize";
import type { ModelProvider } from "./providers";
import { validateField } from "./pipeline";
import type { ProvenanceMap, ProvenanceSpan } from "./provenance";
import { arrayItemProperties, type FieldSpec } from "./schema-tree";

/** How grid rows combine with the rows extraction already produced. */
export type GridMode = "seed_rows" | "union" | "off";

/**
 * The `grid:` block a schema puts on an array field. `grid: true` is shorthand
 * for an all-defaults block.
 */
export interface GridConfig {
  /**
   * How the grid's rows combine with the extraction's. Only meaningful when
   * the field has a row key with a declared vocabulary — without one there is
   * nothing to join *by*, and the merge is decided by whether the two readings
   * agree on the row count (see `applyGridTables`).
   *
   * - `union` — grid rows win per row key, and extracted rows the grid did not
   *   capture are kept. The default, so a grid that sees only part of a table
   *   enriches rather than deletes.
   * - `seed_rows` — the grid's rows ARE the field's rows; extracted rows the
   *   grid did not account for are dropped. Correct when the grid reliably
   *   contains every row.
   * - `off` — declared and disabled, for turning the stage off without
   *   deleting the configuration.
   */
  mode?: GridMode;
  /** Minimum physical columns for a grid to be considered. Default 2. */
  min_columns?: number;
  /** Minimum sub-fields that must map to columns. Default 2. */
  min_mapped?: number;
  /**
   * The sub-field carrying row identity. Defaults to `hints.element_key`. Its
   * `mappings` / `options` are the vocabulary row identity chooses from; with
   * no vocabulary, rows are positional.
   */
  row_key?: string;
  /** Extra header spellings per sub-field, when the schema's names don't match
   *  what the document prints. */
  columns?: Record<string, string[]>;
  /**
   * Sub-fields the grid must never claim, because **the cell is not the
   * answer**: the column prints a code the schema asks you to dereference
   * elsewhere in the document, or a raw form the schema wants normalized. A
   * deterministic read is only better than a model where the value really is
   * printed in the cell; where the schema asks for something derived, reading
   * the cell is confidently wrong.
   *
   * Measured: on a corpus whose schema says to resolve a short reference code
   * against a list printed elsewhere on the page, letting the grid claim that
   * sub-field replaced the resolved name with the code on every row.
   */
  exclude?: string[];
  /** Allow the `select` fallback for headers and rows literal matching missed.
   *  Default true. */
  select?: boolean;
  /** Ceiling on `select` calls for this field. Default 24. */
  budget?: number;
}

/** One field's grid outcome, for the run report and for tests. */
export interface GridFieldReport {
  field: string;
  /** Grids accepted, by id. */
  grids: string[];
  source: "cells" | "markdown" | "none";
  rows: number;
  mappedColumns: string[];
  selectCalls: number;
  mode: GridMode;
  /**
   * How the grid's rows were combined with the extraction's:
   *   - `key`        — joined on the row key's vocabulary;
   *   - `positional` — both readings found the same row count, joined in order
   *     so the extraction fills the sub-fields no column mapped to;
   *   - `standalone` — the grid's rows replaced the extraction's.
   */
  join: "key" | "positional" | "standalone";
  /** Rows the grid produced that carried at least one non-null value. */
  kept: number;
  /** Extracted rows dropped by the merge. */
  droppedLlmRows: number;
  /** Extracted rows kept by a `union` merge. */
  keptLlmRows: number;
  notes: string[];
}

export interface ApplyGridOptions {
  /** The parse spine, when the caller has one. Geometry-backed grids win. */
  chunks?: readonly ParseChunk[];
  /** The model behind the default `select` implementation. */
  model?: ModelProvider;
  /** An explicit selector, overriding the default. `null` disables selection. */
  select?: SelectProvider | null;
}

/** Read a `grid:` block off a field spec. `undefined` means the field did not
 *  opt in; `null` means it opted out. */
export function gridConfigOf(spec: FieldSpec | undefined): GridConfig | undefined | null {
  if (!spec || typeof spec !== "object") return undefined;
  const raw = spec.grid;
  if (raw === undefined) return undefined;
  if (raw === false) return null;
  if (raw === true) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const cfg = raw as GridConfig;
  if (cfg.mode === "off") return null;
  return cfg;
}

// ---------------------------------------------------------------------------
// D4 — the deterministic read
// ---------------------------------------------------------------------------

/** A row read out of a grid, with the geometry each value came from. */
export interface GridRowRead {
  values: Record<string, unknown>;
  /** Sub-fields whose cell text is not a valid value of the declared type, and
   *  which the grid therefore did not claim. */
  rejected: string[];
  /** Per-sub-field provenance, keyed the same as {@link values}. */
  spans: Record<string, ProvenanceSpan | null>;
  /** The row's own text, for `source_texts`. */
  sourceText: string;
  /** Union of the read cells' boxes, when the grid had geometry. */
  bbox?: BBox;
  page?: number;
}

/** Union of normalized boxes. Local to avoid importing the parse layer's
 *  helper for one call; identical semantics. */
function unionOf(boxes: readonly BBox[]): BBox | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The provenance of one cell. `chunk` rung when the cell carried geometry,
 *  `offset` when it carried a character span, `none` when it carried neither. */
function cellSpan(cell: GridCell): ProvenanceSpan | null {
  if (!cell.text) return null;
  const span: ProvenanceSpan = {
    offset: cell.offset ?? -1,
    length: cell.length ?? cell.text.length,
    chunk: cell.text,
    ...(cell.page !== undefined ? { page: cell.page } : {}),
    ...(cell.bbox ? { bbox: cell.bbox } : {}),
    resolution: cell.bbox ? "chunk" : cell.offset !== undefined ? "offset" : "none",
  };
  return span;
}

/**
 * Read one row at a known set of (row, col) addresses. No model, no matching,
 * no inference — every value is the text of a cell, coerced only by the
 * sub-field's declared type through the engine's own `validateField`, which is
 * the same coercion an extracted value gets.
 *
 * `rowKeyValue` overrides the key sub-field with the canonical element the row
 * was identified as, so the output carries the schema's vocabulary rather than
 * the document's spelling of it. Its provenance still points at the cell the
 * identity was read from.
 */
export function readGridRow(
  grid: Grid,
  rowIndex: number,
  columns: ColumnMap,
  subFields: Record<string, FieldSpec>,
  rowKey?: { field: string; value: string } | undefined,
  locale?: Record<string, string>,
): GridRowRead {
  const values: Record<string, unknown> = {};
  const spans: Record<string, ProvenanceSpan | null> = {};
  const rejected: string[] = [];
  const boxes: BBox[] = [];
  const texts: string[] = [];
  let page: number | undefined;

  for (const [field, col] of columns.byField) {
    const cell = cellAt(grid, rowIndex, col);
    const text = cell?.text ?? "";
    if (cell?.bbox) boxes.push(cell.bbox);
    if (page === undefined && cell?.page !== undefined) page = cell.page;
    if (text) texts.push(text);

    if (rowKey && field === rowKey.field) {
      values[field] = rowKey.value;
      spans[field] = cell ? cellSpan(cell) : null;
      continue;
    }
    if (!text) {
      values[field] = null;
      spans[field] = null;
      continue;
    }

    // The grid claims a value only if it can produce one in the sub-field's
    // DECLARED type. The schema's own `normalize:` transforms run first (a
    // reader that hands a raw cell to a `date` field and is rejected by the
    // very schema that declared how to normalize it is failing for no reason),
    // and then `validateField` — the same coercion an extracted value gets —
    // has to accept the result.
    //
    // When it doesn't, the cell is NOT the schema's answer: a `09/06/2025` in
    // a `date` column is a date the schema cannot represent and the extraction
    // resolved with locale context the grid does not have. Overwriting the
    // extraction's `2025-09-06` with the raw cell is confidently wrong, and
    // measured on the corpus it was the single largest cause of grid
    // extraction scoring BELOW plain extraction. Leaving the sub-field unread
    // hands it back to whichever reading could represent it.
    const spec = subFields[field] ?? {};
    const normalized = applyDeclaredTransforms(text, spec, locale);
    const [coerced, ok] = validateField(field, normalized, spec);
    if (!ok) {
      values[field] = null;
      spans[field] = null;
      rejected.push(field);
      continue;
    }
    values[field] = coerced ?? null;
    spans[field] = cell ? cellSpan(cell) : null;
  }

  // A row key that mapped to no column still carries its identity.
  if (rowKey && !(rowKey.field in values)) {
    values[rowKey.field] = rowKey.value;
    spans[rowKey.field] = null;
  }

  return {
    values,
    spans,
    rejected,
    sourceText: texts.join(" | ").slice(0, 500),
    ...(unionOf(boxes) ? { bbox: unionOf(boxes)! } : {}),
    ...(page !== undefined ? { page } : {}),
  };
}

/**
 * Loose value equality for the alignment check below: numbers compare
 * numerically after symbols are stripped, everything else compares folded.
 * Deliberately lenient — it is answering "did these two readings look at the
 * same row?", not "is this value correct".
 */
function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(String(a).replace(/[^0-9.-]/g, ""));
    const nb = Number(String(b).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-9;
  }
  return fold(String(a)) === fold(String(b));
}

/**
 * Evidence that two equal-length row sets are the SAME rows in the SAME order.
 *
 * Equal counts alone are not that evidence. An array field whose schema asks
 * for a *reconciled* list — one entry per logical element, collated from
 * wherever each part appeared — has no reason to come back in the order a
 * single table prints, and joining those by position silently pairs row 1's
 * values with row 3's.
 *
 * So: a positional join is allowed only when at least one mapped sub-field
 * agrees between the two readings on EVERY row. Unanimity, not a majority —
 * a majority means the remaining rows are pairings nobody verified, and those
 * are exactly the rows the join would then overwrite with another row's
 * values. Measured: at a half-row threshold the join still cost accuracy on a
 * reconciled array; at unanimity it is neutral where it cannot help and
 * correcting where it can.
 *
 * Returns the agreeing sub-field, or null when nothing agrees.
 */
function positionalAlignment(
  gridRows: ReadonlyArray<Record<string, unknown>>,
  llmRows: readonly unknown[],
  mapped: readonly string[],
): string | null {
  if (gridRows.length === 0) return null;
  for (const field of mapped) {
    let unanimous = true;
    for (let i = 0; i < gridRows.length && unanimous; i++) {
      const llm = llmRows[i];
      if (!llm || typeof llm !== "object" || Array.isArray(llm)) unanimous = false;
      else if (!looselyEqual(gridRows[i]![field], (llm as Record<string, unknown>)[field])) unanimous = false;
    }
    if (unanimous) return field;
  }
  return null;
}

/** True when a read row carries nothing — a spacer or a mis-detected row. */
function isEmptyRead(read: GridRowRead, rowKeyField?: string): boolean {
  for (const [k, v] of Object.entries(read.values)) {
    if (rowKeyField && k === rowKeyField) continue;
    if (v !== null && v !== undefined && v !== "") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Run grid extraction for every array field that declares a `grid:` block.
 *
 * Mutates `extracted`, `sourceTexts` and `provenance` in place, the same
 * contract `applyFormTables` follows, and returns one report line per field it
 * touched plus the structured reports for a caller that wants them.
 *
 * A field is skipped silently when it did not opt in, when its schema has no
 * item properties to map columns onto, when the document has no grid passing
 * the gates, or when the accepted grids produced no non-empty rows. Skipping
 * leaves the extracted rows exactly as they were.
 */
export async function applyGridTables(
  markdown: string,
  schemaDef: Record<string, unknown>,
  extracted: Record<string, unknown>,
  sourceTexts: Record<string, string[]> | undefined,
  provenance: ProvenanceMap | undefined,
  opts: ApplyGridOptions = {},
): Promise<{ report: string[]; fields: GridFieldReport[] }> {
  const fields = (schemaDef.fields ?? {}) as Record<string, FieldSpec>;
  const targets: Array<[string, FieldSpec, GridConfig]> = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object" || spec.type !== "array") continue;
    const cfg = gridConfigOf(spec);
    if (!cfg) continue;
    targets.push([name, spec, cfg]);
  }
  if (targets.length === 0) return { report: [], fields: [] };

  const grids = buildGrids(markdown, opts.chunks);
  if (grids.length === 0) return { report: [], fields: [] };

  // The schema's DECLARED locale fallback. Locale *inference* scans the whole
  // extraction and belongs to `normalizeExtracted`; a grid read happens before
  // that and uses only what the schema states outright.
  const locale = ((schemaDef.locale as Record<string, unknown> | undefined)?.fallback ?? undefined) as
    | Record<string, string>
    | undefined;

  const report: string[] = [];
  const fieldReports: GridFieldReport[] = [];

  for (const [field, spec, cfg] of targets) {
    const allSubFields = arrayItemProperties(spec);
    if (!allSubFields || Object.keys(allSubFields).length === 0) continue;
    const excluded = new Set((cfg.exclude ?? []).filter((n) => typeof n === "string"));
    const subFields = Object.fromEntries(
      Object.entries(allSubFields).filter(([name]) => !excluded.has(name)),
    );
    if (Object.keys(subFields).length === 0) continue;

    const hints = (spec.hints ?? {}) as Record<string, unknown>;
    const rowKeyField =
      cfg.row_key ?? (typeof hints.element_key === "string" ? (hints.element_key as string) : undefined);
    const vocabulary = rowKeyField ? elementVocabulary(subFields[rowKeyField]) : [];
    const mode: GridMode = cfg.mode ?? (rowKeyField && vocabulary.length > 0 ? "union" : "seed_rows");

    // The schema's `select: false` is the author's decision and outranks the
    // caller's default selector; `opts.select === null` is the caller
    // disabling selection outright (the benches and every unit test).
    const selector =
      cfg.select === false || opts.select === null
        ? null
        : (opts.select ?? (opts.model ? new LlmChoiceSelectProvider(opts.model) : null));

    const notes: string[] = [];
    // One budget for the whole field, spent across every grid it looks at, so a
    // document with twenty tables cannot turn one opt-in into twenty times the
    // cost.
    const budget = cfg.budget ?? DEFAULT_SELECT_BUDGET;
    let selectCalls = 0;
    const rows: Array<Record<string, unknown>> = [];
    const rowSpans: Array<ProvenanceSpan | null> = [];
    const rowSources: string[] = [];
    const acceptedGrids: string[] = [];
    const mappedColumns = new Set<string>();
    const rejectedSubFields = new Set<string>();
    let source: "cells" | "markdown" | "none" = "none";

    const minColumns = cfg.min_columns ?? 2;
    const minMapped = cfg.min_mapped ?? 2;

    for (const grid of grids) {
      if (grid.columnCount < minColumns) continue;
      if (dataRows(grid).length === 0) continue;

      const columns: ColumnMap = await identifyColumns(grid, subFields, {
        select: selector,
        budget: Math.max(0, budget - selectCalls),
        ...(cfg.columns ? { aliases: cfg.columns } : {}),
        ...(typeof spec.description === "string" ? { context: spec.description } : {}),
        trace: notes,
      });
      selectCalls += columns.selectCalls;
      if (columns.byField.size < minMapped) continue;

      const rowMap: RowMap = await identifyRows(
        grid,
        vocabulary,
        rowKeyField ? columns.byField.get(rowKeyField) : undefined,
        {
          select: selector,
          budget: Math.max(0, budget - selectCalls),
          ...(typeof spec.description === "string" ? { context: spec.description } : {}),
          trace: notes,
        },
      );
      selectCalls += rowMap.selectCalls;

      let acceptedRows = 0;
      for (const identity of rowMap.rows) {
        // A vocabulary row with no identity cannot be named, merged or
        // addressed — it is a total line, a heading, or a row the schema does
        // not model. Dropping it is what keeps the row set meaningful.
        if (vocabulary.length > 0 && identity.key === null) continue;
        const read = readGridRow(
          grid,
          identity.rowIndex,
          columns,
          subFields,
          rowKeyField && identity.key !== null ? { field: rowKeyField, value: identity.key } : undefined,
          locale,
        );
        for (const name of read.rejected) rejectedSubFields.add(name);
        if (isEmptyRead(read, rowKeyField)) continue;
        rows.push(read.values);
        rowSources.push(read.sourceText);
        rowSpans.push({
          offset: -1,
          length: 0,
          ...(read.page !== undefined ? { page: read.page } : {}),
          ...(read.bbox ? { bbox: read.bbox } : {}),
          properties: read.spans,
          resolution: read.bbox ? "chunk" : "offset",
        });
        acceptedRows += 1;
      }

      if (acceptedRows > 0) {
        acceptedGrids.push(grid.id);
        source = grid.source;
        for (const name of columns.byField.keys()) mappedColumns.add(name);
      }
    }

    // A sub-field the grid could not represent in the declared type is NOT a
    // sub-field it named: standing alone would null it, which is the thing the
    // gate below exists to prevent.
    for (const name of rejectedSubFields) mappedColumns.delete(name);

    if (rejectedSubFields.size > 0) {
      notes.push(
        `left ${[...rejectedSubFields].join(", ")} to extraction — the cell text is not a valid value ` +
          `of the declared type`,
      );
    }

    if (rows.length === 0) continue;

    const llmRows = Array.isArray(extracted[field]) ? (extracted[field] as unknown[]) : [];
    const llmSources = sourceTexts?.[field];
    const llmAligned = llmSources && llmSources.length === llmRows.length ? llmSources : undefined;

    // How the grid's rows combine with the extraction's. The invariant across
    // every branch: **the grid is authoritative only for the sub-fields it
    // identified.** A column it could not name is not a statement that the
    // column is empty, so throwing the extraction's value for it away would
    // lose information the grid never contradicted.
    let finalRows = rows;
    let finalSources = rowSources;
    let finalSpans: Array<ProvenanceSpan | null> = rowSpans;
    let droppedLlmRows = llmRows.length;
    let keptLlmRows = 0;
    let enriched = 0;
    let join: "key" | "positional" | "standalone" = "standalone";
    let alignedOn: string | null = null;

    if (rowKeyField && vocabulary.length > 0) {
      // Keyed join. Every row carries a name from the schema's vocabulary, so
      // the two row sets can be matched element-wise regardless of order.
      join = "key";
      const merged = seedRowsMerge(rows, rowSources, llmRows, llmAligned, rowKeyField, mode === "union" ? "union" : "seed_rows");
      finalRows = merged.rows;
      finalSources = merged.sourceLines;
      // Grid rows keep their exact spans; rows the merge appended from the
      // extraction have none, and claiming otherwise would put a grid cell's
      // box behind a value that did not come from it.
      finalSpans = merged.rows.map((_, i) => rowSpans[i] ?? null);
      droppedLlmRows = merged.droppedLlmRows;
      keptLlmRows = merged.keptLlmRows;
      enriched = merged.enriched;
    } else if (
      llmRows.length === rows.length &&
      llmRows.length > 0 &&
      (alignedOn = positionalAlignment(rows, llmRows, [...mappedColumns])) !== null
    ) {
      // No row key, but both readings found the same number of rows AND agree
      // on a column for every row — evidence they read the same rows in the
      // same order — so
      // they can be joined by position. The grid wins on every sub-field it
      // read; the extraction fills the ones no column mapped to. This is what
      // keeps a partial column map an improvement instead of a trade.
      join = "positional";
      notes.push(`rows joined by position (aligned on ${alignedOn})`);
      finalRows = rows.map((gridRow, i) => {
        const llm = llmRows[i];
        if (!llm || typeof llm !== "object" || Array.isArray(llm)) return gridRow;
        const merged: Record<string, unknown> = { ...(llm as Record<string, unknown>) };
        for (const [k, v] of Object.entries(gridRow)) {
          if (v !== null && v !== undefined) merged[k] = v;
        }
        return merged;
      });
      enriched = rows.length;
      droppedLlmRows = 0;
    } else if (llmRows.length > 0 && mappedColumns.size < Object.keys(allSubFields).length) {
      // Standing alone means every sub-field no column mapped to becomes null,
      // which is only an honest statement when the grid named them all —
      // counting the ones `exclude` put out of its reach, since those are
      // exactly the values it must not be the source of. With rows already
      // extracted, a partial map and no way to join, replacing a complete row
      // set with a partly-empty one is a regression dressed as determinism.
      // Leave the field to extraction and say why.
      //
      // Measured: on an itemized-table corpus the selector named 2 of 4
      // sub-fields, and without this branch those documents went from fully
      // correct to wrong — the difference between a win and a loss overall.
      notes.push(
        `grid named ${mappedColumns.size}/${Object.keys(allSubFields).length} sub-field(s) and its rows could not ` +
          `be joined to the ${llmRows.length} extracted row(s) — left to extraction`,
      );
      for (const note of notes) report.push(`${field}: ${note}`);
      continue;
    }

    extracted[field] = finalRows;
    if (sourceTexts) sourceTexts[field] = finalSources;
    if (provenance) {
      provenance[field] = { offset: -1, length: 0, items: finalSpans.map((s) => s ?? { offset: -1, length: 0 }) };
    }

    const cols = [...mappedColumns];
    fieldReports.push({
      field,
      grids: acceptedGrids,
      source,
      rows: finalRows.length,
      mappedColumns: cols,
      selectCalls,
      mode,
      join,
      kept: rows.length,
      droppedLlmRows,
      keptLlmRows,
      notes,
    });
    report.push(
      `${field}: ${finalRows.length} row(s) read from ${acceptedGrids.length} ${source} grid(s) ` +
        `[${cols.join(", ")}] (${mode}/${join}; ${rows.length} from cells, ${enriched} enriched by extraction, ` +
        `${keptLlmRows} kept from extraction, ${droppedLlmRows} extraction row(s) dropped, ` +
        `${selectCalls} selection call(s))`,
    );
    for (const note of notes) report.push(`${field}: ${note}`);
  }

  return { report, fields: fieldReports };
}

/** True when any array field in the schema declares a `grid:` block. Lets a
 *  caller skip building grids (and constructing a selector) entirely. */
export function schemaHasGrid(schemaDef: Record<string, unknown>): boolean {
  const fields = (schemaDef?.fields ?? {}) as Record<string, FieldSpec>;
  for (const spec of Object.values(fields)) {
    if (!spec || typeof spec !== "object" || spec.type !== "array") continue;
    if (gridConfigOf(spec)) return true;
  }
  return false;
}
