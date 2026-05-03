/**
 * Simple heading-based markdown chunker.
 *
 * Splits markdown into chunks at heading boundaries (# ## ### etc.).
 * Each chunk gets a title (the heading text), content, and basic signals.
 * This is the TypeScript equivalent of the Python chunker for use in
 * the DAG pipeline runner.
 */

export interface Chunk {
  index: number;
  title: string;
  content: string;
  category?: string;
  signals: {
    has_dates: boolean;
    has_dollar_amounts: boolean;
    has_tables: boolean;
    has_key_value_pairs: boolean;
  };
  charOffset: number;
  charLength: number;
}

const DATE_PATTERN = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}/i;
const DOLLAR_PATTERN = /\$[\d,]+\.?\d*/;
const TABLE_PATTERN = /\|[^|]+\|/;
const KV_PATTERN = /^[A-Z][^:]{2,30}:\s+\S/m;

/**
 * Split markdown into chunks at heading boundaries.
 * Returns at least one chunk (the whole doc if no headings found).
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  if (!markdown || !markdown.trim()) {
    return [{
      index: 0,
      title: "Document",
      content: "",
      signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: false },
      charOffset: 0,
      charLength: 0,
    }];
  }

  const lines = markdown.split("\n");
  const chunks: Chunk[] = [];
  let currentTitle = "Document";
  let currentLines: string[] = [];
  let currentOffset = 0;
  let chunkStartOffset = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch && currentLines.length > 0) {
      // Save previous chunk
      const content = currentLines.join("\n").trim();
      if (content) {
        chunks.push(buildChunk(chunks.length, currentTitle, content, chunkStartOffset));
      }
      currentTitle = headingMatch[2]!.trim();
      currentLines = [];
      chunkStartOffset = currentOffset;
    } else if (headingMatch && currentLines.length === 0) {
      currentTitle = headingMatch[2]!.trim();
      chunkStartOffset = currentOffset;
    } else {
      currentLines.push(line);
    }
    currentOffset += line.length + 1; // +1 for newline
  }

  // Save last chunk
  const content = currentLines.join("\n").trim();
  if (content || chunks.length === 0) {
    chunks.push(buildChunk(chunks.length, currentTitle, content, chunkStartOffset));
  }

  return chunks;
}

function buildChunk(index: number, title: string, content: string, charOffset: number): Chunk {
  return {
    index,
    title,
    content,
    signals: {
      has_dates: DATE_PATTERN.test(content),
      has_dollar_amounts: DOLLAR_PATTERN.test(content),
      has_tables: TABLE_PATTERN.test(content),
      has_key_value_pairs: KV_PATTERN.test(content),
    },
    charOffset,
    charLength: content.length,
  };
}
