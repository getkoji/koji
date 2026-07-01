/**
 * Page-window selection and density ranking.
 *
 * Two concerns, kept separate:
 *   1. selectWindow — WHICH pages we pay to read (the cost decision), driven by
 *      the config `window` and `scan` strategy.
 *   2. densityRank — the order we then reason over them in, so a sparse cover
 *      sheet / routing slip stapled on top (near-empty leading page) sinks
 *      below the real document instead of dominating the label. Generic: it
 *      ranks by information density, it does not know what a "cover sheet" is.
 */

import type { ScanStrategy } from "./config";
import type { PageText } from "./types";

/**
 * The number of pages to actually extract text for, given the config default
 * and any per-class overrides. We read the deepest window any class needs, once.
 */
export function effectiveWindow(defaultWindow: number, classWindows: Array<number | undefined>): number {
  let max = defaultWindow;
  for (const w of classWindows) {
    if (typeof w === "number" && w > max) max = w;
  }
  return max;
}

/**
 * Pick the candidate pages from a document by position. `head` takes the first
 * `window` pages; `head_and_tail` splits the budget across the front and back
 * (junk sometimes trails too). Page numbers are 1-based and de-duplicated for
 * short documents where head and tail overlap.
 */
export function selectWindow(totalPages: number, window: number, scan: ScanStrategy): number[] {
  if (totalPages <= 0 || window <= 0) return [];
  if (window >= totalPages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (scan === "head") {
    return Array.from({ length: window }, (_, i) => i + 1);
  }
  // head_and_tail: bias the extra page to the head on odd budgets.
  const headCount = Math.ceil(window / 2);
  const tailCount = window - headCount;
  const seen = new Set<number>();
  for (let i = 1; i <= headCount; i++) seen.add(i);
  for (let i = 0; i < tailCount; i++) seen.add(totalPages - i);
  return [...seen].sort((a, b) => a - b);
}

/**
 * Order pages by information density (trimmed character count, descending) and
 * drop pages with no extractable text. Stable within equal densities so
 * document order is preserved for ties.
 */
export function densityRank(pages: PageText[]): PageText[] {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.text.trim().length - a.p.text.trim().length || a.i - b.i)
    .map((x) => x.p);
}
