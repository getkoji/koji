import { describe, it, expect } from "vitest";
import {
  isNormalizedBBox,
  assertNormalizedBBox,
  type BBox,
  type ParseChunk,
} from "./chunk";
import { PositionalChunkCanonicalizer } from "./positional-chunks";
import type { ParsedPage, TextItem } from "./spatial-to-markdown";
import { GoogleDocAiCanonicalizer } from "./providers/google-docai";
import { SAMPLE_DOCUMENT } from "./providers/google-docai.fixture";
import {
  TextractCanonicalizer,
  type TextractBlock,
  type TextractBlocks,
} from "./providers/textract-canonicalizer";

// ---------------------------------------------------------------------------
// The canonical bbox coordinate contract (oss-316).
//
// ONE convention across every parse provider: normalized floats in [0, 1]
// (x/w of page width, y/h of page height), origin top-left with y increasing
// downward, page-indexed from 1. These tests enforce that every bbox emitter
// conforms, so the dashboard renders highlights from stored coords with zero
// per-provider coordinate math.
// ---------------------------------------------------------------------------

/** Assert every chunk that carries geometry obeys the canonical convention. */
function expectAllChunksNormalized(chunks: ParseChunk[], label: string): void {
  const withBox = chunks.filter((c) => c.bbox !== undefined);
  expect(withBox.length).toBeGreaterThan(0); // provider actually emitted geometry
  for (const c of withBox) {
    expect(c.page).toBeGreaterThanOrEqual(1); // 1-indexed pages, never 0
    expect(isNormalizedBBox(c.bbox!)).toBe(true);
    expect(() => assertNormalizedBBox(c.bbox!, label)).not.toThrow();
  }
}

describe("isNormalizedBBox / assertNormalizedBBox", () => {
  it("accepts a box inside the unit square", () => {
    expect(isNormalizedBBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toBe(true);
  });

  it("accepts the full-page box", () => {
    expect(isNormalizedBBox({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it("rejects unnormalized pixel coordinates (values > 1)", () => {
    expect(isNormalizedBBox({ x: 100, y: 200, w: 50, h: 20 })).toBe(false);
  });

  it("rejects a box that extends past the page edge", () => {
    expect(isNormalizedBBox({ x: 0.8, y: 0.1, w: 0.5, h: 0.1 })).toBe(false);
  });

  it("rejects negative coordinates", () => {
    expect(isNormalizedBBox({ x: -0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(false);
  });

  it("rejects NaN / Infinity", () => {
    expect(isNormalizedBBox({ x: NaN, y: 0, w: 0.1, h: 0.1 })).toBe(false);
    expect(isNormalizedBBox({ x: 0, y: 0, w: Infinity, h: 0.1 })).toBe(false);
  });

  it("assertNormalizedBBox throws with a labeled message on violation", () => {
    expect(() =>
      assertNormalizedBBox({ x: 100, y: 200, w: 50, h: 20 }, "pixel-emitter"),
    ).toThrow(/pixel-emitter/);
  });
});

describe("PositionalChunkCanonicalizer (pdfjs digital path) emits canonical bboxes", () => {
  // ParsedPage geometry is in absolute top-down page units (the shape
  // DigitalPdfProvider builds after flipping PDF user space to top-left).
  // TextItem.y is the glyph BASELINE (where the text sits), not the top of its
  // box — glyphs extend upward from the baseline, so the box top is one glyph
  // height above it. A 1000x2000 page with one line whose baseline is at y=100
  // and glyph height 40 → box top at y=60.
  const item: TextItem = {
    text: "Policy Number ABC-123",
    x: 100,
    y: 100,
    width: 300,
    height: 40,
    fontName: "Helvetica",
    fontSize: 12,
  };
  const page: ParsedPage = {
    pageNum: 1,
    width: 1000,
    height: 2000,
    text: item.text,
    textItems: [item],
  };
  const chunks = new PositionalChunkCanonicalizer().toChunks([page]);

  it("normalizes absolute page units into [0,1] top-left", () => {
    expectAllChunksNormalized(chunks, "positional");
    const box = chunks[0]!.bbox!;
    // x=100/1000, box top=(100-40)/2000=0.03, w=300/1000, h=40/2000
    expect(box.x).toBeCloseTo(0.1, 9);
    expect(box.y).toBeCloseTo(0.03, 9);
    expect(box.w).toBeCloseTo(0.3, 9);
    expect(box.h).toBeCloseTo(0.02, 9);
    // The box bottom lands on the baseline (100/2000), so the glyphs sit inside
    // the box rather than one line below it.
    expect(box.y + box.h).toBeCloseTo(0.05, 9);
  });

  it("keeps a top-of-page line near y=0 (top-left origin)", () => {
    expect(chunks[0]!.bbox!.y).toBeLessThan(0.1);
  });
});

describe("GoogleDocAiCanonicalizer emits canonical bboxes", () => {
  const chunks = new GoogleDocAiCanonicalizer().toChunks(SAMPLE_DOCUMENT);

  it("normalizes both pixel `vertices` and `normalizedVertices` paths", () => {
    expectAllChunksNormalized(chunks, "google-docai");
  });

  it("maps the pixel-vertices title (y 40..80 of a 1294px page) to a small top-left y", () => {
    // The title paragraph uses pixel vertices; its top edge is 40/1294 ≈ 0.031.
    const title = chunks.find((c) => c.text.includes("Commercial Property"));
    expect(title?.bbox).toBeDefined();
    expect(title!.bbox!.y).toBeCloseTo(40 / 1294, 6);
    expect(title!.bbox!.y).toBeLessThan(0.1);
  });
});

describe("TextractCanonicalizer emits canonical bboxes", () => {
  // Textract BoundingBoxes are already normalized [0,1] top-left; the
  // canonicalizer must pass them through unchanged (a direct field rename).
  function bbox(Left: number, Top: number, Width: number, Height: number) {
    return { Geometry: { BoundingBox: { Left, Top, Width, Height } } };
  }
  const blocks: TextractBlock[] = [
    {
      Id: "L1",
      BlockType: "LINE",
      Text: "Insurance Summary",
      Page: 1,
      ...bbox(0.1, 0.05, 0.4, 0.03),
    },
    {
      Id: "L2",
      BlockType: "LINE",
      Text: "Thank you for your business",
      Page: 1,
      ...bbox(0.1, 0.9, 0.5, 0.03),
    },
  ];
  const structured: TextractBlocks = { Blocks: blocks };
  const chunks = new TextractCanonicalizer().toChunks(structured);

  it("passes normalized [0,1] top-left boxes straight through", () => {
    expectAllChunksNormalized(chunks, "textract");
  });

  it("preserves the top-left origin (top line has smaller y than bottom line)", () => {
    const top = chunks.find((c) => c.text.includes("Insurance Summary"));
    const bottom = chunks.find((c) => c.text.includes("Thank you"));
    expect(top!.bbox!.y).toBeCloseTo(0.05, 9);
    expect(bottom!.bbox!.y).toBeCloseTo(0.9, 9);
    expect(top!.bbox!.y).toBeLessThan(bottom!.bbox!.y);
  });
});
