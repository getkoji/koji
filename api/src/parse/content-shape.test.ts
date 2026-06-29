/**
 * Content-shape classifier tests (oss-274 / PB-10).
 *
 * `scoreTableDensity` is the pure geometric heuristic doc-type routing relies
 * on. We test it with synthetic positioned runs (no pdfjs, no real PDF) so the
 * table-vs-prose decision is deterministic. `classifyContentShape`'s
 * non-PDF/image fallback is tested directly (it short-circuits before pdfjs).
 */
import { describe, it, expect } from "vitest";
import {
  scoreTableDensity,
  classifyContentShape,
  type ShapeItem,
} from "./content-shape";

/** Build a grid: `rows` lines × `cols` columns of short cells, evenly spaced. */
function grid(rows: number, cols: number): ShapeItem[] {
  const items: ShapeItem[] = [];
  for (let r = 0; r < rows; r++) {
    const y = 700 - r * 14;
    for (let c = 0; c < cols; c++) {
      // Columns 100pt apart, each cell ~30pt wide → ~70pt gap > columnGap(24).
      items.push({ str: `${1000 + r * cols + c}`, x: 60 + c * 100, y, w: 30 });
    }
  }
  return items;
}

/** Build prose: `rows` lines, each a single wide run of sentence text. */
function prose(rows: number): ShapeItem[] {
  const items: ShapeItem[] = [];
  for (let r = 0; r < rows; r++) {
    items.push({
      str: "This is a full sentence of running prose that fills the line.",
      x: 60,
      y: 700 - r * 14,
      w: 460,
    });
  }
  return items;
}

describe("scoreTableDensity", () => {
  it("classifies a clean multi-column grid as table_heavy", () => {
    expect(scoreTableDensity(grid(20, 4))).toBe("table_heavy");
  });

  it("classifies running prose as text_heavy", () => {
    // Prose lines are single runs (< minRunsPerRow), so none judge as tabular.
    expect(scoreTableDensity(prose(20))).toBe("text_heavy");
  });

  it("returns text_heavy on too little signal", () => {
    expect(scoreTableDensity(grid(1, 3))).toBe("text_heavy");
    expect(scoreTableDensity([])).toBe("text_heavy");
  });

  it("treats a two-column label/value layout as text_heavy (below column threshold)", () => {
    // Two columns only — a key/value form, not a grid. Default min is 3 columns.
    expect(scoreTableDensity(grid(20, 2))).toBe("text_heavy");
  });

  it("does not call long-sentence cells tabular even across columns", () => {
    // 4 "columns" but every cell is a long sentence → avgCellLen > 40 → prose.
    const items: ShapeItem[] = [];
    for (let r = 0; r < 20; r++) {
      const y = 700 - r * 14;
      for (let c = 0; c < 4; c++) {
        items.push({
          str: "a fairly long descriptive sentence cell value here indeed",
          x: 60 + c * 140,
          y,
          w: 60,
        });
      }
    }
    expect(scoreTableDensity(items)).toBe("text_heavy");
  });

  it("honors a stricter column threshold via options", () => {
    const items = grid(20, 4);
    expect(scoreTableDensity(items, { minColumnsForTabularRow: 5 })).toBe("text_heavy");
  });
});

describe("classifyContentShape — non-geometric fallbacks", () => {
  it("returns text_heavy for images (no cheap pre-parse geometry)", async () => {
    expect(await classifyContentShape("scan.jpg", "image/jpeg", Buffer.alloc(4))).toBe(
      "text_heavy",
    );
    expect(await classifyContentShape("p.png", "application/octet-stream", Buffer.alloc(4))).toBe(
      "text_heavy",
    );
  });

  it("returns text_heavy for non-PDF formats (docx/html)", async () => {
    expect(await classifyContentShape("report.docx", "application/vnd.x", Buffer.alloc(4))).toBe(
      "text_heavy",
    );
    expect(await classifyContentShape("page.html", "text/html", Buffer.alloc(4))).toBe(
      "text_heavy",
    );
  });

  it("returns text_heavy when the PDF bytes are unparseable", async () => {
    // Garbage that isn't a real PDF → pdfjs throws → prose-safe default.
    expect(
      await classifyContentShape("broken.pdf", "application/pdf", Buffer.from("not a pdf")),
    ).toBe("text_heavy");
  });
});
