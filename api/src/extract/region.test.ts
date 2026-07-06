import { describe, it, expect } from "vitest";
import { locateWordsByRegion } from "./region";
import type { TextMap, TextSegment } from "./provenance";

/** Build a word segment with a nested bbox (the provenance-layer shape). */
function word(
  text: string,
  page: number,
  x: number,
  y: number,
  w = 0.05,
  h = 0.02,
): TextSegment {
  return { text, page, bbox: { x, y, w, h } };
}

describe("locateWordsByRegion", () => {
  // Page 1, one visual line: "Policy Number: ABC-123"
  const line1: TextMap = [
    word("Policy", 1, 0.1, 0.2),
    word("Number:", 1, 0.16, 0.2),
    word("ABC-123", 1, 0.23, 0.2),
  ];

  it("returns the words fully inside the selection, in x order", () => {
    const match = locateWordsByRegion(line1, 1, { x: 0.09, y: 0.19, w: 0.25, h: 0.04 });
    expect(match).not.toBeNull();
    expect(match!.text).toBe("Policy Number: ABC-123");
    expect(match!.words.map((w) => w.text)).toEqual(["Policy", "Number:", "ABC-123"]);
  });

  it("snaps: union bbox covers exactly the matched words, not the raw selection", () => {
    const match = locateWordsByRegion(line1, 1, { x: 0.0, y: 0.1, w: 0.9, h: 0.3 })!;
    expect(match.bbox.x).toBeCloseTo(0.1);
    expect(match.bbox.y).toBeCloseTo(0.2);
    expect(match.bbox.x + match.bbox.w).toBeCloseTo(0.28);
    expect(match.bbox.y + match.bbox.h).toBeCloseTo(0.22);
  });

  it("excludes a word the selection merely grazes (< half its area)", () => {
    // Selection ends 1/5 of the way into "ABC-123" (word spans x 0.23–0.28).
    const match = locateWordsByRegion(line1, 1, { x: 0.09, y: 0.19, w: 0.15, h: 0.04 })!;
    expect(match.text).toBe("Policy Number:");
  });

  it("includes a word more than half covered by the selection", () => {
    // Selection ends 4/5 of the way into "ABC-123".
    const match = locateWordsByRegion(line1, 1, { x: 0.09, y: 0.19, w: 0.18, h: 0.04 })!;
    expect(match.text).toBe("Policy Number: ABC-123");
  });

  it("honors a custom minOverlap threshold", () => {
    const rect = { x: 0.09, y: 0.19, w: 0.15, h: 0.04 }; // grazes ABC-123 by 1/5
    expect(locateWordsByRegion(line1, 1, rect, { minOverlap: 0.1 })!.text).toBe(
      "Policy Number: ABC-123",
    );
  });

  it("groups multi-line selections into lines joined by newline, top to bottom", () => {
    const twoLines: TextMap = [
      // Deliberately out of reading order in the map.
      word("Suite", 1, 0.1, 0.25),
      word("Main", 1, 0.15, 0.2),
      word("4", 1, 0.16, 0.25),
      word("360", 1, 0.1, 0.2),
      word("St", 1, 0.21, 0.2),
    ];
    const match = locateWordsByRegion(twoLines, 1, { x: 0.05, y: 0.15, w: 0.3, h: 0.15 })!;
    expect(match.text).toBe("360 Main St\nSuite 4");
  });

  it("keeps words with slightly jittered baselines on one line", () => {
    const jittered: TextMap = [
      word("Total:", 1, 0.1, 0.2, 0.05, 0.02),
      word("$1,000", 1, 0.16, 0.205, 0.05, 0.02), // 25% vertical offset, >50% overlap
    ];
    const match = locateWordsByRegion(jittered, 1, { x: 0, y: 0, w: 1, h: 1 })!;
    expect(match.text).toBe("Total: $1,000");
  });

  it("only matches words on the requested page", () => {
    const map: TextMap = [word("page1", 1, 0.1, 0.2), word("page2", 2, 0.1, 0.2)];
    const match = locateWordsByRegion(map, 2, { x: 0, y: 0, w: 1, h: 1 })!;
    expect(match.text).toBe("page2");
    expect(match.words.every((w) => w.page === 2)).toBe(true);
  });

  it("skips segments without geometry instead of crashing", () => {
    const map: TextMap = [{ text: "no-bbox", page: 1 }, word("boxed", 1, 0.1, 0.2)];
    const match = locateWordsByRegion(map, 1, { x: 0, y: 0, w: 1, h: 1 })!;
    expect(match.text).toBe("boxed");
  });

  it("matches a zero-area word by center containment", () => {
    const map: TextMap = [{ text: "point", page: 1, bbox: { x: 0.5, y: 0.5, w: 0, h: 0 } }];
    expect(locateWordsByRegion(map, 1, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })!.text).toBe("point");
    expect(locateWordsByRegion(map, 1, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).toBeNull();
  });

  it("ignores whitespace-only segments (no doubled separators in text)", () => {
    const map: TextMap = [
      word("Total", 1, 0.1, 0.2),
      { text: " ", page: 1, bbox: { x: 0.151, y: 0.2, w: 0.001, h: 0.02 } },
      word("$6,000.00", 1, 0.16, 0.2),
    ];
    const match = locateWordsByRegion(map, 1, { x: 0, y: 0, w: 1, h: 1 })!;
    expect(match.text).toBe("Total $6,000.00");
    expect(match.words).toHaveLength(2);
  });

  it("returns null when the selection covers only whitespace segments", () => {
    const map: TextMap = [{ text: "  ", page: 1, bbox: { x: 0.5, y: 0.5, w: 0.05, h: 0.02 } }];
    expect(locateWordsByRegion(map, 1, { x: 0.4, y: 0.4, w: 0.3, h: 0.3 })).toBeNull();
  });

  it("returns null for an empty map, a whitespace region, or the wrong page", () => {
    expect(locateWordsByRegion([], 1, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
    expect(locateWordsByRegion(line1, 1, { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })).toBeNull();
    expect(locateWordsByRegion(line1, 3, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
