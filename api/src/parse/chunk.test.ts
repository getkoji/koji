import { describe, it, expect } from "vitest";
import {
  unionBBox,
  normalizeBBox,
  type BBox,
  type ParseChunk,
  type ChunkCanonicalizer,
} from "./chunk";
import type { ParseResponse } from "./provider";

/** Assert two boxes are equal up to floating-point rounding. */
function expectBBoxClose(actual: BBox | undefined, expected: BBox): void {
  expect(actual).toBeDefined();
  expect(actual!.x).toBeCloseTo(expected.x, 9);
  expect(actual!.y).toBeCloseTo(expected.y, 9);
  expect(actual!.w).toBeCloseTo(expected.w, 9);
  expect(actual!.h).toBeCloseTo(expected.h, 9);
}

describe("unionBBox", () => {
  it("returns undefined for no boxes", () => {
    expect(unionBBox([])).toBeUndefined();
  });

  it("returns the same box for a single input", () => {
    const b: BBox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expectBBoxClose(unionBBox([b]), b);
  });

  it("encloses multiple boxes", () => {
    const a: BBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }; // spans x 0.1–0.3, y 0.1–0.3
    const b: BBox = { x: 0.4, y: 0.5, w: 0.1, h: 0.1 }; // spans x 0.4–0.5, y 0.5–0.6
    expectBBoxClose(unionBBox([a, b]), { x: 0.1, y: 0.1, w: 0.4, h: 0.5 });
  });

  it("handles overlapping and nested boxes", () => {
    const outer: BBox = { x: 0.0, y: 0.0, w: 0.5, h: 0.5 };
    const inner: BBox = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    expectBBoxClose(unionBBox([outer, inner]), outer);
  });
});

describe("normalizeBBox", () => {
  it("scales pixel coordinates into [0,1]", () => {
    const box = { x: 100, y: 200, w: 50, h: 20 };
    expect(normalizeBBox(box, 1000, 2000)).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.05,
      h: 0.01,
    });
  });

  it("returns undefined for non-positive page dimensions", () => {
    expect(normalizeBBox({ x: 1, y: 1, w: 1, h: 1 }, 0, 100)).toBeUndefined();
    expect(normalizeBBox({ x: 1, y: 1, w: 1, h: 1 }, 100, 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: a sample structured parse result → chunks-with-bbox.
//
// This mimics the shape a JSON-native provider (PB-7 Google, PB-8 Textract) or
// the digital-positional path (PB-6) would carry: pages sized in pixel space,
// each holding blocks made of words with absolute pixel boxes. A canonicalizer
// for this representation is implemented inline to prove the seam is usable and
// well-typed without shipping any real provider's canonicalizer yet.
// ---------------------------------------------------------------------------

interface SampleWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SampleBlock {
  words: SampleWord[];
}

interface SamplePage {
  pageNum: number; // 1-based
  pixelWidth: number;
  pixelHeight: number;
  blocks: SampleBlock[];
}

type SampleStructured = SamplePage[];

class SampleCanonicalizer implements ChunkCanonicalizer<SampleStructured> {
  toChunks(structured: SampleStructured): ParseChunk[] {
    const chunks: ParseChunk[] = [];
    for (const page of structured) {
      for (const block of page.blocks) {
        const text = block.words.map((w) => w.text).join(" ");
        const wordBoxes = block.words
          .map((w) =>
            normalizeBBox(
              { x: w.x, y: w.y, w: w.w, h: w.h },
              page.pixelWidth,
              page.pixelHeight,
            ),
          )
          .filter((b): b is BBox => b !== undefined);
        chunks.push({
          text,
          page: page.pageNum,
          bbox: unionBBox(wordBoxes),
        });
      }
    }
    return chunks;
  }
}

describe("ChunkCanonicalizer round-trip (structured → chunks-with-bbox)", () => {
  const structured: SampleStructured = [
    {
      pageNum: 1,
      pixelWidth: 1000,
      pixelHeight: 2000,
      blocks: [
        {
          words: [
            { text: "Policy", x: 100, y: 100, w: 120, h: 40 },
            { text: "Number", x: 240, y: 100, w: 140, h: 40 },
          ],
        },
        {
          words: [{ text: "ACME-12345", x: 100, y: 200, w: 300, h: 40 }],
        },
      ],
    },
    {
      pageNum: 2,
      pixelWidth: 1000,
      pixelHeight: 2000,
      blocks: [
        {
          words: [{ text: "Continued", x: 100, y: 100, w: 200, h: 40 }],
        },
      ],
    },
  ];

  const chunks = new SampleCanonicalizer().toChunks(structured);

  it("emits one chunk per block in reading order", () => {
    expect(chunks.map((c) => c.text)).toEqual([
      "Policy Number",
      "ACME-12345",
      "Continued",
    ]);
  });

  it("carries 1-based page numbers through", () => {
    expect(chunks.map((c) => c.page)).toEqual([1, 1, 2]);
  });

  it("merges word boxes into a normalized chunk bbox", () => {
    // First chunk: x 100–380, y 100–140 over a 1000x2000 page.
    expectBBoxClose(chunks[0]!.bbox, { x: 0.1, y: 0.05, w: 0.28, h: 0.02 });
  });

  it("produces bboxes fully within the normalized unit square", () => {
    for (const c of chunks) {
      expect(c.bbox).toBeDefined();
      const { x, y, w, h } = c.bbox!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1);
      expect(y + h).toBeLessThanOrEqual(1);
    }
  });

  it("leaves bbox undefined when a block has no geometry", () => {
    const noGeo: SampleStructured = [
      { pageNum: 1, pixelWidth: 0, pixelHeight: 0, blocks: [{ words: [] }] },
    ];
    const [chunk] = new SampleCanonicalizer().toChunks(noGeo);
    expect(chunk!.bbox).toBeUndefined();
    expect(chunk!.text).toBe("");
  });
});

describe("ParseResponse.chunks is additive and dormant", () => {
  it("a markdown-native response is valid with chunks undefined", () => {
    const md: ParseResponse = {
      markdown: "# Heading\n\nbody",
      pages: 1,
      ocr_skipped: false,
      engine: "docling",
    };
    expect(md.chunks).toBeUndefined();
  });

  it("a structured response can attach canonicalized chunks", () => {
    const chunks: ParseChunk[] = [
      { text: "hello", page: 1, bbox: { x: 0, y: 0, w: 0.1, h: 0.05 } },
    ];
    const resp: ParseResponse = {
      markdown: "hello",
      pages: 1,
      ocr_skipped: true,
      engine: "pdfjs",
      chunks,
    };
    expect(resp.chunks).toHaveLength(1);
    expect(resp.chunks![0]!.bbox).toBeDefined();
  });
});
