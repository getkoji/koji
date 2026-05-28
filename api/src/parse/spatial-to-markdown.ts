/**
 * Convert LiteParse spatial output (text items with bounding boxes) to markdown.
 *
 * LiteParse returns per-character/word bounding boxes with font metadata.
 * This module reconstructs document structure (headings, paragraphs, tables,
 * lists, bold text) from spatial relationships — no ML required.
 *
 * The output matches Docling's markdown format closely enough that downstream
 * consumers (extractFields, provenance matching, the parse UI) work unchanged.
 */

export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

export interface ParsedPage {
  pageNum: number;
  width: number;
  height: number;
  text: string;
  textItems: TextItem[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Line {
  items: TextItem[];
  y: number;         // average y position
  height: number;    // average item height
  minX: number;
  maxX: number;
  text: string;
  fontSize: number;  // median font size
  isBold: boolean;
  indent: number;    // minX relative to page left margin
}

interface TableCell {
  text: string;
  colIdx: number;
}

interface TableRow {
  cells: TableCell[];
  y: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function spatialToMarkdown(pages: ParsedPage[]): string {
  const parts: string[] = [];

  for (const page of pages) {
    if (page.textItems.length === 0) {
      // Empty page — use the raw text fallback if available
      if (page.text.trim()) parts.push(page.text.trim());
      continue;
    }

    const lines = buildLines(page.textItems, page.height);
    const bodyFontSize = detectBodyFontSize(lines);
    const leftMargin = detectLeftMargin(lines);
    const blocks = detectBlocks(lines, bodyFontSize, leftMargin, page.width);
    parts.push(blocks);
  }

  return parts.join("\n\n---\n\n"); // page breaks
}

// ---------------------------------------------------------------------------
// Step 1: Group text items into lines
// ---------------------------------------------------------------------------

function buildLines(items: TextItem[], pageHeight: number): Line[] {
  if (items.length === 0) return [];

  // Sort by y (top to bottom), then x (left to right)
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: Line[] = [];
  let currentLine: TextItem[] = [sorted[0]!];
  let currentY = sorted[0]!.y;

  // Items on the same "line" have y positions within a tolerance
  // (typically half the item height)
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i]!;
    const tolerance = Math.max(item.height * 0.5, 2);

    if (Math.abs(item.y - currentY) <= tolerance) {
      currentLine.push(item);
    } else {
      lines.push(createLine(currentLine));
      currentLine = [item];
      currentY = item.y;
    }
  }
  if (currentLine.length > 0) {
    lines.push(createLine(currentLine));
  }

  return lines;
}

function createLine(items: TextItem[]): Line {
  // Sort items left to right within the line
  items.sort((a, b) => a.x - b.x);

  const fontSizes = items.map((i) => i.fontSize ?? 12).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)]!;

  const avgY = items.reduce((s, i) => s + i.y, 0) / items.length;
  const avgHeight = items.reduce((s, i) => s + i.height, 0) / items.length;

  // Reconstruct text with spacing: insert space when gap between items > 0.3 * avg char width
  let text = "";
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (i > 0) {
      const prev = items[i - 1]!;
      const gap = item.x - (prev.x + prev.width);
      const avgCharWidth = prev.width / Math.max(prev.text.length, 1);
      if (gap > avgCharWidth * 0.3) {
        text += " ";
      }
    }
    text += item.text;
  }

  const isBold = items.some((i) =>
    i.fontName?.toLowerCase().includes("bold") ||
    i.fontName?.toLowerCase().includes("heavy"),
  );

  return {
    items,
    y: avgY,
    height: avgHeight,
    minX: items[0]!.x,
    maxX: items[items.length - 1]!.x + items[items.length - 1]!.width,
    text: text.trim(),
    fontSize: medianFontSize,
    isBold,
    indent: items[0]!.x,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Detect body font size and left margin
// ---------------------------------------------------------------------------

function detectBodyFontSize(lines: Line[]): number {
  if (lines.length === 0) return 12;

  // Body font = most common font size (by line count)
  const counts = new Map<number, number>();
  for (const line of lines) {
    const rounded = Math.round(line.fontSize * 2) / 2; // round to nearest 0.5
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }

  let maxCount = 0;
  let bodySize = 12;
  for (const [size, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      bodySize = size;
    }
  }
  return bodySize;
}

function detectLeftMargin(lines: Line[]): number {
  if (lines.length === 0) return 0;

  // Left margin = most common minX (rounded to nearest 5)
  const counts = new Map<number, number>();
  for (const line of lines) {
    const rounded = Math.round(line.minX / 5) * 5;
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }

  let maxCount = 0;
  let margin = 0;
  for (const [x, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      margin = x;
    }
  }
  return margin;
}

// ---------------------------------------------------------------------------
// Step 3: Detect structure and emit markdown
// ---------------------------------------------------------------------------

function detectBlocks(
  lines: Line[],
  bodyFontSize: number,
  leftMargin: number,
  pageWidth: number,
): string {
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip empty lines
    if (!line.text) { i++; continue; }

    // Check for table region (3+ consecutive lines with aligned columns)
    const tableEnd = detectTableRegion(lines, i, pageWidth);
    if (tableEnd > i + 1) {
      output.push(renderTable(lines.slice(i, tableEnd + 1), pageWidth));
      i = tableEnd + 1;
      continue;
    }

    // Check for list item
    const listMatch = line.text.match(/^(\s*)([-•●○▪]\s+|\d+[.)]\s+|[a-zA-Z][.)]\s+)/);
    if (listMatch) {
      const bullet = listMatch[2]!;
      const content = line.text.slice(listMatch[0].length);
      const isOrdered = /^\d+[.)]/.test(bullet);
      const prefix = isOrdered ? `${bullet.trim()} ` : "- ";
      output.push(`${prefix}${formatInline(content, line)}`);
      i++;
      continue;
    }

    // Check for heading (larger font or bold + short)
    if (isHeading(line, bodyFontSize)) {
      const level = headingLevel(line.fontSize, bodyFontSize);
      const prefix = "#".repeat(level);
      output.push(`${prefix} ${line.text}`);
      i++;
      continue;
    }

    // Regular paragraph — collect consecutive body-sized lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.text) break;
      if (isHeading(l, bodyFontSize)) break;
      if (l.text.match(/^(\s*)([-•●○▪]\s+|\d+[.)]\s+|[a-zA-Z][.)]\s+)/)) break;
      if (detectTableRegion(lines, i, pageWidth) > i + 1) break;

      // Check for paragraph break: large vertical gap
      if (paraLines.length > 0) {
        const prev = lines[i - 1]!;
        const gap = l.y - (prev.y + prev.height);
        if (gap > prev.height * 0.8) break; // paragraph break
      }

      paraLines.push(formatInline(l.text, l));
      i++;
    }

    if (paraLines.length > 0) {
      output.push(paraLines.join(" "));
    }
  }

  return output.join("\n\n");
}

// ---------------------------------------------------------------------------
// Heading detection
// ---------------------------------------------------------------------------

function isHeading(line: Line, bodyFontSize: number): boolean {
  // A heading is: larger font size than body, OR bold + short title-length text
  if (line.fontSize > bodyFontSize * 1.15) return true;
  if (line.isBold && line.text.length < 60) return true;
  return false;
}

function headingLevel(fontSize: number, bodyFontSize: number): number {
  const ratio = fontSize / bodyFontSize;
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.4) return 2;
  if (ratio >= 1.15) return 3;
  return 4; // bold short text defaults to h4
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

function formatInline(text: string, line: Line): string {
  // If the entire line is bold and it's body-sized (not a heading), wrap in **
  if (line.isBold) return `**${text}**`;
  return text;
}

// ---------------------------------------------------------------------------
// Table detection and rendering
// ---------------------------------------------------------------------------

/**
 * Detect a table region starting at line index `start`.
 * Returns the index of the last line in the table, or `start` if no table.
 *
 * Heuristic: a table exists when 3+ consecutive lines have text items
 * that align into at least 2 columns. Column alignment is detected by
 * clustering the x-positions of text items across rows.
 */
function detectTableRegion(lines: Line[], start: number, pageWidth: number): number {
  if (start + 2 >= lines.length) return start;

  // Collect candidate lines (consecutive, non-empty, similar indent)
  const candidates: Line[] = [];
  for (let i = start; i < lines.length && candidates.length < 50; i++) {
    const line = lines[i]!;
    if (!line.text) break;

    // Stop if there's a large vertical gap (section break)
    if (candidates.length > 0) {
      const prev = lines[i - 1]!;
      const gap = line.y - (prev.y + prev.height);
      if (gap > prev.height * 2) break;
    }

    candidates.push(line);
  }

  if (candidates.length < 3) return start;

  // Detect column boundaries by clustering x-positions of item starts
  const columns = detectColumns(candidates, pageWidth);
  if (columns.length < 2) return start;

  // Verify: at least 3 rows have items in >= 2 columns
  let validRows = 0;
  for (const line of candidates) {
    const cellCount = countCellsInColumns(line, columns);
    if (cellCount >= 2) validRows++;
  }

  if (validRows < 3) return start;

  return start + candidates.length - 1;
}

/**
 * Detect column boundaries from text item x-positions across multiple lines.
 * Returns sorted array of column start x-positions.
 */
function detectColumns(lines: Line[], pageWidth: number): number[] {
  // Collect all item start x-positions
  const xPositions: number[] = [];
  for (const line of lines) {
    for (const item of line.items) {
      xPositions.push(item.x);
    }
  }

  if (xPositions.length === 0) return [];

  // Cluster x-positions: items within 2% of page width are in the same column
  const tolerance = pageWidth * 0.02;
  const sorted = [...xPositions].sort((a, b) => a - b);

  const clusters: number[][] = [];
  let currentCluster: number[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! <= tolerance) {
      currentCluster.push(sorted[i]!);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]!];
    }
  }
  clusters.push(currentCluster);

  // A column must appear in at least 40% of the lines
  const minOccurrences = Math.floor(lines.length * 0.4);
  const columnStarts = clusters
    .filter((c) => c.length >= minOccurrences)
    .map((c) => c.reduce((s, v) => s + v, 0) / c.length); // cluster centroid

  return columnStarts.sort((a, b) => a - b);
}

function countCellsInColumns(line: Line, columns: number[]): number {
  const seen = new Set<number>();
  for (const item of line.items) {
    const col = findColumn(item.x, columns);
    if (col >= 0) seen.add(col);
  }
  return seen.size;
}

function findColumn(x: number, columns: number[]): number {
  // Find the nearest column within tolerance
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < columns.length; i++) {
    const dist = Math.abs(x - columns[i]!);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Render a set of lines as a markdown table.
 */
function renderTable(lines: Line[], pageWidth: number): string {
  const columns = detectColumns(lines, pageWidth);
  if (columns.length < 2) {
    // Fallback: just join lines as text
    return lines.map((l) => l.text).join("\n");
  }

  // Assign each text item to a column, build rows
  const rows: string[][] = [];
  for (const line of lines) {
    const row = new Array(columns.length).fill("") as string[];
    for (const item of line.items) {
      const col = findColumn(item.x, columns);
      if (col >= 0) {
        if (row[col]) row[col] += " ";
        row[col] += item.text;
      }
    }
    rows.push(row.map((c) => c.trim()));
  }

  if (rows.length === 0) return "";

  // First row is the header
  const header = rows[0]!;
  const separator = header.map(() => "---");
  const body = rows.slice(1);

  const lines_out: string[] = [];
  lines_out.push("| " + header.join(" | ") + " |");
  lines_out.push("| " + separator.join(" | ") + " |");
  for (const row of body) {
    lines_out.push("| " + row.join(" | ") + " |");
  }

  return lines_out.join("\n");
}
