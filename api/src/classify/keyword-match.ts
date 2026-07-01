/**
 * Tier-2 deterministic class scoring.
 *
 * Generic keyword + regex overlap scoring, factored from the form-fingerprint
 * matcher (extract/form-match.ts) but operating on arbitrary user-declared
 * classes instead of stored form templates. Free (CPU-only); runs before any
 * model call and short-circuits the cascade when a class wins outright.
 *
 * Scoring is per-page so we can report which page a class keyed on (the
 * evidence page) — the signal that makes a cover-sheet misclassification
 * debuggable.
 */

import type { ClassifierClass } from "./config";
import type { ClassScore, PageText } from "./types";

/** Take the first `window` pages (pages are pre-ordered by the caller). */
function windowPages(pages: PageText[], window: number): PageText[] {
  return window > 0 ? pages.slice(0, window) : pages;
}

/**
 * Count how many of a class's signals (keywords + patterns) match a single
 * page's text. Multi-word keywords match as a substring; single words match on
 * word-set membership (mirrors form-match semantics); patterns test as
 * case-insensitive regex.
 */
function countHitsOnPage(text: string, cls: ClassifierClass): number {
  const lower = text.toLowerCase();
  const words = new Set(
    lower
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );

  let hits = 0;
  for (const kwRaw of cls.keywords ?? []) {
    const kw = kwRaw.toLowerCase().trim();
    if (!kw) continue;
    if (kw.includes(" ")) {
      if (lower.includes(kw)) hits++;
    } else if (words.has(kw)) {
      hits++;
    }
  }
  for (const pat of cls.patterns ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) hits++;
    } catch {
      // Invalid patterns are rejected at config time; ignore defensively.
    }
  }
  return hits;
}

/**
 * Score one class over the page window. A signal counts as matched if it hits
 * on ANY page in the window; `score` is the fraction of the class's total
 * declared signals that matched. The evidence page is the single page with the
 * most raw hits.
 */
export function scoreClass(
  pages: PageText[],
  cls: ClassifierClass,
  defaultWindow: number,
): ClassScore {
  const total = (cls.keywords?.length ?? 0) + (cls.patterns?.length ?? 0);
  const scoped = windowPages(pages, cls.window ?? defaultWindow);

  if (total === 0) {
    // No deterministic signals declared — this class can only be decided by the
    // LLM/vision tiers. Report a zero score so it never wins Tier 2.
    return { id: cls.id, score: 0, hits: 0, total: 0, evidencePage: null };
  }

  // Union of matched signals across the window, plus the best single page.
  const matchedKw = new Set<string>();
  const matchedPat = new Set<string>();
  let bestPage: number | null = null;
  let bestPageHits = -1;

  for (const p of scoped) {
    const pageHits = countHitsOnPage(p.text, cls);
    if (pageHits > bestPageHits) {
      bestPageHits = pageHits;
      bestPage = pageHits > 0 ? p.page : bestPage;
    }
    const lower = p.text.toLowerCase();
    const words = new Set(
      lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 0),
    );
    for (const kwRaw of cls.keywords ?? []) {
      const kw = kwRaw.toLowerCase().trim();
      if (!kw) continue;
      if (kw.includes(" ") ? lower.includes(kw) : words.has(kw)) matchedKw.add(kw);
    }
    for (const pat of cls.patterns ?? []) {
      try {
        if (new RegExp(pat, "i").test(p.text)) matchedPat.add(pat);
      } catch {
        /* rejected at config time */
      }
    }
  }

  const hits = matchedKw.size + matchedPat.size;
  return {
    id: cls.id,
    score: hits / total,
    hits,
    total,
    evidencePage: bestPage,
  };
}

/** Score every class and return them sorted by score descending. */
export function scoreClasses(
  pages: PageText[],
  classes: ClassifierClass[],
  defaultWindow: number,
): ClassScore[] {
  return classes
    .map((c) => scoreClass(pages, c, defaultWindow))
    .sort((a, b) => b.score - a.score || b.hits - a.hits);
}
