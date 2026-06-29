/**
 * A sample Google Document AI `Document` for the canonicalizer tests.
 *
 * Built with a small cursor so the `textAnchor` offsets into `Document.text`
 * are correct by construction — exactly how Document AI emits them (every
 * element's text is a slice of the single concatenated `text` string). This
 * lets the test assert that the canonicalizer reassembles a table with the
 * right column association from the structured cell grid.
 *
 * Layout modeled: a dec-page-style page with a title, a 3-column table
 * (Coverage / Limit / Deductible), a duplicate paragraph that overlaps a table
 * cell (Document AI emits paragraphs for table text too — it must be deduped),
 * and a trailing "Total Premium" line below the table. Geometry mixes pixel
 * `vertices` (the title) and `normalizedVertices` (the table + total) to
 * exercise both bbox paths.
 */

import type { GoogleDocument } from "./google-docai";

/** Build the fixture, returning the document plus the offsets the test needs. */
function build(): GoogleDocument {
  let text = "";
  /** Append `s` to the document text, returning its [start, end) segment. */
  const seg = (s: string): { startIndex: string; endIndex: string } => {
    const start = text.length;
    text += s;
    return { startIndex: String(start), endIndex: String(text.length) };
  };

  // Order of appends defines the offsets. Title first, then the table cells in
  // row-major order, then the trailing total.
  const titleSeg = seg("Commercial Property Declarations");
  text += "\n";

  const cov = seg("Coverage");
  const lim = seg("Limit");
  const ded = seg("Deductible");
  const bldg = seg("Building");
  const bldgLimit = seg("$500,000");
  const bldgDed = seg("$1,000");
  const bpp = seg("Business Personal Property");
  const bppLimit = seg("$250,000");
  const bppDed = seg("$1,000");
  text += "\n";

  const totalSeg = seg("Total Premium: $3,450");

  // Pixel page geometry for the title vertices path.
  const PAGE_W = 1000;
  const PAGE_H = 1294;

  const normPoly = (x0: number, y0: number, x1: number, y1: number) => ({
    normalizedVertices: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  });

  return {
    text,
    pages: [
      {
        pageNumber: 1,
        dimension: { width: PAGE_W, height: PAGE_H, unit: "pixels" },
        paragraphs: [
          {
            // Title — pixel vertices (origin top-left): x 50..600, y 40..80.
            layout: {
              textAnchor: { textSegments: [titleSeg] },
              boundingPoly: {
                vertices: [
                  { x: 50, y: 40 },
                  { x: 600, y: 40 },
                  { x: 600, y: 80 },
                  { x: 50, y: 80 },
                ],
              },
            },
          },
          {
            // Duplicate paragraph overlapping the "Building" cell — Document AI
            // emits paragraphs for table text too; the canonicalizer must drop
            // this so the table chunk owns it.
            layout: {
              textAnchor: { textSegments: [bldg] },
              boundingPoly: normPoly(0.06, 0.21, 0.3, 0.24),
            },
          },
          {
            // Trailing total — below the table (y 0.6).
            layout: {
              textAnchor: { textSegments: [totalSeg] },
              boundingPoly: normPoly(0.05, 0.6, 0.4, 0.63),
            },
          },
        ],
        tables: [
          {
            // Table region spans y 0.1..0.5.
            layout: { boundingPoly: normPoly(0.05, 0.1, 0.95, 0.5) },
            headerRows: [
              {
                cells: [
                  { layout: { textAnchor: { textSegments: [cov] }, boundingPoly: normPoly(0.05, 0.1, 0.45, 0.15) } },
                  { layout: { textAnchor: { textSegments: [lim] }, boundingPoly: normPoly(0.45, 0.1, 0.7, 0.15) } },
                  { layout: { textAnchor: { textSegments: [ded] }, boundingPoly: normPoly(0.7, 0.1, 0.95, 0.15) } },
                ],
              },
            ],
            bodyRows: [
              {
                cells: [
                  { layout: { textAnchor: { textSegments: [bldg] }, boundingPoly: normPoly(0.05, 0.2, 0.45, 0.25) } },
                  { layout: { textAnchor: { textSegments: [bldgLimit] }, boundingPoly: normPoly(0.45, 0.2, 0.7, 0.25) } },
                  { layout: { textAnchor: { textSegments: [bldgDed] }, boundingPoly: normPoly(0.7, 0.2, 0.95, 0.25) } },
                ],
              },
              {
                cells: [
                  { layout: { textAnchor: { textSegments: [bpp] }, boundingPoly: normPoly(0.05, 0.3, 0.45, 0.35) } },
                  { layout: { textAnchor: { textSegments: [bppLimit] }, boundingPoly: normPoly(0.45, 0.3, 0.7, 0.35) } },
                  { layout: { textAnchor: { textSegments: [bppDed] }, boundingPoly: normPoly(0.7, 0.3, 0.95, 0.35) } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export const SAMPLE_DOCUMENT: GoogleDocument = build();

/** The expected markdown serialization of the fixture's table. */
export const EXPECTED_TABLE_MARKDOWN = [
  "| Coverage | Limit | Deductible |",
  "| --- | --- | --- |",
  "| Building | $500,000 | $1,000 |",
  "| Business Personal Property | $250,000 | $1,000 |",
].join("\n");
