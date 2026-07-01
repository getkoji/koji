import { describe, it, expect } from "vitest";
import { selectWindow, densityRank, effectiveWindow } from "./window";
import type { PageText } from "./types";

describe("effectiveWindow", () => {
  it("is the max of the default and any per-class override", () => {
    expect(effectiveWindow(3, [undefined, 2, 5])).toBe(5);
    expect(effectiveWindow(3, [1, 2])).toBe(3);
  });
});

describe("selectWindow", () => {
  it("head takes the first N pages", () => {
    expect(selectWindow(10, 3, "head")).toEqual([1, 2, 3]);
  });

  it("head_and_tail splits the budget, biasing head on odd", () => {
    expect(selectWindow(10, 3, "head_and_tail")).toEqual([1, 2, 10]);
    expect(selectWindow(10, 4, "head_and_tail")).toEqual([1, 2, 9, 10]);
  });

  it("returns all pages when the window covers the document", () => {
    expect(selectWindow(2, 5, "head_and_tail")).toEqual([1, 2]);
  });

  it("de-duplicates when head and tail overlap on short docs", () => {
    expect(selectWindow(3, 3, "head_and_tail")).toEqual([1, 2, 3]);
  });

  it("returns empty for degenerate inputs", () => {
    expect(selectWindow(0, 3, "head")).toEqual([]);
    expect(selectWindow(5, 0, "head")).toEqual([]);
  });
});

describe("densityRank", () => {
  const pages = (texts: string[]): PageText[] => texts.map((text, i) => ({ page: i + 1, text }));

  it("orders by text length descending and drops empty pages", () => {
    const ranked = densityRank(pages(["  ", "short", "a much longer page of content here"]));
    expect(ranked.map((p) => p.page)).toEqual([3, 2]); // page 1 (blank) dropped
  });

  it("sinks a sparse cover sheet below the real document", () => {
    const ranked = densityRank(
      pages(["FAX COVER", "This is the full body of the actual document with lots of text."]),
    );
    expect(ranked[0].page).toBe(2);
  });

  it("preserves document order for equal densities (stable)", () => {
    const ranked = densityRank(pages(["abcd", "efgh"]));
    expect(ranked.map((p) => p.page)).toEqual([1, 2]);
  });
});
