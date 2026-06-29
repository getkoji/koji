import { describe, it, expect } from "vitest";
import {
  PositionalChunkCanonicalizer,
  reconstructTable,
} from "./positional-chunks";
import {
  buildLines,
  type ParsedPage,
  type TextItem,
} from "./spatial-to-markdown";

// US Letter at pdfjs scale 1.
const PAGE_W = 612;
const PAGE_H = 792;

/** Build a text item at (x, y) with width derived from text length. */
function item(text: string, x: number, y: number, fontSize = 12): TextItem {
  return {
    text,
    x,
    y,
    width: text.length * fontSize * 0.6,
    height: fontSize * 1.2,
    fontName: "Helvetica",
    fontSize,
  };
}

function page(items: TextItem[], pageNum = 1): ParsedPage {
  return {
    pageNum,
    width: PAGE_W,
    height: PAGE_H,
    text: items.map((i) => i.text).join(" "),
    textItems: items,
  };
}

// ---------------------------------------------------------------------------
// A multi-column dec-page-style table with a GAP row — the row that breaks
// naive reading-order serialization (the surviving value slides under the
// wrong header). Three columns at fixed x; the "Umbrella" row has no Limit.
//
//   Coverage      Limit          Premium    (x: 72 / 300 / 450)
//   Liability     $1,000,000     $5,000
//   Property      $500,000       $2,500
//   Umbrella                     $1,200     <- Limit cell missing
// ---------------------------------------------------------------------------
const COL_COVERAGE = 72;
const COL_LIMIT = 300;
const COL_PREMIUM = 450;

const tableItems: TextItem[] = [
  item("Coverage", COL_COVERAGE, 100),
  item("Limit", COL_LIMIT, 100),
  item("Premium", COL_PREMIUM, 100),

  item("Liability", COL_COVERAGE, 130),
  item("$1,000,000", COL_LIMIT, 130),
  item("$5,000", COL_PREMIUM, 130),

  item("Property", COL_COVERAGE, 160),
  item("$500,000", COL_LIMIT, 160),
  item("$2,500", COL_PREMIUM, 160),

  item("Umbrella", COL_COVERAGE, 190),
  // no Limit cell for this row
  item("$1,200", COL_PREMIUM, 190),
];

describe("reconstructTable (x-clustering column association)", () => {
  const lines = buildLines(tableItems, PAGE_H);
  const table = reconstructTable(lines, { width: PAGE_W, height: PAGE_H });

  it("detects exactly three columns", () => {
    expect(table.columns).toHaveLength(3);
  });

  it("places header cells under the right columns", () => {
    expect(table.rows[0]!.cells).toEqual(["Coverage", "Limit", "Premium"]);
  });

  it("keeps values under their own header on full rows", () => {
    expect(table.rows[1]!.cells).toEqual([
      "Liability",
      "$1,000,000",
      "$5,000",
    ]);
    expect(table.rows[2]!.cells).toEqual(["Property", "$500,000", "$2,500"]);
  });

  it("keeps the gap-row value under Premium, NOT shifted into Limit", () => {
    // The whole point: $1,200 is a Premium, and the Limit cell stays blank
    // instead of $1,200 sliding left under the Limit header.
    expect(table.rows[3]!.cells).toEqual(["Umbrella", "", "$1,200"]);
  });

  it("attaches a normalized row bbox within the unit square", () => {
    for (const row of table.rows) {
      expect(row.bbox).toBeDefined();
      const { x, y, w, h } = row.bbox!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });
});

describe("PositionalChunkCanonicalizer — table page", () => {
  const chunks = new PositionalChunkCanonicalizer().toChunks([page(tableItems)]);

  it("emits one chunk per table row, in reading order", () => {
    expect(chunks.map((c) => c.text)).toEqual([
      "| Coverage | Limit | Premium |",
      "| Liability | $1,000,000 | $5,000 |",
      "| Property | $500,000 | $2,500 |",
      "| Umbrella |  | $1,200 |",
    ]);
  });

  it("preserves column association in the chunk text (gap row)", () => {
    const gapRow = chunks[3]!.text;
    // Three cells: Premium populated, Limit blank — association survives into
    // the chunk stream the LLM will read.
    const cells = gapRow.split("|").slice(1, -1).map((c) => c.trim());
    expect(cells).toEqual(["Umbrella", "", "$1,200"]);
  });

  it("populates bbox on every chunk, within the unit square", () => {
    for (const c of chunks) {
      expect(c.page).toBe(1);
      expect(c.bbox).toBeDefined();
      const { x, y, w, h } = c.bbox!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });
});

describe("PositionalChunkCanonicalizer — non-table content", () => {
  it("emits one bbox-carrying chunk per plain line", () => {
    const items = [
      item("Certificate of Insurance", 72, 100, 18),
      item("This certifies that the policy below is in force.", 72, 140),
    ];
    const chunks = new PositionalChunkCanonicalizer().toChunks([page(items)]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain("Certificate of Insurance");
    expect(chunks[1]!.text).toContain("policy below is in force");
    for (const c of chunks) expect(c.bbox).toBeDefined();
  });

  it("carries 1-based page numbers across multiple pages", () => {
    const chunks = new PositionalChunkCanonicalizer().toChunks([
      page([item("Page one body", 72, 100)], 1),
      page([item("Page two body", 72, 100)], 2),
    ]);
    expect(chunks.map((c) => c.page)).toEqual([1, 2]);
  });

  it("falls back to raw page text (no bbox) when a page has no text items", () => {
    const empty: ParsedPage = {
      pageNum: 1,
      width: PAGE_W,
      height: PAGE_H,
      text: "Scanned cover page",
      textItems: [],
    };
    const [chunk] = new PositionalChunkCanonicalizer().toChunks([empty]);
    expect(chunk!.text).toBe("Scanned cover page");
    expect(chunk!.bbox).toBeUndefined();
  });
});
