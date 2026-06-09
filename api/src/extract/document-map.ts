/**
 * Phase 1: Document Mapping — understand the structure before extracting.
 *
 * Port of Python services/extract/document_map.py. The document mapper is
 * domain-agnostic. It splits markdown into chunks by heading, detects
 * generic structural signals (dollars, dates, tables, key-value pairs),
 * and optionally applies schema-defined categories and custom signals.
 */

// ── Data Types ──────────────────────────────────────────────────────

export interface Chunk {
  index: number;
  title: string;
  content: string;
  category: string;
  signals: Record<string, boolean | number>;
  readonly lineCount: number;
  readonly charCount: number;
}

function makeChunk(
  index: number,
  title: string,
  content: string,
  category: string,
  signals: Record<string, boolean | number>,
): Chunk {
  return {
    index,
    title,
    content,
    category,
    signals,
    get lineCount() { return this.content.split("\n").length; },
    get charCount() { return this.content.length; },
  };
}

// ── Classification Config ───────────────────────────────────────────

interface ClassificationConfig {
  window: number;
  threshold: number;
  scan: "head" | "all" | "head_and_tail";
  title_priority: boolean;
}

const DEFAULT_CLASSIFICATION_CONFIG: ClassificationConfig = {
  window: 500,
  threshold: 2,
  scan: "head",
  title_priority: true,
};

const VALID_SCAN_STRATEGIES = new Set(["head", "all", "head_and_tail"]);

function buildClassificationConfig(schemaDef: Record<string, unknown> | null | undefined): ClassificationConfig {
  const cfg = { ...DEFAULT_CLASSIFICATION_CONFIG };
  if (!schemaDef) return cfg;

  const raw = schemaDef.classification as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return cfg;

  const window = raw.window;
  if (typeof window === "number" && window > 0) cfg.window = window;

  const threshold = raw.threshold;
  if (typeof threshold === "number" && threshold >= 1) cfg.threshold = threshold;

  const scan = raw.scan;
  if (typeof scan === "string" && VALID_SCAN_STRATEGIES.has(scan)) {
    cfg.scan = scan as ClassificationConfig["scan"];
  }

  const titlePriority = raw.title_priority;
  if (typeof titlePriority === "boolean") cfg.title_priority = titlePriority;

  return cfg;
}

// ── Scan Text ───────────────────────────────────────────────────────

function scanText(content: string, window: number, strategy: string): string {
  if (strategy === "all") return content;
  if (strategy === "head_and_tail") {
    const half = Math.max(1, Math.floor(window / 2));
    if (content.length <= window) return content;
    return content.slice(0, half) + "\n" + content.slice(-half);
  }
  return content.slice(0, window);
}

// ── Category Keywords ───────────────────────────────────────────────

function buildCategoryKeywords(
  schemaDef: Record<string, unknown> | null | undefined,
): [string[], string][] {
  if (!schemaDef) return [];
  const categories = (schemaDef.categories ?? {}) as Record<string, unknown>;
  const keywordsByCategory = (categories.keywords ?? {}) as Record<string, string[]>;
  if (typeof keywordsByCategory !== "object") return [];

  return Object.entries(keywordsByCategory)
    .filter(([, keywords]) => keywords && Array.isArray(keywords) && keywords.length > 0)
    .map(([category, keywords]) => [keywords as string[], category]);
}

// ── Chunk Classification ────────────────────────────────────────────

export function classifyChunk(
  title: string,
  content: string,
  categoryKeywords?: [string[], string][] | null,
  config?: Partial<ClassificationConfig> | null,
): string {
  if (!categoryKeywords || categoryKeywords.length === 0) return "other";

  const cfg = { ...DEFAULT_CLASSIFICATION_CONFIG, ...config };
  const scanned = scanText(content, cfg.window, cfg.scan);
  const text = `${title} ${scanned}`.toLowerCase();
  const titleLower = title.toLowerCase();

  for (const [keywords, category] of categoryKeywords) {
    if (cfg.title_priority) {
      for (const kw of keywords) {
        if (titleLower.includes(kw)) return category;
      }
    }
    const matches = keywords.filter((kw) => text.includes(kw)).length;
    if (matches >= cfg.threshold) return category;
  }

  return "other";
}

// ── Signal Detection ────────────────────────────────────────────────

// Port all regex patterns faithfully from Python document_map.py

const MONTHS_EN =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|" +
  "Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

const MONTHS_FR =
  "(?:janvier|f[e\u00e9]vrier|mars|avril|mai|juin|juillet|ao[u\u00fb]t|" +
  "septembre|octobre|novembre|d[e\u00e9]cembre)";

const MONTHS_DE =
  "(?:Januar|Februar|M[a\u00e4]rz|April|Mai|Juni|Juli|August|" +
  "September|Oktober|November|Dezember)";

const MONTHS_ES =
  "(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|" +
  "septiembre|octubre|noviembre|diciembre)";

const MONTHS_IT =
  "(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|" +
  "settembre|ottobre|novembre|dicembre)";

// Combined i18n months — strip the outer (?:...) from each and combine
const MONTHS_I18N =
  `(?:${MONTHS_EN.slice(3, -1)}|${MONTHS_FR.slice(3, -1)}|${MONTHS_DE.slice(3, -1)}|${MONTHS_ES.slice(3, -1)}|${MONTHS_IT.slice(3, -1)})`;

const DOLLAR_PATTERN = /[$€£¥][\d,]+\.?\d*|\b\d+[.,]\d{2}\s*(?:USD|EUR|GBP|JPY|CAD|AUD)\b/g;

const DATE_PATTERN = new RegExp(
  // Family 1: numeric separators
  String.raw`\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}` +
  String.raw`|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}` +
  // Family 2: month-name leading (English)
  `|\\b${MONTHS_EN}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b` +
  // Family 3: day-leading European (English)
  `|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS_EN}\\s+\\d{4}\\b` +
  // Family 4: month + year without day
  `|\\b${MONTHS_EN},?\\s+\\d{4}\\b` +
  // Family 5: quarter reference
  String.raw`|\bQ[1-4][\s-]+(?:FY\s*)?\d{2,4}\b` +
  // Family 6: fiscal-year prefix
  String.raw`|\bFY\s*\d{2,4}(?:[/\-]\d{2,4})?\b` +
  // Family 7: non-English month-name leading + day-leading
  `|\\b${MONTHS_I18N}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b` +
  `|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?${MONTHS_I18N}(?:\\s+de)?\\s+\\d{4}\\b` +
  `|\\b${MONTHS_I18N},?\\s+\\d{4}\\b`,
  "gi",
);

const KEY_VALUE_PATTERN = /^[\w\s]+:\s+\S+/gm;
const TABLE_ROW_PATTERN = /\|.*\|.*\|/g;

function compileCustomSignals(
  schemaDef: Record<string, unknown> | null | undefined,
): [string, RegExp][] {
  if (!schemaDef) return [];
  const signalsDef = schemaDef.signals as Record<string, Record<string, string>> | undefined;
  if (!signalsDef || typeof signalsDef !== "object") return [];

  const compiled: [string, RegExp][] = [];
  for (const [name, spec] of Object.entries(signalsDef)) {
    if (!spec || typeof spec !== "object") continue;
    const pattern = spec.pattern;
    if (!pattern) continue;

    let flags = "g";
    const flagStr = spec.flags ?? "";
    if (flagStr.includes("i")) flags += "i";
    if (flagStr.includes("m")) flags += "m";
    if (flagStr.includes("s")) flags += "s";

    try {
      compiled.push([name, new RegExp(pattern, flags)]);
    } catch {
      // Skip invalid patterns silently
      continue;
    }
  }
  return compiled;
}

export function detectSignals(
  content: string,
  customSignals?: [string, RegExp][] | null,
): Record<string, boolean | number> {
  const signals: Record<string, boolean | number> = {};

  const dollars = content.match(DOLLAR_PATTERN);
  if (dollars) {
    signals.has_dollar_amounts = true;
    signals.dollar_count = dollars.length;
  }

  const dates = content.match(DATE_PATTERN);
  if (dates) {
    signals.has_dates = true;
    signals.date_count = dates.length;
  }

  const kvPairs = content.match(KEY_VALUE_PATTERN);
  if (kvPairs) {
    signals.has_key_value_pairs = true;
    signals.kv_count = kvPairs.length;
  }

  const tableRows = content.match(TABLE_ROW_PATTERN);
  if (tableRows) {
    signals.has_tables = true;
    signals.table_row_count = tableRows.length;
  }

  if (customSignals) {
    for (const [name, pattern] of customSignals) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches) {
        signals[name] = true;
        signals[`${name}_count`] = matches.length;
      }
    }
  }

  return signals;
}

// ── Heading Inference ───────────────────────────────────────────────

const HAS_MARKDOWN_HEADING_RE = /^#{1,6}[ \t]+\S/m;
const BOLD_LINE_RE = /^\*\*([^*]+?)\*\*:?\s*$/;
const ALLCAPS_LINE_RE = /^[A-Z][A-Z0-9 &/\-]{2,60}:?$/;
const HEADING_MAX_LEN = 80;
const CHUNK_MAX_LINES = 500;
const STANZA_DISBAND_THRESHOLD = 5;

function looksLikeHeadingText(text: string): boolean {
  const alpha = [...text].filter((c) => /[a-zA-Z]/.test(c)).length;
  return alpha >= 3 && alpha / Math.max(text.length, 1) >= 0.3;
}

function compileHeadingPatterns(
  schemaDef: Record<string, unknown> | null | undefined,
): RegExp[] {
  if (!schemaDef) return [];
  const headings = schemaDef.headings as Record<string, unknown> | undefined;
  if (!headings || typeof headings !== "object") return [];
  const patterns = headings.patterns as string[] | undefined;
  if (!patterns || !Array.isArray(patterns)) return [];

  const compiled: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== "string") continue;
    try {
      compiled.push(new RegExp(p));
    } catch {
      continue;
    }
  }
  return compiled;
}

function headingInferenceEnabled(schemaDef: Record<string, unknown> | null | undefined): boolean {
  if (!schemaDef) return true;
  const headings = schemaDef.headings as Record<string, unknown> | undefined;
  if (!headings || typeof headings !== "object") return true;
  return headings.infer !== false;
}

function genericHeadingHeuristicsEnabled(schemaDef: Record<string, unknown> | null | undefined): boolean {
  if (!schemaDef) return true;
  const headings = schemaDef.headings as Record<string, unknown> | undefined;
  if (!headings || typeof headings !== "object") return true;
  return headings.generic !== false;
}

function inferHeadings(markdown: string, schemaDef: Record<string, unknown> | null | undefined): string {
  if (HAS_MARKDOWN_HEADING_RE.test(markdown)) return markdown;
  if (!headingInferenceEnabled(schemaDef)) return markdown;

  const schemaPatterns = compileHeadingPatterns(schemaDef);
  const genericEnabled = genericHeadingHeuristicsEnabled(schemaDef);
  const lines = markdown.split("\n");
  const out: string[] = [];

  // Stanza: consecutive bold/ALL CAPS lines
  const stanza: [number, string][] = [];

  function flushStanza(): void {
    if (stanza.length === 0) return;
    if (stanza.length >= STANZA_DISBAND_THRESHOLD) {
      stanza.length = 0;
      return;
    }
    const merged = stanza.map(([, text]) => text).join(" ");
    const firstIdx = stanza[0]![0];
    out[firstIdx] = `## ${merged}`;
    stanza.length = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trim();

    if (!stripped) {
      out.push(line);
      continue;
    }

    const aboveBlank = i === 0 || lines[i - 1]!.trim() === "";
    let schemaPromoted: string | null = null;
    let heuristicText: string | null = null;

    if (aboveBlank) {
      for (const pat of schemaPatterns) {
        // fullmatch equivalent: anchor the regex
        const fullMatch = new RegExp(`^(?:${pat.source})$`, pat.flags);
        if (fullMatch.test(stripped)) {
          schemaPromoted = stripped.replace(/:$/, "").trim();
          break;
        }
      }

      if (schemaPromoted === null && genericEnabled) {
        const m = BOLD_LINE_RE.exec(stripped);
        if (m) {
          const captured = m[1]!.trim();
          if (captured.length <= HEADING_MAX_LEN && looksLikeHeadingText(captured)) {
            heuristicText = captured.replace(/:$/, "").trim();
          }
        } else if (ALLCAPS_LINE_RE.test(stripped)) {
          heuristicText = stripped.replace(/:$/, "").trim();
        }
      }
    }

    if (heuristicText !== null) {
      stanza.push([out.length, heuristicText]);
      out.push(line);
    } else {
      flushStanza();
      if (schemaPromoted !== null) {
        out.push(`## ${schemaPromoted}`);
      } else {
        out.push(line);
      }
    }
  }

  flushStanza();
  return out.join("\n");
}

// ── Table Cell Deduplication ────────────────────────────────────────

const TABLE_ROW_CELL_MIN_RUN = 3;
const TABLE_ROW_PREFIX_RE = /^\s*\|/;

function rowIsTripled(parts: string[]): boolean {
  let i = 0;
  while (i < parts.length) {
    const current = parts[i]!.trim();
    if (!current) {
      i++;
      continue;
    }
    let runEnd = i + 1;
    while (runEnd < parts.length && parts[runEnd]!.trim() === current) {
      runEnd++;
    }
    const runLength = runEnd - i;
    if (runLength >= TABLE_ROW_CELL_MIN_RUN && /[a-zA-Z]/.test(current)) {
      return true;
    }
    i = runEnd;
  }
  return false;
}

function dedupeTableRowRepeats(markdown: string): string {
  if (!markdown.includes("|")) return markdown;

  const outLines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!TABLE_ROW_PREFIX_RE.test(line)) {
      outLines.push(line);
      continue;
    }

    const stripped = line.trim();
    if ([...stripped].every((c) => "-:| \t".includes(c))) {
      outLines.push(line);
      continue;
    }

    const parts = line.split("|");
    if (!rowIsTripled(parts)) {
      outLines.push(line);
      continue;
    }

    // Collapse runs of identical cells
    const newParts: string[] = [];
    let i = 0;
    while (i < parts.length) {
      const current = parts[i]!;
      const currentStripped = current.trim();
      if (!currentStripped) {
        newParts.push(current);
        i++;
        continue;
      }
      let runEnd = i + 1;
      while (runEnd < parts.length && parts[runEnd]!.trim() === currentStripped) {
        runEnd++;
      }
      const runLength = runEnd - i;
      if (runLength >= TABLE_ROW_CELL_MIN_RUN) {
        newParts.push(current);
        i = runEnd;
      } else {
        newParts.push(current);
        i++;
      }
    }
    outLines.push(newParts.join("|"));
  }

  return outLines.join("\n");
}

// ── Oversized Chunk Splitting ───────────────────────────────────────

function splitAtParagraphs(lines: string[], maxLines: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    current.push(line);
    if (current.length >= maxLines && line.trim() === "") {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }

  // Hard-cut any group still oversized
  const final: string[][] = [];
  for (const group of groups) {
    if (group.length <= maxLines) {
      final.push(group);
      continue;
    }
    for (let start = 0; start < group.length; start += maxLines) {
      final.push(group.slice(start, start + maxLines));
    }
  }
  return final;
}

function splitOversizedChunks(
  chunks: Chunk[],
  categoryKeywords: [string[], string][],
  classificationConfig: ClassificationConfig,
  customSignals: [string, RegExp][],
): Chunk[] {
  const out: Chunk[] = [];
  let nextIndex = 0;

  for (const chunk of chunks) {
    const lines = chunk.content.split("\n");
    if (lines.length <= CHUNK_MAX_LINES) {
      out.push(makeChunk(nextIndex, chunk.title, chunk.content, chunk.category, chunk.signals));
      nextIndex++;
      continue;
    }

    const parts = splitAtParagraphs(lines, CHUNK_MAX_LINES);
    for (let i = 0; i < parts.length; i++) {
      const partContent = parts[i]!.join("\n").trim();
      if (!partContent) continue;
      const title = i === 0 ? chunk.title : `${chunk.title} (part ${i + 1})`;
      const category = classifyChunk(title, partContent, categoryKeywords, classificationConfig);
      const signals = detectSignals(partContent, customSignals);
      out.push(makeChunk(nextIndex, title, partContent, category, signals));
      nextIndex++;
    }
  }
  return out;
}

// ── Main Entry Point ────────────────────────────────────────────────

export function buildDocumentMap(
  markdown: string,
  schemaDef?: Record<string, unknown> | null,
): Chunk[] {
  if (!markdown || !markdown.trim()) return [];

  // Preprocessing
  markdown = dedupeTableRowRepeats(markdown);
  markdown = inferHeadings(markdown, schemaDef ?? null);

  const categoryKeywords = buildCategoryKeywords(schemaDef ?? null);
  const customSignals = compileCustomSignals(schemaDef ?? null);
  const classificationConfig = buildClassificationConfig(schemaDef ?? null);

  const chunks: Chunk[] = [];
  let currentTitle = "Document Start";
  let currentLines: string[] = [];
  let index = 0;

  function finalize(): void {
    const content = currentLines.join("\n").trim();
    if (!content) return;
    const category = classifyChunk(currentTitle, content, categoryKeywords, classificationConfig);
    const signals = detectSignals(content, customSignals);
    chunks.push(makeChunk(index, currentTitle, content, category, signals));
    index++;
  }

  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      finalize();
      currentTitle = line.replace(/^#+\s*/, "");
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  finalize();

  return splitOversizedChunks(chunks, categoryKeywords, classificationConfig, customSignals);
}
