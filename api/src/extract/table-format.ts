/**
 * Adaptive table formatting for extraction prompts.
 *
 * Detects markdown pipe tables and converts them to HTML <table> elements
 * when the content is table-heavy. HTML tables preserve column alignment
 * and structure better than pipe-delimited markdown, improving LLM
 * extraction accuracy on tabular documents (loss runs, schedules, invoices).
 *
 * Non-table content (headings, paragraphs, lists) is left as markdown.
 */

// Matches a full markdown table row: | cell | cell | ... |
const TABLE_ROW_RE = /^\|(.+)\|$/;

// Separator row: |---|---|---| (with optional colons for alignment)
const SEPARATOR_RE = /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|$/;

/**
 * Minimum ratio of table rows to total lines for the content to qualify
 * as "table-heavy." Documents below this threshold keep markdown tables.
 */
const TABLE_HEAVY_RATIO = 0.3;

/**
 * Minimum table rows to trigger conversion — tiny tables (1-2 rows)
 * are fine as markdown.
 */
const MIN_TABLE_ROWS = 4;

/**
 * Returns true when the text contains enough tabular content that
 * HTML tables would materially improve LLM extraction.
 */
export function isTableHeavy(text: string): boolean {
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;

  let tableRows = 0;
  for (const line of nonBlank) {
    if (TABLE_ROW_RE.test(line.trim())) tableRows++;
  }

  return tableRows >= MIN_TABLE_ROWS && tableRows / nonBlank.length >= TABLE_HEAVY_RATIO;
}

/**
 * Convert markdown pipe tables in the text to HTML <table> elements.
 * Non-table content is returned unchanged. Each contiguous block of
 * pipe rows (including the separator) becomes one <table>.
 */
export function markdownTablesToHtml(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let tableBlock: string[] = [];

  function flushTable() {
    if (tableBlock.length === 0) return;
    const html = convertTableBlock(tableBlock);
    result.push(html);
    tableBlock = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (TABLE_ROW_RE.test(trimmed) || SEPARATOR_RE.test(trimmed)) {
      tableBlock.push(trimmed);
    } else {
      flushTable();
      result.push(line);
    }
  }
  flushTable();

  return result.join("\n");
}

function convertTableBlock(rows: string[]): string {
  // Parse rows, skipping separator rows
  const dataRows: string[][] = [];
  let headerEnd = -1;

  for (let i = 0; i < rows.length; i++) {
    if (SEPARATOR_RE.test(rows[i]!)) {
      // The row before the separator is the header
      headerEnd = i;
      continue;
    }
    const cells = parseCells(rows[i]!);
    dataRows.push(cells);
  }

  if (dataRows.length === 0) return rows.join("\n");

  const parts: string[] = ["<table>"];

  // If we found a separator, the first data row is the header
  if (headerEnd > 0 && dataRows.length > 0) {
    const headerCells = dataRows.shift()!;
    parts.push("<thead><tr>");
    for (const cell of headerCells) {
      parts.push(`<th>${escapeHtml(cell)}</th>`);
    }
    parts.push("</tr></thead>");
  }

  if (dataRows.length > 0) {
    parts.push("<tbody>");
    for (const row of dataRows) {
      parts.push("<tr>");
      for (const cell of row) {
        parts.push(`<td>${escapeHtml(cell)}</td>`);
      }
      parts.push("</tr>");
    }
    parts.push("</tbody>");
  }

  parts.push("</table>");
  return parts.join("");
}

function parseCells(row: string): string[] {
  // Remove leading/trailing pipes and split
  const inner = row.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((c) => c.trim());
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * If the markdown is table-heavy, convert its tables to HTML for better
 * LLM extraction. Otherwise return the markdown unchanged.
 */
export function adaptiveTableFormat(markdown: string): {
  text: string;
  converted: boolean;
} {
  if (!isTableHeavy(markdown)) {
    return { text: markdown, converted: false };
  }
  return { text: markdownTablesToHtml(markdown), converted: true };
}
