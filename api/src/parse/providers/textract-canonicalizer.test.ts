import { describe, it, expect } from "vitest";
import {
  TextractCanonicalizer,
  chunksToMarkdown,
  type TextractBlock,
  type TextractBlocks,
} from "./textract-canonicalizer";

// ---------------------------------------------------------------------------
// Sample Textract `Blocks` fixture.
//
// Mirrors the real AnalyzeDocument(TABLES) graph for one page:
//
//   LINE "Insurance Summary"            (free text, above the table)
//   TABLE
//     CELL r1c1 "Policy"  CELL r1c2 "Premium"   (header row)
//     CELL r2c1 "ABC-123" CELL r2c2 "$1,000"
//     CELL r3c1 "XYZ-789" CELL r3c2 "$2,500"
//   LINE "Policy Premium"               (Textract also emits LINEs over table
//                                        words — must be suppressed, not double-
//                                        counted as loose text)
//   LINE "Thank you"                    (free text, below the table)
//
// Textract BoundingBoxes are already normalized to [0,1], origin top-left, so
// they map straight to ParseChunk.bbox.
// ---------------------------------------------------------------------------

function bbox(Left: number, Top: number, Width: number, Height: number) {
  return { Geometry: { BoundingBox: { Left, Top, Width, Height } } };
}

let wordSeq = 0;
function word(text: string, top: number): TextractBlock {
  return {
    Id: `w${++wordSeq}`,
    BlockType: "WORD",
    Text: text,
    Page: 1,
    ...bbox(0.1, top, 0.2, 0.02),
  };
}

function cell(
  id: string,
  row: number,
  col: number,
  wordIds: string[],
  entity?: string[],
): TextractBlock {
  return {
    Id: id,
    BlockType: "CELL",
    Page: 1,
    RowIndex: row,
    ColumnIndex: col,
    ...(entity ? { EntityTypes: entity } : {}),
    ...bbox(0.1 + (col - 1) * 0.3, 0.2 + (row - 1) * 0.05, 0.3, 0.05),
    Relationships: [{ Type: "CHILD", Ids: wordIds }],
  };
}

function buildFixture(): TextractBlocks {
  wordSeq = 0;
  // Header-row words (shared by a LINE that must be suppressed).
  const wPolicy = word("Policy", 0.2);
  const wPremium = word("Premium", 0.2);

  const wAbc = word("ABC-123", 0.25);
  const w1000 = word("$1,000", 0.25);
  const wXyz = word("XYZ-789", 0.3);
  const w2500 = word("$2,500", 0.3);

  const cells: TextractBlock[] = [
    cell("c11", 1, 1, [wPolicy.Id!], ["COLUMN_HEADER"]),
    cell("c12", 1, 2, [wPremium.Id!], ["COLUMN_HEADER"]),
    cell("c21", 2, 1, [wAbc.Id!]),
    cell("c22", 2, 2, [w1000.Id!]),
    cell("c31", 3, 1, [wXyz.Id!]),
    cell("c32", 3, 2, [w2500.Id!]),
  ];

  const table: TextractBlock = {
    Id: "t1",
    BlockType: "TABLE",
    Page: 1,
    ...bbox(0.1, 0.2, 0.6, 0.15),
    Relationships: [{ Type: "CHILD", Ids: cells.map((c) => c.Id!) }],
  };

  // Free-text lines.
  const titleWords = [word("Insurance", 0.05), word("Summary", 0.05)];
  const title: TextractBlock = {
    Id: "lTitle",
    BlockType: "LINE",
    Text: "Insurance Summary",
    Page: 1,
    ...bbox(0.1, 0.05, 0.4, 0.03),
    Relationships: [{ Type: "CHILD", Ids: titleWords.map((w) => w.Id!) }],
  };

  // A LINE whose words are exactly the table header words — should be dropped.
  const headerLine: TextractBlock = {
    Id: "lHeader",
    BlockType: "LINE",
    Text: "Policy Premium",
    Page: 1,
    ...bbox(0.1, 0.2, 0.5, 0.02),
    Relationships: [{ Type: "CHILD", Ids: [wPolicy.Id!, wPremium.Id!] }],
  };

  const footerWords = [word("Thank", 0.8), word("you", 0.8)];
  const footer: TextractBlock = {
    Id: "lFooter",
    BlockType: "LINE",
    Text: "Thank you",
    Page: 1,
    ...bbox(0.1, 0.8, 0.2, 0.03),
    Relationships: [{ Type: "CHILD", Ids: footerWords.map((w) => w.Id!) }],
  };

  const page: TextractBlock = { Id: "p1", BlockType: "PAGE", Page: 1 };

  return {
    DocumentMetadata: { Pages: 1 },
    Blocks: [
      page,
      title,
      ...titleWords,
      table,
      ...cells,
      wPolicy,
      wPremium,
      wAbc,
      w1000,
      wXyz,
      w2500,
      headerLine,
      footer,
      ...footerWords,
    ],
  };
}

/** Parse a serialized markdown table into a grid of trimmed cells. */
function parseMarkdownTable(md: string): string[][] {
  return md
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    // Drop the `| --- | --- |` separator row.
    .filter((line) => !/^\|\s*-{2,}/.test(line.replace(/\s/g, " ")))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

describe("TextractCanonicalizer", () => {
  const chunks = new TextractCanonicalizer().toChunks(buildFixture());

  it("emits free text and the table in reading order (by page, then top)", () => {
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toBe("Insurance Summary");
    expect(chunks[1]!.text).toContain("Policy"); // the table chunk
    expect(chunks[2]!.text).toBe("Thank you");
  });

  it("suppresses LINEs whose words are entirely inside a table", () => {
    // "Policy Premium" must NOT appear as its own loose text chunk.
    const looseTexts = chunks.filter((c) => !c.text.includes("|")).map((c) => c.text);
    expect(looseTexts).toEqual(["Insurance Summary", "Thank you"]);
  });

  it("reconstructs the table with correct column association", () => {
    const grid = parseMarkdownTable(chunks[1]!.text);
    expect(grid).toEqual([
      ["Policy", "Premium"],
      ["ABC-123", "$1,000"],
      ["XYZ-789", "$2,500"],
    ]);
    // The premium values land under the Premium column, never under Policy.
    expect(grid[1]![1]).toBe("$1,000");
    expect(grid[2]![1]).toBe("$2,500");
    expect(grid[1]![0]).toBe("ABC-123");
  });

  it("carries the table bbox from the TABLE block geometry", () => {
    const table = chunks[1]!;
    expect(table.bbox).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.15 });
    expect(table.page).toBe(1);
  });

  it("carries normalized bbox on free-text chunks", () => {
    expect(chunks[0]!.bbox).toEqual({ x: 0.1, y: 0.05, w: 0.4, h: 0.03 });
  });

  it("serializes a markdown view with the table embedded", () => {
    const md = chunksToMarkdown(chunks);
    expect(md).toContain("Insurance Summary");
    expect(md).toContain("| Policy | Premium |");
    expect(md).toContain("| ABC-123 | $1,000 |");
    expect(md).toContain("Thank you");
  });
});

describe("TextractCanonicalizer — edge cases", () => {
  it("returns no chunks for an empty Blocks set", () => {
    expect(new TextractCanonicalizer().toChunks({ Blocks: [] })).toEqual([]);
    expect(new TextractCanonicalizer().toChunks({})).toEqual([]);
  });

  it("renders selection elements inside cells", () => {
    const sel: TextractBlock = {
      Id: "s1",
      BlockType: "SELECTION_ELEMENT",
      SelectionStatus: "SELECTED",
      Page: 1,
    };
    const c: TextractBlock = {
      Id: "c1",
      BlockType: "CELL",
      Page: 1,
      RowIndex: 1,
      ColumnIndex: 1,
      Relationships: [{ Type: "CHILD", Ids: ["s1"] }],
      ...bbox(0.1, 0.1, 0.1, 0.05),
    };
    const t: TextractBlock = {
      Id: "t1",
      BlockType: "TABLE",
      Page: 1,
      ...bbox(0.1, 0.1, 0.2, 0.1),
      Relationships: [{ Type: "CHILD", Ids: ["c1"] }],
    };
    const chunks = new TextractCanonicalizer().toChunks({ Blocks: [t, c, sel] });
    expect(chunks[0]!.text).toContain("[X]");
  });

  it("orders chunks across multiple pages", () => {
    const mk = (id: string, page: number, top: number, text: string): TextractBlock => ({
      Id: id,
      BlockType: "LINE",
      Text: text,
      Page: page,
      ...bbox(0.1, top, 0.3, 0.02),
      Relationships: [{ Type: "CHILD", Ids: [] }],
    });
    const blocks: TextractBlock[] = [
      mk("a", 2, 0.1, "page two top"),
      mk("b", 1, 0.9, "page one bottom"),
      mk("c", 1, 0.1, "page one top"),
    ];
    const chunks = new TextractCanonicalizer().toChunks({ Blocks: blocks });
    expect(chunks.map((c) => c.text)).toEqual([
      "page one top",
      "page one bottom",
      "page two top",
    ]);
  });
});
