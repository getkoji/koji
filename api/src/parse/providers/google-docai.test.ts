import { describe, it, expect } from "vitest";
import {
  GoogleDocAiCanonicalizer,
  GoogleDocAiProvider,
  type GoogleDocument,
} from "./google-docai";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";
import { SAMPLE_DOCUMENT, EXPECTED_TABLE_MARKDOWN } from "./google-docai.fixture";
import type { BBox } from "../chunk";

function expectBBoxClose(actual: BBox | undefined, expected: BBox): void {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected.x, 9);
  expect(actual!.y).toBeCloseTo(expected.y, 9);
  expect(actual!.w).toBeCloseTo(expected.w, 9);
  expect(actual!.h).toBeCloseTo(expected.h, 9);
}

describe("GoogleDocAiCanonicalizer — sample Document → chunks", () => {
  const chunks = new GoogleDocAiCanonicalizer().toChunks(SAMPLE_DOCUMENT);

  it("emits page text + one table chunk, deduping table-overlapping paragraphs", () => {
    // Title, table (markdown), total — the duplicate "Building" paragraph that
    // overlapped a table cell is dropped.
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toBe("Commercial Property Declarations");
    expect(chunks[2]!.text).toBe("Total Premium: $3,450");
  });

  it("orders chunks top-to-bottom (title → table → total)", () => {
    expect(chunks.map((c) => c.page)).toEqual([1, 1, 1]);
    // The table sits between the title and the total by vertical position.
    expect(chunks[1]!.text.startsWith("| Coverage |")).toBe(true);
  });

  it("serializes the table with CORRECT column association from the cell grid", () => {
    // The key assertion: each value lands under its own header column. Because
    // the canonicalizer reads cells in row/col array order (not by inferring
    // columns from flattened reading order), column association cannot drift —
    // this is the wrong-column fix at the source.
    expect(chunks[1]!.text).toBe(EXPECTED_TABLE_MARKDOWN);
  });

  it("populates the table bbox from normalized vertices", () => {
    // Table layout box spans (0.05,0.1)–(0.95,0.5).
    expectBBoxClose(chunks[1]!.bbox, { x: 0.05, y: 0.1, w: 0.9, h: 0.4 });
  });

  it("populates the title bbox from pixel vertices via normalizeBBox", () => {
    // Title pixels x 50..600, y 40..80 over a 1000x1294 page.
    expectBBoxClose(chunks[0]!.bbox, {
      x: 50 / 1000,
      y: 40 / 1294,
      w: 550 / 1000,
      h: 40 / 1294,
    });
  });
});

describe("GoogleDocAiCanonicalizer — table edge cases", () => {
  const canon = new GoogleDocAiCanonicalizer();

  it("promotes the first body row to a header when headerRows is absent", () => {
    const doc: GoogleDocument = {
      text: "ABCD",
      pages: [
        {
          pageNumber: 1,
          dimension: { width: 100, height: 100 },
          tables: [
            {
              bodyRows: [
                {
                  cells: [
                    { layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: "1" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "1", endIndex: "2" }] } } },
                  ],
                },
                {
                  cells: [
                    { layout: { textAnchor: { textSegments: [{ startIndex: "2", endIndex: "3" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "3", endIndex: "4" }] } } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [chunk] = canon.toChunks(doc);
    expect(chunk!.text).toBe(["| A | B |", "| --- | --- |", "| C | D |"].join("\n"));
  });

  it("expands colSpan into blank columns so alignment is preserved", () => {
    // Header: one cell spanning 2 columns + a third. Body: 3 distinct cells.
    const doc: GoogleDocument = {
      text: "HEADxYZ",
      pages: [
        {
          pageNumber: 1,
          tables: [
            {
              headerRows: [
                {
                  cells: [
                    { colSpan: 2, layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: "4" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "4", endIndex: "5" }] } } },
                  ],
                },
              ],
              bodyRows: [
                {
                  cells: [
                    { layout: { textAnchor: { textSegments: [{ startIndex: "5", endIndex: "6" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "6", endIndex: "7" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: "0" }] } } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [chunk] = canon.toChunks(doc);
    // "HEAD" spans columns 1-2 (col 2 blank), "x" is column 3; body Y,Z, blank.
    expect(chunk!.text).toBe(
      ["| HEAD |  | x |", "| --- | --- | --- |", "| Y | Z |  |"].join("\n"),
    );
  });

  it("escapes pipe characters in cell text", () => {
    const doc: GoogleDocument = {
      text: "a|bc",
      pages: [
        {
          tables: [
            {
              bodyRows: [
                {
                  cells: [
                    { layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: "3" }] } } },
                    { layout: { textAnchor: { textSegments: [{ startIndex: "3", endIndex: "4" }] } } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [chunk] = canon.toChunks(doc);
    expect(chunk!.text).toContain("a\\|b");
  });

  it("falls back to the union of cell boxes when the table has no layout box", () => {
    const doc: GoogleDocument = {
      text: "AB",
      pages: [
        {
          pageNumber: 1,
          tables: [
            {
              bodyRows: [
                {
                  cells: [
                    {
                      layout: {
                        textAnchor: { textSegments: [{ startIndex: "0", endIndex: "1" }] },
                        boundingPoly: { normalizedVertices: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.2 }, { x: 0.1, y: 0.2 }] },
                      },
                    },
                    {
                      layout: {
                        textAnchor: { textSegments: [{ startIndex: "1", endIndex: "2" }] },
                        boundingPoly: { normalizedVertices: [{ x: 0.5, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.25 }, { x: 0.5, y: 0.25 }] },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [chunk] = canon.toChunks(doc);
    // Union of the two cell boxes: x 0.1..0.8, y 0.1..0.25.
    expectBBoxClose(chunk!.bbox, { x: 0.1, y: 0.1, w: 0.7, h: 0.15 });
  });

  it("handles an empty document without throwing", () => {
    expect(new GoogleDocAiCanonicalizer().toChunks({})).toEqual([]);
  });

  it("defaults a missing pageNumber to the 1-based page index", () => {
    const doc: GoogleDocument = {
      text: "hello",
      pages: [
        { paragraphs: [{ layout: { textAnchor: { textSegments: [{ startIndex: "0", endIndex: "5" }] } } }] },
      ],
    };
    const [chunk] = new GoogleDocAiCanonicalizer().toChunks(doc);
    expect(chunk!.page).toBe(1);
  });
});

describe("GoogleDocAiProvider — response shaping", () => {
  const payload: ParseEndpointPayload = {
    provider: "google-docai",
    config: { project_id: "proj", processor_id: "proc" },
    api_key: "fake-token",
  };

  it("builds a ParseResponse carrying chunks + linearized markdown", () => {
    const provider = new GoogleDocAiProvider(payload);
    const resp = provider.buildResponse(SAMPLE_DOCUMENT);

    expect(resp.engine).toBe("google-docai");
    expect(resp.pages).toBe(1);
    expect(resp.ocr_skipped).toBe(false);
    expect(resp.chunks).toHaveLength(3);
    // The markdown view is the chunks joined — table fidelity is preserved.
    expect(resp.markdown).toContain(EXPECTED_TABLE_MARKDOWN);
    expect(resp.markdown).toContain("Commercial Property Declarations");
    expect(resp.markdown).toContain("Total Premium: $3,450");
  });

  it("rejects a parse() call when project/processor config is missing", async () => {
    const provider = new GoogleDocAiProvider({ provider: "google-docai", api_key: "t" });
    await expect(
      provider.parse({ filename: "x.pdf", mimeType: "application/pdf", fileBuffer: Buffer.from("x") }),
    ).rejects.toThrow(/project_id and processor_id/);
  });

  it("rejects a parse() call when the access token is missing", async () => {
    const provider = new GoogleDocAiProvider({
      provider: "google-docai",
      config: { project_id: "p", processor_id: "q" },
    });
    await expect(
      provider.parse({ filename: "x.pdf", mimeType: "application/pdf", fileBuffer: Buffer.from("x") }),
    ).rejects.toThrow(/access token/);
  });
});
