/**
 * THROWAWAY SPIKE HARNESS — NOT PRODUCTION CODE (oss-331).
 *
 * Builds a parse spine (ParseUnit[]) from a corpus markdown document so we can
 * measure LLM source-unit-id citation accuracy ("anchored extraction", Move B)
 * against the deterministic offset/chunk provenance path we already ship.
 *
 * We have no digital PDFs in the corpus (docs are pre-parsed .md), so instead of
 * running the live pdfjs/Doc AI/Textract canonicalizers we reverse a GFM
 * markdown table back into the SAME addressable unit shape those canonicalizers
 * emit: `table_cell` units carrying { tableId, row, col }, plus line/heading
 * units for prose. Ids are stamped by the REAL `assignUnitIds`, and the markdown
 * the model + baseline see is the REAL `spineToMarkdown` projection of the spine.
 * The citation task (cite the unit id that supports a value) is identical
 * regardless of which provider produced the units.
 */

import { assignUnitIds, spineToMarkdown } from "../../api/src/parse/chunk.js";
import type { ParseUnit, ParseUnitDraft } from "../../api/src/parse/chunk.js";

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (line: string): boolean =>
  /^\s*\|[\s|:-]+\|\s*$/.test(line) && line.includes("-");

/** Split a GFM table row `| a | b |` into trimmed cell strings. */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

/**
 * Parse a corpus markdown doc into a parse spine. GFM tables become per-cell
 * `table_cell` units (1-based row/col, header = row 1); everything else becomes
 * a line/heading unit. Empty table cells are emitted so `spineToMarkdown`
 * reproduces the full grid, but they are never citation targets.
 */
export function mdToSpine(markdown: string): ParseUnit[] {
  const lines = markdown.split("\n");
  const drafts: ParseUnitDraft[] = [];
  let tableIndex = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Table block: a run of pipe rows (with a separator as the 2nd line).
    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const tableId = `p1-t${tableIndex++}`;
      const block: string[] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        block.push(lines[i]!);
        i++;
      }
      let rowNum = 0;
      for (const raw of block) {
        if (isSeparatorRow(raw)) continue;
        rowNum++;
        const cells = splitRow(raw);
        cells.forEach((text, idx) => {
          drafts.push({
            text,
            page: 1,
            role: "table_cell",
            table: { tableId, row: rowNum, col: idx + 1 },
          });
        });
      }
      continue;
    }

    // Prose line.
    const trimmed = line.trim();
    if (trimmed && trimmed !== "<!-- image -->") {
      const isHeading = /^#{1,6}\s/.test(trimmed);
      drafts.push({
        text: trimmed.replace(/^#{1,6}\s+/, ""),
        page: 1,
        role: isHeading ? "heading" : "line",
      });
    }
    i++;
  }

  return assignUnitIds(drafts);
}

/** A spine plus its projected markdown and per-unit md offset annotations. */
export interface AnnotatedSpine {
  units: ParseUnit[];
  markdown: string;
  /** unit id -> { offset, length } in the projected markdown. */
  offsets: Map<string, { offset: number; length: number }>;
}

/**
 * Project the spine to markdown via the REAL `spineToMarkdown`, then annotate
 * each non-empty unit's character span by forward-scanning its text in
 * reading order (row-major for table cells) — the same md_offset the oss-317
 * projection carries.
 */
export function annotate(units: ParseUnit[]): AnnotatedSpine {
  const markdown = spineToMarkdown(units);
  const offsets = new Map<string, { offset: number; length: number }>();
  let cursor = 0;
  for (const u of units) {
    if (!u.text) continue;
    let idx = markdown.indexOf(u.text, cursor);
    let len = u.text.length;
    if (idx === -1) {
      const esc = u.text.replace(/\|/g, "\\|");
      idx = markdown.indexOf(esc, cursor);
      len = esc.length;
      if (idx === -1) continue;
    }
    offsets.set(u.id, { offset: idx, length: len });
    cursor = idx + len;
  }
  return { units, markdown, offsets };
}

/** Map a markdown char offset back to the unit id whose span contains it. */
export function unitAtOffset(spine: AnnotatedSpine, offset: number): string | null {
  let best: string | null = null;
  let bestStart = -1;
  for (const [id, span] of spine.offsets) {
    if (offset >= span.offset && offset < span.offset + span.length) return id;
    if (span.offset <= offset && span.offset > bestStart) {
      bestStart = span.offset;
      best = id;
    }
  }
  return best;
}
