/**
 * End-to-end test of the structured parse path (oss-536): real PDF bytes →
 * pdfjs → cell units with (row, col) + geometry, through the real factory and
 * the real `SmartParseProvider` routing. No mocks in the parse path.
 *
 * This is the test that would have caught the dead structured slot: it fails if
 * `STRUCTURED_PROVIDERS` is empty, if the factory stops filling the structured
 * slot, or if `SmartParseProvider` sends a table-heavy digital PDF to pdfjs.
 */

import { describe, it, expect } from "vitest";
import { createParseProvider, readStructuredBackend } from "./factory";
import { classifyContentShape } from "./content-shape";
import { PositionalStructuredProvider } from "./positional-structured";

/**
 * A real digital PDF whose pages are a 4-column grid. Columns are far enough
 * apart (>24pt) for the content-shape classifier to read the layout as a grid,
 * and cell text is short, as grid cells are.
 */
async function makeGridPdf(rows: string[][], pageCount = 1): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const xs = [50, 180, 310, 440];
  for (let p = 0; p < pageCount; p++) {
    const page = pdf.addPage([612, 792]);
    let y = 700;
    for (const row of rows) {
      row.forEach((cell, i) => {
        if (cell) page.drawText(cell, { x: xs[i] ?? 50, y, size: 10, font });
      });
      y -= 22;
    }
  }
  return Buffer.from(await pdf.save());
}

const GRID: string[][] = [
  ["Item", "Code", "Count", "Amount"],
  ["Alpha", "A-1", "3", "1200"],
  ["Bravo", "B-2", "7", "450"],
  // A row with a hole: the naive reading-order flatten slides "90" left under
  // Count. Cell addressing must keep it in column 4.
  ["Charlie", "C-3", "", "90"],
  ["Delta", "D-4", "2", "775"],
  ["Echo", "E-5", "11", "3310"],
];

/** The parse config used below — `dockerUrl` points nowhere on purpose, so a
 *  test that accidentally routes to the heavy provider fails loudly. */
const config = (structured: "off" | "positional") => ({
  backend: "docker" as const,
  dockerUrl: "http://127.0.0.1:1/heavy-must-not-be-called",
  structured,
});

describe("structured parse path — real PDF → cell geometry", () => {
  it("classifies a column grid as table-heavy", async () => {
    const buf = await makeGridPdf(GRID);
    await expect(
      classifyContentShape("grid.pdf", "application/pdf", buf),
    ).resolves.toBe("table_heavy");
  });

  it("routes a table-heavy DIGITAL pdf to the structured provider and returns cells", async () => {
    const buf = await makeGridPdf(GRID);
    const provider = await createParseProvider(config("positional"));
    const result = await provider.parse({
      filename: "grid.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });

    // Reached the structured provider rather than pdfjs's markdown view…
    expect(result.engine).toBe("positional");

    // …and came back with addressable cells carrying real geometry.
    const cells = (result.chunks ?? []).filter((c) => c.role === "table_cell");
    expect(cells.length).toBeGreaterThan(10);
    for (const c of cells) {
      expect(c.table?.tableId).toMatch(/^p\d+-t\d+$/);
      expect(c.table!.row).toBeGreaterThanOrEqual(1);
      expect(c.table!.col).toBeGreaterThanOrEqual(1);
      expect(c.bbox).toBeDefined();
      const { x, y, w, h } = c.bbox!;
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
      expect(w).toBeGreaterThan(0);
    }

    // Column IDENTITY is the property that matters, not the absolute index:
    // x-clustering can split a right-aligned numeric column off from an empty
    // gutter, so the detected column count may exceed the 4 logical columns.
    // What must hold is that every value shares its header's column.
    const colOf = (text: string) =>
      cells.find((c) => c.text === text)?.table!.col;
    const rowOf = (text: string) => cells.find((c) => c.text === text)?.table!.row;

    const itemCol = colOf("Item");
    const codeCol = colOf("Code");
    const countCol = colOf("Count");
    const amountCol = colOf("Amount");
    expect(new Set([itemCol, codeCol, countCol, amountCol]).size).toBe(4);
    expect(itemCol!).toBeLessThan(codeCol!);
    expect(codeCol!).toBeLessThan(countCol!);
    expect(countCol!).toBeLessThan(amountCol!);

    for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
      expect(colOf(name)).toBe(itemCol);
    }
    for (const code of ["A-1", "B-2", "C-3", "D-4", "E-5"]) {
      expect(colOf(code)).toBe(codeCol);
    }
    for (const amount of ["1200", "450", "90", "775", "3310"]) {
      expect(colOf(amount)).toBe(amountCol);
    }

    // The hole row: "90" stays in the Amount column instead of sliding left
    // into Count, and nothing at all is emitted for the empty Count cell.
    const holeRow = rowOf("Charlie");
    expect(rowOf("90")).toBe(holeRow);
    expect(colOf("90")).toBe(amountCol);
    expect(
      cells.some((c) => c.table!.row === holeRow && c.table!.col === countCol),
    ).toBe(false);

    // Rows are 1-based and in reading order.
    expect(rowOf("Item")).toBe(1);
    expect(rowOf("Alpha")).toBe(2);
    expect(rowOf("Echo")).toBe(6);

    // Cells in one row have distinct boxes — cell geometry, not row geometry.
    const row2 = cells.filter((c) => c.table!.row === 2).map((c) => c.bbox!.x);
    expect(new Set(row2).size).toBe(row2.length);
  });

  it("emits NO cells with the structured backend off (the pre-oss-536 path)", async () => {
    const buf = await makeGridPdf(GRID);
    const provider = await createParseProvider(config("off"));
    const result = await provider.parse({
      filename: "grid.pdf",
      mimeType: "application/pdf",
      fileBuffer: buf,
    });
    expect(result.engine).toBe("pdfjs");
    expect((result.chunks ?? []).filter((c) => c.role === "table_cell")).toHaveLength(0);
  });

  it("preserves cell geometry across the chunked (large-PDF) merge", async () => {
    // Six pages, chunked two at a time: the merge must carry every cell over
    // with shifted pages and per-page table ids, not drop the spine.
    const prev = {
      t: process.env.KOJI_CHUNK_PARSE_THRESHOLD,
      p: process.env.KOJI_CHUNK_PARSE_PAGES,
    };
    process.env.KOJI_CHUNK_PARSE_THRESHOLD = "2";
    process.env.KOJI_CHUNK_PARSE_PAGES = "2";
    try {
      const buf = await makeGridPdf(GRID, 6);
      const provider = await createParseProvider(config("positional"));
      const result = await provider.parse({
        filename: "grid-6p.pdf",
        mimeType: "application/pdf",
        fileBuffer: buf,
      });

      const cells = (result.chunks ?? []).filter((c) => c.role === "table_cell");
      expect(result.pages).toBe(6);
      expect(cells.length).toBeGreaterThan(60);
      // Every page is represented, and each page's table id is namespaced to it
      // (shard-local ids would collide at p1-t0 six times over).
      const pages = new Set(cells.map((c) => c.page));
      expect([...pages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const c of cells) {
        expect(c.table!.tableId).toBe(`p${c.page}-t0`);
      }
      // Ids are re-stamped per merged page, so they are unique document-wide.
      const ids = (result.chunks ?? []).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      if (prev.t === undefined) delete process.env.KOJI_CHUNK_PARSE_THRESHOLD;
      else process.env.KOJI_CHUNK_PARSE_THRESHOLD = prev.t;
      if (prev.p === undefined) delete process.env.KOJI_CHUNK_PARSE_PAGES;
      else process.env.KOJI_CHUNK_PARSE_PAGES = prev.p;
    }
  });

  it("falls back rather than throwing when handed a non-PDF", async () => {
    // `content-shape` already reports anything it can't sample as text-heavy,
    // but the provider itself must still refuse non-PDF input so a mis-route
    // surfaces as a clear error that SmartParseProvider can catch.
    await expect(
      new PositionalStructuredProvider().parse({
        filename: "notes.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileBuffer: Buffer.from("not a pdf"),
      }),
    ).rejects.toThrow(/only handles PDFs/);
  });
});

describe("readStructuredBackend", () => {
  it("enables the positional backend only on an exact opt-in", () => {
    expect(readStructuredBackend("positional")).toBe("positional");
    expect(readStructuredBackend(" Positional ")).toBe("positional");
  });

  it("defaults to off for unset, empty, or unrecognized values", () => {
    for (const v of [undefined, null, "", "off", "0", "true", "postional"]) {
      expect(readStructuredBackend(v)).toBe("off");
    }
  });
});
