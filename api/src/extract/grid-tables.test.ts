/**
 * Deterministic cell read (D4) and the grid stage as a whole.
 *
 * Two halves. The first asserts the read: a value is a cell's text, coerced by
 * the sub-field's declared type, carrying that cell's own geometry. The second
 * asserts the blast radius — the things that already depended on an array
 * field's rows (source_texts alignment, provenance indexing, the `forms:`
 * overlay, `element_key` collapse, `skip_row_when`) must be unchanged for a
 * field that did not opt in, and must stay consistent for one that did.
 */
import { describe, it, expect } from "vitest";

import { gridsFromMarkdown, gridsFromSpine } from "./grid";
import { identifyColumns } from "./grid-identity";
import { applyGridTables, gridConfigOf, readGridRow, schemaHasGrid } from "./grid-tables";
import { applyFormTables } from "./form-tables";
import { assignUnitIds, type ParseUnitDraft } from "../parse/chunk";
import type { ProvenanceMap } from "./provenance";

const ITEM_FIELDS = {
  name: { type: "string" },
  quantity: { type: "number" },
  unit_price: { type: "number" },
  amount: { type: "number" },
};

const INVOICE_MD = [
  "# Invoice 100",
  "",
  "| Name | Quantity | Unit Price | Amount |",
  "| --- | --- | --- | --- |",
  "| Widget | 2 | $5.00 | $10.00 |",
  "| Gadget | 1 | $5.50 | $5.50 |",
  "",
  "Total: $15.50",
].join("\n");

const NO_GRID = Symbol("no grid block");

function invoiceSchema(grid: unknown = true) {
  return {
    name: "t",
    fields: {
      items: { type: "array", items: { type: "object", properties: ITEM_FIELDS }, ...(grid === NO_GRID ? {} : { grid }) },
    },
  };
}

// ---------------------------------------------------------------------------
// D4 — the read itself
// ---------------------------------------------------------------------------

describe("readGridRow", () => {
  it("reads values from known addresses and coerces by the declared type", async () => {
    const g = gridsFromMarkdown(INVOICE_MD)[0]!;
    const columns = await identifyColumns(g, ITEM_FIELDS, { select: null });
    const read = readGridRow(g, 1, columns, ITEM_FIELDS);
    expect(read.values).toEqual({ name: "Widget", quantity: 2, unit_price: 5, amount: 10 });
  });

  it("never confuses unit price with line total — they are different addresses", async () => {
    const g = gridsFromMarkdown(INVOICE_MD)[0]!;
    const columns = await identifyColumns(g, ITEM_FIELDS, { select: null });
    expect(readGridRow(g, 2, columns, ITEM_FIELDS).values).toEqual({
      name: "Gadget",
      quantity: 1,
      unit_price: 5.5,
      amount: 5.5,
    });
  });

  it("carries each cell's own bbox as that sub-field's provenance", async () => {
    const units = assignUnitIds(
      (
        [
          [1, 1, "Name"],
          [1, 2, "Amount"],
          [2, 1, "Widget"],
          [2, 2, "$10.00"],
        ] as Array<[number, number, string]>
      ).map(([row, col, text]): ParseUnitDraft => ({
        page: 3,
        text,
        role: "table_cell",
        table: { tableId: "p3-t0", row, col },
        bbox: { x: 0.1 * col, y: 0.2, w: 0.05, h: 0.01 },
      })),
    );
    const g = gridsFromSpine(units)[0]!;
    const columns = await identifyColumns(g, ITEM_FIELDS, { select: null });
    const read = readGridRow(g, 1, columns, ITEM_FIELDS);
    expect(read.spans.amount).toMatchObject({
      bbox: { x: 0.2, y: 0.2, w: 0.05, h: 0.01 },
      page: 3,
      chunk: "$10.00",
      resolution: "chunk",
    });
    // The row box is the union of the cells actually read.
    expect(read.bbox!.x).toBeCloseTo(0.1, 10);
    expect(read.bbox!.y).toBeCloseTo(0.2, 10);
    expect(read.bbox!.w).toBeCloseTo(0.15, 10);
    expect(read.bbox!.h).toBeCloseTo(0.01, 10);
    expect(read.page).toBe(3);
  });

  it("falls back to an exact character span when the grid has no geometry", async () => {
    const g = gridsFromMarkdown(INVOICE_MD)[0]!;
    const columns = await identifyColumns(g, ITEM_FIELDS, { select: null });
    const span = readGridRow(g, 1, columns, ITEM_FIELDS).spans.amount!;
    expect(span.resolution).toBe("offset");
    expect(INVOICE_MD.slice(span.offset, span.offset + span.length)).toBe("$10.00");
  });

  it("writes null for a blank cell rather than borrowing a neighbour", async () => {
    const md = ["| Name | Amount |", "| --- | --- |", "| Widget |  |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    const columns = await identifyColumns(g, ITEM_FIELDS, { select: null });
    const read = readGridRow(g, 1, columns, ITEM_FIELDS);
    expect(read.values).toEqual({ name: "Widget", amount: null });
    expect(read.spans.amount).toBeNull();
  });

  it("writes the schema's canonical element into the row key, not the document's spelling", async () => {
    const fields = { coverage: { type: "mapping", mappings: { alpha: ["Alpha Coverage"] } }, amount: { type: "number" } };
    const md = ["| Coverage | Amount |", "| --- | --- |", "| Alpha Coverage | $7 |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    const columns = await identifyColumns(g, fields, { select: null });
    const read = readGridRow(g, 1, columns, fields, { field: "coverage", value: "alpha" });
    expect(read.values).toEqual({ coverage: "alpha", amount: 7 });
    // The identity still points at the cell it was read from.
    expect(read.spans.coverage).toMatchObject({ chunk: "Alpha Coverage" });
  });
});

// ---------------------------------------------------------------------------
// Opt-in — the blast radius
// ---------------------------------------------------------------------------

describe("gridConfigOf / schemaHasGrid", () => {
  it("treats an absent block as not opted in", () => {
    expect(gridConfigOf({ type: "array" })).toBeUndefined();
    expect(schemaHasGrid(invoiceSchema(NO_GRID))).toBe(false);
  });

  it("treats `grid: true` as an all-defaults block", () => {
    expect(gridConfigOf({ type: "array", grid: true })).toEqual({});
    expect(schemaHasGrid(invoiceSchema(true))).toBe(true);
  });

  it("treats `grid: false` and `mode: off` as opted out", () => {
    expect(gridConfigOf({ type: "array", grid: false })).toBeNull();
    expect(gridConfigOf({ type: "array", grid: { mode: "off" } })).toBeNull();
    expect(schemaHasGrid(invoiceSchema(false))).toBe(false);
    expect(schemaHasGrid(invoiceSchema({ mode: "off" }))).toBe(false);
  });

  it("ignores a non-array field that declares a grid block", () => {
    expect(schemaHasGrid({ fields: { x: { type: "string", grid: true } } })).toBe(false);
  });
});

describe("applyGridTables — what it does not touch", () => {
  it("leaves a field that did not opt in exactly as extraction produced it", async () => {
    const extracted = { items: [{ name: "WRONG", amount: 999 }] };
    const sourceTexts: Record<string, string[]> = { items: ["wrong line"] };
    const { report } = await applyGridTables(INVOICE_MD, invoiceSchema(NO_GRID), extracted, sourceTexts, {});
    expect(report).toEqual([]);
    expect(extracted.items).toEqual([{ name: "WRONG", amount: 999 }]);
    expect(sourceTexts.items).toEqual(["wrong line"]);
  });

  it("leaves an opted-out field alone even when the document has a perfect grid", async () => {
    const extracted = { items: [{ name: "WRONG" }] };
    const { report } = await applyGridTables(INVOICE_MD, invoiceSchema(false), extracted, undefined, undefined);
    expect(report).toEqual([]);
    expect(extracted.items).toEqual([{ name: "WRONG" }]);
  });

  it("leaves the field alone when the document has no grid at all", async () => {
    const extracted = { items: [{ name: "KEEP" }] };
    await applyGridTables("just prose, no tables", invoiceSchema(true), extracted, undefined, undefined);
    expect(extracted.items).toEqual([{ name: "KEEP" }]);
  });

  it("leaves the field alone when too few columns map — a grid it cannot read is not a grid", async () => {
    const md = ["| Tax Code | Ledger |", "| --- | --- |", "| X1 | 44 |"].join("\n");
    const extracted = { items: [{ name: "KEEP" }] };
    await applyGridTables(md, invoiceSchema(true), extracted, undefined, undefined, { select: null });
    expect(extracted.items).toEqual([{ name: "KEEP" }]);
  });

  it("respects min_mapped", async () => {
    const extracted = { items: [{ name: "KEEP" }] };
    await applyGridTables(INVOICE_MD, invoiceSchema({ min_mapped: 9 }), extracted, undefined, undefined, {
      select: null,
    });
    expect(extracted.items).toEqual([{ name: "KEEP" }]);
  });

  it("never calls a selector when the schema turns selection off", async () => {
    const md = ["| Mystery | Enigma |", "| --- | --- |", "| a | b |"].join("\n");
    const extracted = { items: [] as unknown[] };
    let called = false;
    await applyGridTables(md, invoiceSchema({ select: false }), extracted, undefined, undefined, {
      select: {
        name: "should-not-run",
        maxOptions: 80,
        async select() {
          called = true;
          throw new Error("unreachable");
        },
      },
    });
    expect(called).toBe(false);
  });
});

describe("applyGridTables — the row set it produces", () => {
  it("replaces the extracted rows with the grid's, under the default no-key mode", async () => {
    const extracted = { items: [{ name: "Widget", quantity: 2, unit_price: 10, amount: 5 }] }; // swapped
    const sourceTexts: Record<string, string[]> = {};
    const provenance: ProvenanceMap = {};
    const { report, fields } = await applyGridTables(
      INVOICE_MD,
      invoiceSchema(true),
      extracted,
      sourceTexts,
      provenance,
      { select: null },
    );
    expect(extracted.items).toEqual([
      { name: "Widget", quantity: 2, unit_price: 5, amount: 10 },
      { name: "Gadget", quantity: 1, unit_price: 5.5, amount: 5.5 },
    ]);
    expect(fields[0]!.mode).toBe("seed_rows");
    expect(fields[0]!.source).toBe("markdown");
    expect(fields[0]!.droppedLlmRows).toBe(1);
    expect(report[0]).toContain("items: 2 row(s) read from 1 markdown grid(s)");
  });

  it("keeps source_texts index-aligned with the rows it wrote", async () => {
    const extracted = { items: [] as unknown[] };
    const sourceTexts: Record<string, string[]> = { items: ["stale", "stale", "stale"] };
    await applyGridTables(INVOICE_MD, invoiceSchema(true), extracted, sourceTexts, undefined, { select: null });
    expect(sourceTexts.items).toHaveLength((extracted.items as unknown[]).length);
    expect(sourceTexts.items![0]).toContain("Widget");
  });

  it("writes per-row, per-sub-field provenance indexed the same as the rows", async () => {
    const extracted = { items: [] as unknown[] };
    const provenance: ProvenanceMap = {};
    await applyGridTables(INVOICE_MD, invoiceSchema(true), extracted, undefined, provenance, { select: null });
    const span = provenance.items!;
    expect(span.items).toHaveLength(2);
    const amount = span.items![1]!.properties!.amount!;
    expect(INVOICE_MD.slice(amount.offset, amount.offset + amount.length)).toBe("$5.50");
  });

  it("skips rows that carry nothing", async () => {
    const md = [
      "| Name | Amount |",
      "| --- | --- |",
      "| Widget | $1.00 |",
      "|  |  |",
      "| Gadget | $2.00 |",
    ].join("\n");
    const extracted = { items: [] as unknown[] };
    await applyGridTables(md, invoiceSchema(true), extracted, undefined, undefined, { select: null });
    expect(extracted.items).toHaveLength(2);
  });

  it("reads every grid in the document, not just the first", async () => {
    const md = [
      "| Name | Amount |",
      "| --- | --- |",
      "| A | $1.00 |",
      "",
      "continued",
      "",
      "| Name | Amount |",
      "| --- | --- |",
      "| B | $2.00 |",
    ].join("\n");
    const extracted = { items: [] as unknown[] };
    const { fields } = await applyGridTables(md, invoiceSchema(true), extracted, undefined, undefined, {
      select: null,
    });
    expect(extracted.items).toHaveLength(2);
    expect(fields[0]!.grids).toEqual(["md-t0", "md-t1"]);
  });

  it("prefers the geometry-backed spine and stamps the chunk rung", async () => {
    const units = assignUnitIds(
      (
        [
          [1, 1, "Name"],
          [1, 2, "Amount"],
          [2, 1, "Widget"],
          [2, 2, "$10.00"],
        ] as Array<[number, number, string]>
      ).map(([row, col, text]): ParseUnitDraft => ({
        page: 1,
        text,
        role: "table_cell",
        table: { tableId: "p1-t0", row, col },
        bbox: { x: 0.1 * col, y: 0.3, w: 0.05, h: 0.01 },
      })),
    );
    const extracted = { items: [] as unknown[] };
    const provenance: ProvenanceMap = {};
    const { fields } = await applyGridTables(INVOICE_MD, invoiceSchema(true), extracted, undefined, provenance, {
      chunks: units,
      select: null,
    });
    expect(fields[0]!.source).toBe("cells");
    expect(provenance.items!.items![0]!.properties!.amount!.resolution).toBe("chunk");
    expect(provenance.items!.items![0]!.properties!.amount!.bbox).toBeDefined();
  });
});

describe("applyGridTables — a partial column map", () => {
  // The document words two of the four columns in ways the schema never
  // declared, so only `name` and `amount` map. Measured on invoice line items:
  // replacing a complete extraction with a two-column row set is a regression,
  // and these two branches are what stop it.
  const PARTIAL_MD = [
    "| Name | Hours | Rate | Amount |",
    "| --- | --- | --- | --- |",
    "| Workshop | 8 | $200.00 | $1,600.00 |",
    "| Refinement | 12 | $200.00 | $2,400.00 |",
  ].join("\n");

  it("joins by position when both readings found the same number of rows", async () => {
    const extracted = {
      items: [
        { name: "Workshop", quantity: 8, unit_price: 200, amount: 1 },
        { name: "Refinement", quantity: 12, unit_price: 200, amount: 2 },
      ],
    };
    const { fields } = await applyGridTables(PARTIAL_MD, invoiceSchema(true), extracted, undefined, undefined, {
      select: null,
    });
    expect(fields[0]!.join).toBe("positional");
    // The grid corrects what it read; the extraction keeps what no column
    // mapped to.
    expect(extracted.items).toEqual([
      { name: "Workshop", quantity: 8, unit_price: 200, amount: 1600 },
      { name: "Refinement", quantity: 12, unit_price: 200, amount: 2400 },
    ]);
  });

  it("refuses a positional join unless a column agrees on every row", async () => {
    // A reconciled array has no reason to come back in the order one table
    // prints. Pairing row 1's values with row 3's because both sides happen to
    // have two of something is exactly the failure cell addressing exists to
    // remove.
    // One row agrees, the other does not: a majority is not evidence, because
    // the unverified row is exactly the one the join would overwrite.
    const extracted = {
      items: [
        { name: "Workshop", quantity: 8, unit_price: 99, amount: 99 },
        { name: "And another", quantity: 98, unit_price: 98, amount: 98 },
      ],
    };
    const before = JSON.parse(JSON.stringify(extracted));
    const { report, fields } = await applyGridTables(
      PARTIAL_MD,
      invoiceSchema(true),
      extracted,
      undefined,
      undefined,
      { select: null },
    );
    expect(fields).toHaveLength(0);
    expect(extracted).toEqual(before);
    expect(report.join(" ")).toContain("could not be joined");
  });

  it("leaves the field to extraction when the counts disagree and the map is partial", async () => {
    const extracted = { items: [{ name: "Workshop", quantity: 8, unit_price: 200, amount: 1600 }] };
    const { report, fields } = await applyGridTables(
      PARTIAL_MD,
      invoiceSchema(true),
      extracted,
      undefined,
      undefined,
      { select: null },
    );
    expect(fields).toHaveLength(0);
    expect(extracted.items).toEqual([{ name: "Workshop", quantity: 8, unit_price: 200, amount: 1600 }]);
    expect(report.join(" ")).toContain("left to extraction");
  });

  it("stands alone when it named every sub-field", async () => {
    const md = [
      "| Name | Quantity | Unit Price | Amount |",
      "| --- | --- | --- | --- |",
      "| Workshop | 8 | $200.00 | $1,600.00 |",
      "| Refinement | 12 | $200.00 | $2,400.00 |",
    ].join("\n");
    const extracted = { items: [{ name: "WRONG" }] };
    const { fields } = await applyGridTables(md, invoiceSchema(true), extracted, undefined, undefined, {
      select: null,
    });
    expect(fields[0]!.join).toBe("standalone");
    expect(extracted.items).toHaveLength(2);
  });
});

describe("applyGridTables — vocabulary rows and the union merge", () => {
  const schema = {
    name: "t",
    fields: {
      coverages: {
        type: "array",
        hints: { element_key: "coverage" },
        grid: true,
        items: {
          type: "object",
          properties: {
            coverage: { type: "mapping", mappings: { alpha: ["Alpha Coverage"], beta: ["Beta Coverage"] } },
            premium: { type: "number" },
            limit: { type: "number" },
          },
        },
      },
    },
  };
  const md = [
    "| Coverage | Premium | Limit |",
    "| --- | --- | --- |",
    "| Alpha Coverage | $100 | $1,000 |",
    "| TOTAL | $100 | |",
  ].join("\n");

  it("defaults to union when a row key with a vocabulary exists", async () => {
    const extracted = { coverages: [{ coverage: "beta", premium: 42, limit: 500 }] };
    const { fields } = await applyGridTables(md, schema, extracted, undefined, undefined, { select: null });
    expect(fields[0]!.mode).toBe("union");
    // The grid's row wins; the extraction's unrelated row survives.
    expect(extracted.coverages).toEqual([
      { coverage: "alpha", premium: 100, limit: 1000 },
      { coverage: "beta", premium: 42, limit: 500 },
    ]);
    expect(fields[0]!.keptLlmRows).toBe(1);
  });

  it("drops a row the vocabulary cannot name — a total line is not an element", async () => {
    const extracted = { coverages: [] as unknown[] };
    await applyGridTables(md, schema, extracted, undefined, undefined, { select: null });
    expect(extracted.coverages).toHaveLength(1);
    expect((extracted.coverages as Array<{ coverage: string }>)[0]!.coverage).toBe("alpha");
  });

  it("lets the grid correct a value the extraction got wrong, keeping the extraction's extras", async () => {
    const extracted = {
      coverages: [{ coverage: "alpha", premium: 999, limit: 1000, note: "from the LLM" }],
    };
    await applyGridTables(md, schema, extracted, undefined, undefined, { select: null });
    expect(extracted.coverages).toEqual([{ coverage: "alpha", premium: 100, limit: 1000, note: "from the LLM" }]);
  });

  it("honours an explicit seed_rows override", async () => {
    const seeded = {
      ...schema,
      fields: { coverages: { ...schema.fields.coverages, grid: { mode: "seed_rows" } } },
    };
    const extracted = { coverages: [{ coverage: "beta", premium: 42 }] };
    await applyGridTables(md, seeded, extracted, undefined, undefined, { select: null });
    expect(extracted.coverages).toEqual([{ coverage: "alpha", premium: 100, limit: 1000 }]);
  });
});

describe("the stages that run after grid extraction", () => {
  it("lets a `forms:` grammar still win on a field that declares both", async () => {
    // Grid runs inside the pipeline; `applyFormTables` runs after it in
    // `extractFields`. The more specific statement — a hand-authored grammar —
    // is the one that survives.
    const schema = {
      name: "t",
      fields: {
        items: { type: "array", grid: true, hints: { element_key: "name" }, items: { type: "object", properties: ITEM_FIELDS } },
      },
      forms: [
        {
          id: "f",
          anchor: "Name Quantity",
          field: "items",
          row: { pattern: "(?<n>Widget)\\s+(?<a>\\d+)", require: ["n"] },
          set: { name: "{n}", amount: { money: "{a}" } },
        },
      ],
    };
    const extracted: Record<string, unknown> = {};
    const sourceTexts: Record<string, string[]> = {};
    await applyGridTables(INVOICE_MD, schema, extracted, sourceTexts, undefined, { select: null });
    expect(extracted.items).toHaveLength(2);
    const formReport = applyFormTables(INVOICE_MD, schema, extracted, sourceTexts);
    expect(formReport).toHaveLength(1);
    expect((extracted.items as Array<{ name: string }>)[0]!.name).toBe("Widget");
    expect(sourceTexts.items).toHaveLength((extracted.items as unknown[]).length);
  });
});

describe("applyGridTables — grid.exclude", () => {
  it("never claims an excluded sub-field, leaving the extraction's value standing", async () => {
    const md = [
      "| Ref | Name | Quantity | Unit Price | Amount |",
      "| --- | --- | --- | --- | --- |",
      "| A | Widget | 2 | $5.00 | $10.00 |",
    ].join("\n");
    const schema = {
      name: "t",
      fields: {
        items: {
          type: "array",
          // `name` is printed as a short code here and resolved from a list
          // elsewhere in the document, so the cell is not the answer.
          grid: { exclude: ["name"] },
          items: { type: "object", properties: ITEM_FIELDS },
        },
      },
    };
    // The extraction agrees on quantity, which is what lets the two readings
    // be joined by position at all.
    const extracted = { items: [{ name: "Resolved Widget Co", quantity: 2, unit_price: 9, amount: 9 }] };
    const { fields } = await applyGridTables(md, schema, extracted, undefined, undefined, { select: null });
    expect(fields[0]!.mappedColumns).not.toContain("name");
    expect(fields[0]!.join).toBe("positional");
    expect(extracted.items).toEqual([
      { name: "Resolved Widget Co", quantity: 2, unit_price: 5, amount: 10 },
    ]);
  });
});

describe("applyGridTables — the grid only claims what the declared type accepts", () => {
  const DATE_FIELDS = {
    reference: { type: "string" },
    starts: { type: "date" },
    amount: { type: "number" },
  };
  const schema = (normalize?: string) => ({
    name: "t",
    fields: {
      rows: {
        type: "array",
        grid: true,
        items: {
          type: "object",
          properties: {
            ...DATE_FIELDS,
            ...(normalize ? { starts: { type: "date", normalize } } : {}),
          },
        },
      },
    },
  });
  const md = [
    "| Reference | Starts | Amount |",
    "| --- | --- | --- |",
    "| R-1 | 09/06/2025 | $100 |",
    "| R-2 | 09/07/2025 | $200 |",
  ].join("\n");

  it("leaves a date the declared type cannot represent to extraction", async () => {
    // The extraction resolved `09/06/2025` with locale context the grid does
    // not have. Overwriting `2025-09-06` with the raw cell is confidently
    // wrong — measured as the largest single cause of grid extraction scoring
    // below plain extraction on the corpus.
    const extracted = {
      rows: [
        { reference: "R-1", starts: "2025-09-06", amount: 1 },
        { reference: "R-2", starts: "2025-09-07", amount: 2 },
      ],
    };
    const { report } = await applyGridTables(md, schema(), extracted, undefined, undefined, { select: null });
    expect(extracted.rows).toEqual([
      { reference: "R-1", starts: "2025-09-06", amount: 100 },
      { reference: "R-2", starts: "2025-09-07", amount: 200 },
    ]);
    expect(report.join(" ")).toContain("left starts to extraction");
  });

  it("reads the same column once the schema declares how to normalize it", async () => {
    const extracted = {
      rows: [
        { reference: "R-1", starts: "1999-01-01", amount: 1 },
        { reference: "R-2", starts: "1999-01-02", amount: 2 },
      ],
    };
    await applyGridTables(md, schema("iso8601"), extracted, undefined, undefined, { select: null });
    expect(extracted.rows).toEqual([
      { reference: "R-1", starts: "2025-09-06", amount: 100 },
      { reference: "R-2", starts: "2025-09-07", amount: 200 },
    ]);
  });
});
