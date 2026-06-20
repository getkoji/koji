/**
 * Simple heading-based markdown chunker.
 *
 * Splits markdown into chunks at heading boundaries (# ## ### etc.).
 * Each chunk gets a title (the heading text), content, and basic signals.
 * This is the TypeScript equivalent of the Python chunker for use in
 * the DAG pipeline runner.
 */

/**
 * Canonical chunk shape, shared across the extraction module. Both chunkers
 * (`chunkMarkdown` here and `buildDocumentMap` in document-map) produce this,
 * and routing/extraction/reconciliation consume it. Fields that not every
 * chunker populates are optional:
 *  - `category` — only set by chunkers that classify (e.g. buildDocumentMap)
 *  - positional metadata (`charOffset`/`charLength`/`lineCount`/`charCount`) —
 *    informational; populated opportunistically, not relied on by the engine.
 */
export interface Chunk {
  index: number;
  title: string;
  content: string;
  category?: string;
  signals: Record<string, boolean | number>;
  charOffset?: number;
  charLength?: number;
  lineCount?: number;
  charCount?: number;
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
