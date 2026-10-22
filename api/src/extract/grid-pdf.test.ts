/**
 * Track D end-to-end on a REAL PDF: bytes → pdfjs geometry → cell units →
 * grid → column identity → row identity → deterministic read, with no mocks
 * anywhere in the chain and no model call at any step.
 *
 * This is the test that proves the claim the track is built on. The grid is
 * written with a hole — one row has no value in the third column — which is
 * precisely the shape that breaks a reading-order flatten: the surviving value
 * slides left and is read as the missing column's. Addressing by (row, col)
 * cannot make that mistake, and the assertion below is exactly that.
 *
 * Set `KOJI_GRID_PDF_DUMP=1` to print the (row, col, bbox, value) tuples the
 * read actually produced.
 */

import { describe, it, expect } from "vitest";

import { PositionalStructuredProvider } from "../parse/positional-structured";
import { buildGrids, cellAt, dataRows, headerCells } from "./grid";
import { identifyColumns, identifyRows } from "./grid-identity";
import { applyGridTables, readGridRow } from "./grid-tables";
import type { ProvenanceMap } from "./provenance";

/** A real digital PDF laying the rows out as a 4-column grid. */
async function makeGridPdf(rows: string[][]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const xs = [50, 180, 310, 440];
  const page = pdf.addPage([612, 792]);
  let y = 700;
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (cell) page.drawText(cell, { x: xs[i] ?? 50, y, size: 10, font });
    });
    y -= 22;
  }
  return Buffer.from(await pdf.save());
}

const ROWS: string[][] = [
  ["Item", "Code", "Count", "Amount"],
  ["Alpha", "A-1", "3", "1200"],
  ["Bravo", "B-2", "7", "450"],
  // The hole. A flatten slides "90" under Count; addressing keeps it in Amount.
  ["Charlie", "C-3", "", "90"],
  ["Delta", "D-4", "2", "775"],
];

const ITEM_PROPS = {
  item: { type: "string" },
  code: { type: "string" },
  count: { type: "number" },
  amount: { type: "number" },
};

const SCHEMA = {
  name: "grid_e2e",
  fields: {
    lines: {
      type: "array",
      grid: true,
      items: { type: "object", properties: ITEM_PROPS },
    },
  },
};

describe("Track D on a real PDF — cells, identity, deterministic read", () => {
  it("reads every (row, col) with exact geometry and never slides a value into a hole", async () => {
    const buf = await makeGridPdf(ROWS);
    const parsed = await new PositionalStructuredProvider().parse({
      filename: "schedule.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });
    expect(parsed.engine).toBe("positional");

    // D1 — the grid, straight off the spine's table cells.
    const grids = buildGrids(parsed.markdown, parsed.chunks);
    expect(grids).toHaveLength(1);
    const grid = grids[0]!;
    expect(grid.source).toBe("cells");
    // The physical column count is NOT the logical 4 — x-clustering over-splits.
    // Nothing below depends on it.
    expect(grid.columnCount).toBeGreaterThanOrEqual(4);
    expect(headerCells(grid).filter((c) => c.text).map((c) => c.text)).toEqual([
      "Item",
      "Code",
      "Count",
      "Amount",
    ]);
    expect(dataRows(grid)).toHaveLength(4);

    // D3 — column identity, from the schema's sub-field names. No model.
    const columns = await identifyColumns(grid, ITEM_PROPS, { select: null });
    expect([...columns.byField.keys()].sort()).toEqual(["amount", "code", "count", "item"]);
    expect(columns.selectCalls).toBe(0);

    // D2 — no element vocabulary on this schema, so rows are positional.
    const rowMap = await identifyRows(grid, [], columns.byField.get("item"), { select: null });
    expect(rowMap.rows.map((r) => r.via)).toEqual(["position", "position", "position", "position"]);

    // D4 — the read. Every value is a cell's text; every span is a real box.
    const tuples: Array<{ row: number; col: number; field: string; value: unknown; bbox: unknown }> = [];
    const reads = rowMap.rows.map((identity) => {
      const read = readGridRow(grid, identity.rowIndex, columns, ITEM_PROPS);
      for (const [field, col] of columns.byField) {
        const cell = cellAt(grid, identity.rowIndex, col);
        tuples.push({
          row: identity.rowIndex + 1,
          col,
          field,
          value: read.values[field],
          bbox: cell?.bbox ?? null,
        });
      }
      return read;
    });

    if (process.env.KOJI_GRID_PDF_DUMP) {
      console.log(`\nreal PDF → ${parsed.chunks?.filter((c) => c.role === "table_cell").length} cells, ` +
        `grid ${grid.id} (${grid.rows.length}x${grid.columnCount}), source=${grid.source}`);
      for (const t of tuples) {
        const b = t.bbox as { x: number; y: number; w: number; h: number } | null;
        const box = b
          ? `bbox=(${b.x.toFixed(4)}, ${b.y.toFixed(4)}, ${b.w.toFixed(4)}, ${b.h.toFixed(4)})`
          : "bbox=none";
        console.log(
          `  row=${t.row} col=${t.col} ${box} ${t.field}=${JSON.stringify(t.value)}`,
        );
      }
    }

    expect(reads.map((r) => r.values)).toEqual([
      { item: "Alpha", code: "A-1", count: 3, amount: 1200 },
      { item: "Bravo", code: "B-2", count: 7, amount: 450 },
      // The hole: count is null and 90 stayed in amount.
      { item: "Charlie", code: "C-3", count: null, amount: 90 },
      { item: "Delta", code: "D-4", count: 2, amount: 775 },
    ]);

    // A cell's box must not reach into the next column. pdfjs interleaves
    // synthetic whitespace runs between text runs that are as wide as the gap
    // they span, so before they were excluded from the union a one-glyph
    // "3" carried a 130pt box covering most of the Amount column — a
    // highlight pointing at empty paper on the one path whose value is that
    // its geometry is exact.
    for (const read of reads) {
      const count = read.spans.count;
      const amount = read.spans.amount;
      if (!count || !amount) continue;
      expect(count.bbox!.x + count.bbox!.w).toBeLessThan(amount.bbox!.x);
      // One or two digits at 10pt on a 612pt page is ~1-2% of the width.
      expect(count.bbox!.w).toBeLessThan(0.03);
    }

    // Every non-null value carries the exact box of the cell it came from.
    for (const read of reads) {
      for (const [field, value] of Object.entries(read.values)) {
        const span = read.spans[field];
        if (value === null) {
          expect(span).toBeNull();
          continue;
        }
        expect(span!.resolution).toBe("chunk");
        const { x, y, w, h } = span!.bbox!;
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
        expect(x + w).toBeLessThanOrEqual(1);
        expect(y + h).toBeLessThanOrEqual(1);
      }
    }
  }, 30_000);

  it("drives the whole stage from the parse result, with no model and no extracted rows", async () => {
    const buf = await makeGridPdf(ROWS);
    const parsed = await new PositionalStructuredProvider().parse({
      filename: "schedule.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });

    const extracted: Record<string, unknown> = {};
    const sourceTexts: Record<string, string[]> = {};
    const provenance: ProvenanceMap = {};
    const { report, fields } = await applyGridTables(
      parsed.markdown,
      SCHEMA,
      extracted,
      sourceTexts,
      provenance,
      { chunks: parsed.chunks, select: null },
    );

    expect(fields[0]!.source).toBe("cells");
    expect(fields[0]!.selectCalls).toBe(0);
    expect(extracted.lines).toHaveLength(4);
    expect((extracted.lines as Array<{ amount: number }>)[2]!.amount).toBe(90);
    expect(sourceTexts.lines).toHaveLength(4);
    expect(provenance.lines!.items![2]!.properties!.amount!.bbox).toBeDefined();
    expect(report[0]).toContain("lines: 4 row(s) read from 1 cells grid(s)");
  }, 30_000);
});
