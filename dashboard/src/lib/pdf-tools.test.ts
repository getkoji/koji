/**
 * Unit tests for the PDF viewer's tool helpers.
 *
 * Three of these carry real risk and are worth the coverage:
 *
 * - `parseToolsParam` is the embed's capability switch. A tool that leaks on
 *   by default puts a Download button on documents a customer never meant to
 *   hand out.
 * - `rotateBox` positions every highlight while the view is rotated. Get a
 *   quarter turn backwards and provenance boxes sit on the wrong words —
 *   which reads as "the extraction is wrong", not "the viewer is wrong".
 * - `findMatches` returns offsets that are replayed against the rendered text
 *   layer to draw the search boxes, so its offsets must index the ORIGINAL
 *   string. Any case-folding that changed length would silently misplace
 *   every hit.
 */

import { describe, it, expect } from "vitest";
import {
  clampZoom,
  collectHits,
  downloadFilename,
  findMatches,
  foldForSearch,
  formatZoom,
  isRotation,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeRotation,
  parseToolsParam,
  rotateBox,
  stepRotation,
  stepZoom,
  unrotateBox,
  VIEWER_TOOL_NAMES,
  wrapIndex,
  type NormBox,
  type Rotation,
} from "./pdf-tools";

describe("parseToolsParam", () => {
  it("enables nothing by default", () => {
    expect(parseToolsParam(null)).toEqual({});
    expect(parseToolsParam("")).toEqual({});
    expect(parseToolsParam(undefined)).toEqual({});
  });

  it("enables only the tools listed", () => {
    expect(parseToolsParam("zoom,search")).toEqual({ zoom: true, search: true });
  });

  it("ignores unknown names instead of failing the whole embed", () => {
    expect(parseToolsParam("zoom,teleport")).toEqual({ zoom: true });
  });

  it("tolerates whitespace and casing", () => {
    expect(parseToolsParam(" Zoom , SEARCH ")).toEqual({ zoom: true, search: true });
  });

  it("supports the all shorthand", () => {
    const all = parseToolsParam("all");
    for (const name of VIEWER_TOOL_NAMES) expect(all[name]).toBe(true);
  });

  it("keeps the pre-existing select tool working", () => {
    expect(parseToolsParam("select")).toEqual({ select: true });
  });
});

describe("zoom", () => {
  it("clamps to the supported range", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("steps to the next level, not by a fixed factor", () => {
    expect(stepZoom(1, "in")).toBe(1.25);
    expect(stepZoom(1, "out")).toBe(0.75);
  });

  it("advances off an exact step rather than re-selecting it", () => {
    // Float noise around a step boundary must not stall the button.
    expect(stepZoom(1.0000001, "in")).toBe(1.25);
    expect(stepZoom(0.9999999, "out")).toBe(0.75);
  });

  it("saturates at the ends", () => {
    expect(stepZoom(MAX_ZOOM, "in")).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, "out")).toBe(MIN_ZOOM);
  });

  it("formats as a percentage", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(1.25)).toBe("125%");
  });
});

describe("rotation", () => {
  it("normalizes negatives and overflow", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
  });

  it("steps both ways", () => {
    expect(stepRotation(0, "cw")).toBe(90);
    expect(stepRotation(0, "ccw")).toBe(270);
    expect(stepRotation(270, "cw")).toBe(0);
  });

  it("recognizes only quarter turns", () => {
    expect(isRotation(90)).toBe(true);
    expect(isRotation(45)).toBe(false);
    expect(isRotation("90")).toBe(false);
  });
});

describe("rotateBox", () => {
  // A box hugging the top-left corner — its corner is what makes each quarter
  // turn unambiguous.
  const topLeft: NormBox = { x: 0, y: 0, w: 0.2, h: 0.1 };

  it("leaves boxes alone at 0°", () => {
    expect(rotateBox(topLeft, 0)).toEqual(topLeft);
  });

  it("sends the top-left corner to the top-right at 90°", () => {
    expect(rotateBox(topLeft, 90)).toEqual({ x: 0.9, y: 0, w: 0.1, h: 0.2 });
  });

  it("sends it to the bottom-right at 180°", () => {
    expect(rotateBox(topLeft, 180)).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
  });

  it("sends it to the bottom-left at 270°", () => {
    expect(rotateBox(topLeft, 270)).toEqual({ x: 0, y: 0.8, w: 0.1, h: 0.2 });
  });

  it("swaps width and height on quarter turns only", () => {
    expect(rotateBox(topLeft, 90).w).toBeCloseTo(topLeft.h);
    expect(rotateBox(topLeft, 180).w).toBeCloseTo(topLeft.w);
  });

  it("round-trips through unrotateBox — the region-selection contract", () => {
    const box: NormBox = { x: 0.31, y: 0.42, w: 0.15, h: 0.08 };
    for (const r of [0, 90, 180, 270] as Rotation[]) {
      const back = unrotateBox(rotateBox(box, r), r);
      expect(back.x).toBeCloseTo(box.x);
      expect(back.y).toBeCloseTo(box.y);
      expect(back.w).toBeCloseTo(box.w);
      expect(back.h).toBeCloseTo(box.h);
    }
  });

  it("returns to the original after four quarter turns", () => {
    let box: NormBox = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
    for (let i = 0; i < 4; i++) box = rotateBox(box, 90);
    expect(box.x).toBeCloseTo(0.1);
    expect(box.y).toBeCloseTo(0.2);
    expect(box.w).toBeCloseTo(0.3);
    expect(box.h).toBeCloseTo(0.05);
  });
});

describe("foldForSearch", () => {
  it("never changes the string's length — offsets depend on it", () => {
    const samples = ["Policy Number", "TOTAL PREMIUM", "Coverage  — Crime", "ÀÉÎÕÜ"];
    for (const s of samples) expect(foldForSearch(s).length).toBe(s.length);
  });

  it("folds case and exotic spaces to their plain equivalents", () => {
    expect(foldForSearch("Total Premium")).toBe("total premium");
  });
});

describe("findMatches", () => {
  it("finds every occurrence in order", () => {
    expect(findMatches("abcabcabc", "abc")).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
    ]);
  });

  it("is case-insensitive but reports offsets into the original text", () => {
    const text = "The Total Premium is $6,000";
    const [match] = findMatches(text, "total premium");
    expect(text.slice(match.start, match.end)).toBe("Total Premium");
  });

  it("matches across a non-breaking space the user typed as a plain one", () => {
    const text = "Total\u00a0Premium";
    expect(findMatches(text, "total premium")).toEqual([{ start: 0, end: 13 }]);
  });

  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("refuses queries below the minimum length", () => {
    expect(findMatches("aaaa", "a")).toEqual([]);
    expect(findMatches("aaaa", "")).toEqual([]);
  });

  it("returns nothing when there is no hit", () => {
    expect(findMatches("invoice", "policy")).toEqual([]);
  });
});

describe("collectHits", () => {
  const pages = ["policy one", "no hit here", "policy two policy three"];

  it("flattens pages into document order with 1-based page numbers", () => {
    const hits = collectHits(pages, "policy");
    expect(hits.map((h) => [h.page, h.ordinal])).toEqual([
      [1, 0],
      [3, 0],
      [3, 1],
    ]);
  });

  it("numbers each page's hits from zero — how the overlay finds them again", () => {
    const hits = collectHits(pages, "policy").filter((h) => h.page === 3);
    expect(hits.map((h) => h.ordinal)).toEqual([0, 1]);
  });

  it("keeps offsets page-relative", () => {
    const [, , third] = collectHits(pages, "policy");
    expect(pages[2].slice(third.start, third.end)).toBe("policy");
  });
});

describe("wrapIndex", () => {
  it("cycles forwards and backwards so next/prev never dead-end", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
  });

  it("reports -1 for an empty list", () => {
    expect(wrapIndex(0, 0)).toBe(-1);
  });
});

describe("downloadFilename", () => {
  it("falls back when the document has no name", () => {
    expect(downloadFilename(null)).toBe("document.pdf");
    expect(downloadFilename("   ")).toBe("document.pdf");
  });

  it("keeps a name that already has an extension", () => {
    expect(downloadFilename("acme-policy.pdf")).toBe("acme-policy.pdf");
  });

  it("adds .pdf when the name has none", () => {
    expect(downloadFilename("acme-policy")).toBe("acme-policy.pdf");
  });

  it("drops any directory component", () => {
    expect(downloadFilename("uploads/2026/acme.pdf")).toBe("acme.pdf");
  });
});
