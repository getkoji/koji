/**
 * Region → text resolution: the inverse of provenance lookup.
 *
 * Provenance resolution goes value → markdown offset → word boxes
 * (`locateWordsByOffset`). This module goes the other way: given a page
 * region — e.g. a rectangle a reviewer dragged on the rendered document —
 * find the text_map words underneath it and reconstruct their text in
 * reading order. Powers highlight-to-correct (see the resolve-region
 * endpoint in routes/jobs.ts).
 *
 * Coordinates follow the repo-wide bbox contract (parse/chunk.ts): normalized
 * [0,1] floats, top-left origin, pages indexed from 1. A selection made on a
 * rendered page converts into this space by dividing by the rendered page's
 * pixel dimensions — no other transform exists anywhere in the chain.
 */

import type { BBox, TextMap, WordBox } from "./provenance";

export interface RegionMatch {
  /** Matched words joined in reading order — words with " ", lines with "\n". */
  text: string;
  /** The matched words in reading order, for snap-to-word highlight echo. */
  words: WordBox[];
  /** Union box of the matched words (the "snapped" selection). */
  bbox: BBox;
}

/**
 * Fraction of a word's area that must fall inside the selection for the word
 * to count as selected. 0.5 means "more than half covered" — forgiving enough
 * for sloppy drags, strict enough not to grab neighboring words the selection
 * merely grazes.
 */
const DEFAULT_MIN_OVERLAP = 0.5;

/** Intersection area of two boxes, 0 when disjoint. */
function intersectionArea(a: BBox, b: BBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Two word boxes sit on the same visual line when their vertical overlap is
 * at least half the shorter box's height. Degenerate (zero-height) boxes
 * pass against anything they touch, which is the forgiving direction.
 */
function sameLine(a: BBox, b: BBox): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap >= 0.5 * Math.min(a.h, b.h);
}

/**
 * Find the text_map words under a selection rectangle on one page and
 * reconstruct their text in reading order.
 *
 * A word matches when at least `minOverlap` of its own area lies inside the
 * selection (zero-area words match by center containment). Matched words are
 * grouped into visual lines by vertical overlap, lines ordered top→bottom,
 * words within a line left→right. Segments without geometry can't match —
 * same guard as everywhere else in provenance, they're skipped, never fatal.
 *
 * Returns null when nothing matches (empty map, wrong page, selection over
 * whitespace/graphics) — callers surface that as "no text here" and fall
 * back to typed input.
 */
export function locateWordsByRegion(
  textMap: TextMap,
  page: number,
  rect: BBox,
  opts?: { minOverlap?: number },
): RegionMatch | null {
  const minOverlap = opts?.minOverlap ?? DEFAULT_MIN_OVERLAP;

  const hits: WordBox[] = [];
  for (const seg of textMap) {
    if (seg.page !== page || !seg.bbox) continue;
    // Whitespace-only segments (some parsers emit them between words) carry
    // no content and would double up separators in the joined text.
    if (seg.text.trim() === "") continue;
    const area = seg.bbox.w * seg.bbox.h;
    if (area > 0) {
      if (intersectionArea(seg.bbox, rect) / area < minOverlap) continue;
    } else {
      // Degenerate box — match by center-point containment.
      const cx = seg.bbox.x + seg.bbox.w / 2;
      const cy = seg.bbox.y + seg.bbox.h / 2;
      const inside =
        cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
      if (!inside) continue;
    }
    hits.push({
      text: seg.text,
      page: seg.page,
      x: seg.bbox.x,
      y: seg.bbox.y,
      w: seg.bbox.w,
      h: seg.bbox.h,
    });
  }

  if (hits.length === 0) return null;

  // Group into visual lines. Words are scanned top-to-bottom; each joins the
  // first line it vertically overlaps, else starts a new one. Tracking the
  // line's union band (not just the last word) keeps tall/short words on a
  // shared baseline in one line.
  hits.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: { band: BBox; words: WordBox[] }[] = [];
  for (const word of hits) {
    const box: BBox = { x: word.x, y: word.y, w: word.w, h: word.h };
    const line = lines.find((l) => sameLine(l.band, box));
    if (line) {
      line.words.push(word);
      const top = Math.min(line.band.y, box.y);
      const bottom = Math.max(line.band.y + line.band.h, box.y + box.h);
      line.band = { x: 0, y: top, w: 1, h: bottom - top };
    } else {
      lines.push({ band: box, words: [word] });
    }
  }
  for (const line of lines) line.words.sort((a, b) => a.x - b.x);

  const ordered = lines.flatMap((l) => l.words);
  const text = lines.map((l) => l.words.map((w) => w.text).join(" ")).join("\n");

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const w of ordered) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.w);
    maxY = Math.max(maxY, w.y + w.h);
  }

  return {
    text,
    words: ordered,
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}
