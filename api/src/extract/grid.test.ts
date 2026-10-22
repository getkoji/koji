/**
 * Grid extraction (D1) — the 2D view, from both sources.
 *
 * The assertions here are about *identity*, never about absolute column
 * counts: the positional path's `detectColumns` over-splits, so a grid is
 * trusted to say "this value and this header share an index" and nothing more.
 */
import { describe, it, expect } from "vitest";

import {
  buildGrids,
  cellAt,
  columnFill,
  dataRows,
  gridsFromMarkdown,
  gridsFromSpine,
  headerCells,
} from "./grid";
import { assignUnitIds, type ParseUnitDraft } from "../parse/chunk";

function cells(drafts: Array<[number, number, string, boolean?]>, tableId = "p1-t0") {
  const out: ParseUnitDraft[] = drafts.map(([row, col, text, withBox]) => ({
    page: 1,
    text,
    role: "table_cell" as const,
    table: { tableId, row, col },
    ...(withBox === false ? {} : { bbox: { x: 0.1 * col, y: 0.1 * row, w: 0.08, h: 0.02 } }),
  }));
  return assignUnitIds(out);
}

describe("gridsFromMarkdown", () => {
  it("reads a GFM pipe table into a dense grid with the separator as the header boundary", () => {
    const md = [
      "Some prose.",
      "",
      "| Item | Qty | Amount |",
      "| --- | --- | --- |",
      "| Widget | 2 | $10.00 |",
      "| Gadget | 1 | $5.50 |",
      "",
      "More prose.",
    ].join("\n");

    const grids = gridsFromMarkdown(md);
    expect(grids).toHaveLength(1);
    const g = grids[0]!;
    expect(g.source).toBe("markdown");
    expect(g.columnCount).toBe(3);
    expect(g.headerRow).toBe(0);
    expect(headerCells(g).map((c) => c.text)).toEqual(["Item", "Qty", "Amount"]);
    expect(dataRows(g).map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Widget", "2", "$10.00"],
      ["Gadget", "1", "$5.50"],
    ]);
  });

  it("gives every non-empty cell an exact offset into the markdown", () => {
    const md = ["| Item | Amount |", "| --- | --- |", "| Widget | $10.00 |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    const cell = cellAt(g, 1, 2)!;
    expect(cell.text).toBe("$10.00");
    expect(md.slice(cell.offset!, cell.offset! + cell.length!)).toBe("$10.00");
  });

  it("preserves blank slots so a short row doesn't slide under the wrong header", () => {
    const md = ["| A | B | C |", "| --- | --- | --- |", "| 1 |  | 3 |", "| 4 | 5 | 6 |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    expect(dataRows(g)[0]!.cells.map((c) => c.text)).toEqual(["1", "", "3"]);
    expect(cellAt(g, 1, 3)!.text).toBe("3");
  });

  it("does not split on an escaped pipe", () => {
    const md = ["| Label | Note |", "| --- | --- |", "| A \\| B | ok |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    expect(dataRows(g)[0]!.cells.map((c) => c.text)).toEqual(["A | B", "ok"]);
  });

  it("treats the first row as the header when the table has no separator", () => {
    const md = ["| A | B |", "| 1 | 2 |"].join("\n");
    const g = gridsFromMarkdown(md)[0]!;
    expect(g.headerRow).toBe(0);
    expect(dataRows(g)).toHaveLength(1);
  });

  it("ignores a single pipe line — one row is formatting, not a grid", () => {
    expect(gridsFromMarkdown("| just one |")).toHaveLength(0);
  });

  it("finds every table in a document", () => {
    const md = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "text",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    expect(gridsFromMarkdown(md).map((g) => g.id)).toEqual(["md-t0", "md-t1"]);
  });
});

describe("gridsFromSpine", () => {
  it("rebuilds the grid from (row, col) and carries each cell's bbox", () => {
    const units = cells([
      [1, 1, "Item"],
      [1, 2, "Amount"],
      [2, 1, "Widget"],
      [2, 2, "$10.00"],
    ]);
    const g = gridsFromSpine(units)[0]!;
    expect(g.source).toBe("cells");
    expect(g.id).toBe("p1-t0");
    expect(g.columnCount).toBe(2);
    const amount = cellAt(g, 1, 2)!;
    expect(amount.text).toBe("$10.00");
    expect(amount.bbox).toEqual({ x: 0.2, y: 0.2, w: 0.08, h: 0.02 });
    expect(amount.page).toBe(1);
  });

  it("restores the blank slots the canonicalizer dropped", () => {
    // The cell canonicalizer emits no unit for a blank slot; the grid must put
    // the slot back from the surviving coordinates or col 3 slides into col 2.
    const units = cells([
      [1, 1, "A"],
      [1, 2, "B"],
      [1, 3, "C"],
      [2, 1, "1"],
      [2, 3, "3"],
    ]);
    const g = gridsFromSpine(units)[0]!;
    expect(dataRows(g)[0]!.cells.map((c) => c.text)).toEqual(["1", "", "3"]);
  });

  it("tolerates the positional path's over-split: phantom columns are empty, identity holds", () => {
    // 6 logical columns reported as 9, with 3 phantoms that never carry text.
    const units = cells([
      [1, 1, "Item"],
      [1, 4, "Qty"],
      [1, 7, "Amount"],
      [2, 1, "Widget"],
      [2, 4, "2"],
      [2, 7, "$10.00"],
      [3, 1, "Gadget"],
      [3, 4, "1"],
      [3, 7, "$5.50"],
    ]);
    const g = gridsFromSpine(units)[0]!;
    expect(g.columnCount).toBe(7); // NOT the logical 3 — never assert on this
    // What holds: every value shares its header's index.
    expect(columnFill(g, 7)).toBe(2);
    expect(columnFill(g, 2)).toBe(0);
    expect(cellAt(g, 1, 7)!.text).toBe("$10.00");
    expect(cellAt(g, 2, 7)!.text).toBe("$5.50");
  });

  it("separates tables by tableId and keeps document order", () => {
    const units = [...cells([[1, 1, "A"], [2, 1, "1"]], "p1-t0"), ...cells([[1, 1, "B"], [2, 1, "2"]], "p2-t0")];
    expect(gridsFromSpine(units).map((g) => g.id)).toEqual(["p1-t0", "p2-t0"]);
  });

  it("ignores non-table units", () => {
    const units = assignUnitIds([
      { page: 1, text: "A heading", role: "heading" },
      { page: 1, text: "Some prose", role: "paragraph" },
    ]);
    expect(gridsFromSpine(units)).toHaveLength(0);
  });

  it("returns nothing for an absent spine", () => {
    expect(gridsFromSpine(undefined)).toHaveLength(0);
  });
});

describe("buildGrids", () => {
  it("prefers the geometry-backed spine over its own markdown projection", () => {
    const md = ["| Item | Amount |", "| --- | --- |", "| Widget | $10.00 |"].join("\n");
    const units = cells([
      [1, 1, "Item"],
      [1, 2, "Amount"],
      [2, 1, "Widget"],
      [2, 2, "$10.00"],
    ]);
    const grids = buildGrids(md, units);
    expect(grids).toHaveLength(1);
    expect(grids[0]!.source).toBe("cells");
    expect(cellAt(grids[0]!, 1, 2)!.bbox).toBeDefined();
  });

  it("falls back to markdown when the spine carries no cells", () => {
    const md = ["| Item | Amount |", "| --- | --- |", "| Widget | $10.00 |"].join("\n");
    const lines = assignUnitIds([{ page: 1, text: "not a table", role: "line" }]);
    expect(buildGrids(md, lines)[0]!.source).toBe("markdown");
    expect(buildGrids(md)[0]!.source).toBe("markdown");
  });
});

describe("cellAt", () => {
  it("returns undefined outside the grid rather than throwing", () => {
    const g = gridsFromMarkdown(["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"))[0]!;
    expect(cellAt(g, 99, 1)).toBeUndefined();
    expect(cellAt(g, 1, 99)).toBeUndefined();
  });
});
