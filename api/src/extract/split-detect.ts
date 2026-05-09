/**
 * Section boundary detection for PDF splitting.
 *
 * Layered approach, cheapest to most expensive:
 * 1. Page number resets (free) — "Page 1" after "Page 4" = new section
 * 2. Structural fingerprint (free) — text density shifts, form number changes,
 *    heading changes, horizontal rules
 * 3. Keyword matching (free) — user-configured section labels
 * 4. LLM classification (cheap) — only for ambiguous boundaries
 *
 * Each layer only processes pages that previous layers couldn't classify.
 */

import type { PageAnalysis } from "../parse/provider";
import type { ModelProvider } from "./providers";

export interface DetectedSection {
  startPage: number;
  endPage: number;
  type: string;
  confidence: number;
  method: string; // which layer detected it
}

export interface SplitLabel {
  id: string;
  description?: string;
  keywords?: string[];
}

/**
 * Detect document section boundaries using layered analysis.
 */
export async function detectSections(
  pages: PageAnalysis[],
  opts?: {
    labels?: SplitLabel[];
    llmProvider?: ModelProvider;
  },
): Promise<DetectedSection[]> {
  if (pages.length === 0) return [];

  // Track which pages are confirmed section starts
  // Value = section type or null if not yet classified
  const sectionStarts = new Map<number, { type: string; confidence: number; method: string }>();

  // ── Layer 1: Page number resets ────────────────────────────────────────
  let prevLabel: number | null = null;
  let prevPageOf: number | null = null;
  for (const p of pages) {
    if (p.page_label !== null) {
      if (p.page_label === 1 && prevLabel !== null && prevLabel !== 1) {
        // Page numbering reset — new section
        sectionStarts.set(p.page, { type: "unknown", confidence: 0.95, method: "page_number_reset" });
      } else if (prevLabel === null && p.page_label === 1) {
        // First page with label "1" after unlabeled pages — new section start
        sectionStarts.set(p.page, { type: "unknown", confidence: 0.85, method: "page_number_start" });
      }
      prevLabel = p.page_label;
      prevPageOf = p.page_of;
    } else {
      // Page without a label after labeled pages — only trigger section
      // boundary if the previous page was the LAST in its numbered sequence
      if (prevLabel !== null && prevPageOf !== null && prevLabel >= prevPageOf) {
        // Previous page was "Page N of N" — section ended, new one starts
        sectionStarts.set(p.page, { type: "unknown", confidence: 0.8, method: "page_number_end" });
      }
      prevLabel = null;
      prevPageOf = null;
    }
  }
  // First page is always a section start
  if (!sectionStarts.has(pages[0]!.page)) {
    sectionStarts.set(pages[0]!.page, { type: "unknown", confidence: 1.0, method: "first_page" });
  }

  // ── Layer 2: Structural fingerprint changes ────────────────────────────
  for (let i = 1; i < pages.length; i++) {
    if (sectionStarts.has(pages[i]!.page)) continue; // already detected

    const prev = pages[i - 1]!;
    const curr = pages[i]!;

    // Form number change
    if (
      curr.form_numbers.length > 0 &&
      prev.form_numbers.length > 0 &&
      curr.form_numbers[0] !== prev.form_numbers[0]
    ) {
      sectionStarts.set(curr.page, { type: "unknown", confidence: 0.85, method: "form_number_change" });
      continue;
    }

    // Dramatic text density shift (>3x change)
    if (prev.text_density > 0 && curr.text_density > 0) {
      const ratio = curr.text_density / prev.text_density;
      if (ratio > 3 || ratio < 0.33) {
        sectionStarts.set(curr.page, { type: "unknown", confidence: 0.6, method: "density_shift" });
        continue;
      }
    }

    // Image-heavy to text-heavy transition (or vice versa)
    if (
      (prev.image_ratio > 0.4 && curr.image_ratio < 0.15) ||
      (prev.image_ratio < 0.15 && curr.image_ratio > 0.4)
    ) {
      sectionStarts.set(curr.page, { type: "unknown", confidence: 0.7, method: "content_type_shift" });
      continue;
    }

    // Previous page has significant blank bottom (section ended mid-page)
    // AND current page has content starting at the top
    if (prev.blank_bottom_ratio > 0.3 && curr.text_density > 1) {
      sectionStarts.set(curr.page, { type: "unknown", confidence: 0.7, method: "blank_gap" });
      continue;
    }
  }

  // ── Layer 3: Keyword matching ──────────────────────────────────────────
  const labels = opts?.labels ?? [];
  for (const [pageNum, info] of sectionStarts) {
    if (info.type !== "unknown") continue;

    const pageData = pages.find((p) => p.page === pageNum);
    if (!pageData) continue;

    const text = pageData.content_preview.toLowerCase();
    const headings = pageData.bold_headings.map((h) => h.text.toLowerCase()).join(" ");
    const searchText = `${text} ${headings}`;

    for (const label of labels) {
      if (!label.keywords?.length) continue;
      const hits = label.keywords.filter((kw) => searchText.includes(kw.toLowerCase()));
      if (hits.length >= 1) {
        info.type = label.id;
        info.confidence = Math.max(info.confidence, 0.9);
        info.method += "+keyword";
        break;
      }
    }

    // Generic fallback: only truly universal patterns (not domain-specific)
    // Domain keywords belong in user-configured labels, not hardcoded here.
    if (info.type === "unknown") {
      if (/copyright|©/i.test(text)) {
        info.type = "copyright_notice";
        info.method += "+generic_keyword";
      }
    }
  }

  // ── Layer 4: LLM classification for remaining unknowns ─────────────────
  const unknowns = [...sectionStarts.entries()].filter(([, info]) => info.type === "unknown");
  if (unknowns.length > 0 && opts?.llmProvider) {
    const labelDesc = labels.length > 0
      ? `\nKnown document types:\n${labels.map((l) => `- "${l.id}"${l.description ? `: ${l.description}` : ""}`).join("\n")}\n`
      : "";

    const pageDescriptions = unknowns.map(([pageNum]) => {
      const p = pages.find((pg) => pg.page === pageNum)!;
      const headings = p.bold_headings.map((h) => h.text).join(", ");
      return `Page ${pageNum}: headings=[${headings}], tables=${p.table_count}, text_density=${p.text_density}, form_numbers=[${p.form_numbers.join(",")}], has_dollars=${p.has_dollar_amounts}, preview="${p.content_preview.slice(0, 200)}"`;
    }).join("\n");

    const prompt = `Classify these document pages. Each is the start of a new section in a multi-document package.\n\n${pageDescriptions}\n${labelDesc}\nFor each page, identify the document type. If a page does not clearly match any of the known types, use "other".\n\nReturn a JSON object mapping page numbers to types:\n{"1": "other", "5": "report", ...}\n\nReturn ONLY valid JSON.`;

    try {
      const raw = await opts.llmProvider.generate(prompt, true);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [pageStr, type] of Object.entries(parsed)) {
          const pageNum = parseInt(pageStr, 10);
          const info = sectionStarts.get(pageNum);
          if (info && info.type === "unknown" && typeof type === "string") {
            info.type = type;
            info.method += "+llm";
            info.confidence = Math.max(info.confidence, 0.8);
          }
        }
      }
    } catch {
      // LLM failed — leave as unknown
    }
  }

  // ── Build sections from starts ─────────────────────────────────────────
  const sortedStarts = [...sectionStarts.entries()].sort((a, b) => a[0] - b[0]);
  const sections: DetectedSection[] = [];

  for (let i = 0; i < sortedStarts.length; i++) {
    const [startPage, info] = sortedStarts[i]!;
    const endPage = i + 1 < sortedStarts.length
      ? sortedStarts[i + 1]![0] - 1
      : pages[pages.length - 1]!.page;

    sections.push({
      startPage,
      endPage,
      type: info.type,
      confidence: info.confidence,
      method: info.method,
    });
  }

  // ── Merge adjacent sections of the same type ───────────────────────────
  // Don't merge "unknown" sections — they're distinct unclassified boundaries
  const merged: DetectedSection[] = [];
  for (const section of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === section.type && prev.type !== "unknown" && prev.endPage === section.startPage - 1) {
      prev.endPage = section.endPage;
      prev.confidence = Math.min(prev.confidence, section.confidence);
      prev.method += "+" + section.method;
    } else {
      merged.push({ ...section });
    }
  }

  return merged;
}
