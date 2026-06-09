/**
 * Packet splitter — classifies a multi-document packet into typed sections.
 *
 * TypeScript port of services/extract/packet_splitter.py.
 *
 * An optional pipeline stage between chunking and routing that recognizes
 * when a single upload contains multiple logically distinct documents
 * and splits them into contiguous chunk-range sections so each can be
 * extracted with the appropriate schema.
 */

import type { Chunk } from "./document-map";
import type { ModelProvider } from "./providers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Catch-all type the classifier uses for unrecognized blocks. */
export const OTHER_TYPE_ID = "other";

/** Fallback type when the classifier fails entirely or doc is too short. */
export const FALLBACK_TYPE_ID = "document";

const CHUNK_PREVIEW_CHARS = 400;

/** Documents at or below this chunk count skip the LLM classifier. */
export const DEFAULT_SHORT_DOC_CHUNKS = 2;

/**
 * Fraction of chunks a single non-other type must cover for the
 * post-classify coalesce step to fire.
 */
export const DEFAULT_COALESCE_OTHER_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Section {
  type: string;
  startChunk: number;
  endChunk: number;
  chunks: Chunk[];
  confidence: number;
}

export interface ClassifyResult {
  sections: Section[];
  corrections: number;
  classifierSkipped: boolean;
}

interface ClassifyOptions {
  shortDocChunks?: number;
  coalesceOtherThreshold?: number;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildClassifierPrompt(chunks: Chunk[], types: Array<{ id?: string; description?: string }>): string {
  const typeLines: string[] = [];
  for (const t of types) {
    if (typeof t !== "object" || t === null) continue;
    const typeId = t.id;
    if (typeof typeId !== "string" || !typeId.trim()) continue;
    const description = (t.description ?? "").trim() || typeId;
    typeLines.push(`- ${typeId}: ${description}`);
  }
  typeLines.push(`- ${OTHER_TYPE_ID}: Anything not matching the types above.`);

  const chunkBlock = chunks
    .map((c) => `[${c.index}] ${c.title}\n${c.content.slice(0, CHUNK_PREVIEW_CHARS)}`)
    .join("\n\n");

  return `You're given a document that may be a single item or a packet of several stapled-together documents. Identify each logical document in the packet and return its type and chunk range.

Types:
${typeLines.join("\n")}

Rules:
- Each chunk belongs to exactly one section.
- Section ranges must be contiguous (start_chunk to end_chunk, inclusive).
- Sections must not overlap.
- Every chunk in the document must belong to some section — no gaps.
- If unsure about a block, use type "${OTHER_TYPE_ID}" rather than inventing.

Return JSON in this exact shape:
{
  "sections": [
    {"type": "invoice", "start_chunk": 0, "end_chunk": 4, "confidence": 0.96}
  ]
}

Chunks to classify:

${chunkBlock}
`;
}

// ---------------------------------------------------------------------------
// JSON parser (tolerant of markdown fences etc.)
// ---------------------------------------------------------------------------

function parseClassifierJson(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fallback section
// ---------------------------------------------------------------------------

function fallbackSection(chunks: Chunk[]): Section {
  return {
    type: FALLBACK_TYPE_ID,
    startChunk: 0,
    endChunk: Math.max(0, chunks.length - 1),
    chunks,
    confidence: 0,
  };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Turn a raw classifier response into validated Sections.
 *
 * Handles 8 failure modes — see packet_splitter.py docstring for details.
 */
export function normalizeClassifierResponse(
  rawResponse: Record<string, unknown> | null,
  totalChunks: number,
  validTypeIds: Set<string>,
  chunks?: Chunk[],
): [Section[], number] {
  let corrections = 0;

  if (totalChunks <= 0) return [[], 0];

  // Provide stub chunks if caller didn't pass them (for unit testing the normalizer directly)
  const resolvedChunks =
    chunks ??
    Array.from({ length: totalChunks }, (_, i) => ({
      index: i,
      title: `Chunk ${i}`,
      content: "",
      signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: false },
      charOffset: 0,
      charLength: 0,
    }));

  if (rawResponse === null || typeof rawResponse !== "object" || Array.isArray(rawResponse)) {
    return [
      [fallbackSection(resolvedChunks)],
      1,
    ];
  }

  const rawSections = rawResponse.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    return [
      [fallbackSection(resolvedChunks)],
      1,
    ];
  }

  // Step 1: validate each section in isolation
  interface ValidatedEntry {
    type: string;
    start: number;
    end: number;
    confidence: number;
  }

  const validated: ValidatedEntry[] = [];

  for (const entry of rawSections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      corrections++;
      continue;
    }

    let stype = (entry as Record<string, unknown>).type;
    const start = (entry as Record<string, unknown>).start_chunk;
    const end = (entry as Record<string, unknown>).end_chunk;
    const confRaw = (entry as Record<string, unknown>).confidence ?? 0;

    if (typeof stype !== "string" || !stype.trim()) {
      corrections++;
      continue;
    }
    if (typeof start !== "number" || typeof end !== "number") {
      corrections++;
      continue;
    }
    if (start < 0 || end < 0 || start >= totalChunks || end >= totalChunks) {
      corrections++;
      continue;
    }
    if (start > end) {
      corrections++;
      continue;
    }

    if (stype !== OTHER_TYPE_ID && !validTypeIds.has(stype)) {
      corrections++;
      stype = OTHER_TYPE_ID;
    }

    let conf = typeof confRaw === "number" ? confRaw : parseFloat(String(confRaw));
    if (isNaN(conf)) conf = 0;
    conf = Math.max(0, Math.min(1, conf));

    validated.push({ type: stype, start, end, confidence: conf });
  }

  if (validated.length === 0) {
    return [
      [fallbackSection(resolvedChunks)],
      corrections + 1,
    ];
  }

  // Step 2: sort by start and resolve overlaps (first-start-wins)
  validated.sort((a, b) => a.start - b.start || a.end - b.end);

  const cleaned: ValidatedEntry[] = [];
  let lastEnd = -1;

  for (const entry of validated) {
    let { start } = entry;
    const { end } = entry;

    if (start <= lastEnd) {
      corrections++;
      const newStart = lastEnd + 1;
      if (newStart > end) continue; // entirely consumed
      start = newStart;
      cleaned.push({ ...entry, start });
    } else {
      cleaned.push(entry);
    }
    lastEnd = cleaned[cleaned.length - 1].end;
  }

  if (cleaned.length === 0) {
    return [
      [fallbackSection(resolvedChunks)],
      corrections + 1,
    ];
  }

  // Step 3: fill gaps with "other" sections
  const withGaps: ValidatedEntry[] = [];
  let cursor = 0;

  for (const entry of cleaned) {
    if (entry.start > cursor) {
      corrections++;
      withGaps.push({
        type: OTHER_TYPE_ID,
        start: cursor,
        end: entry.start - 1,
        confidence: 0,
      });
    }
    withGaps.push(entry);
    cursor = entry.end + 1;
  }

  if (cursor < totalChunks) {
    corrections++;
    withGaps.push({
      type: OTHER_TYPE_ID,
      start: cursor,
      end: totalChunks - 1,
      confidence: 0,
    });
  }

  const sections: Section[] = withGaps.map((entry) => ({
    type: entry.type,
    startChunk: entry.start,
    endChunk: entry.end,
    chunks: resolvedChunks.slice(entry.start, entry.end + 1),
    confidence: entry.confidence,
  }));

  return [sections, corrections];
}

// ---------------------------------------------------------------------------
// Coalescer
// ---------------------------------------------------------------------------

/**
 * Collapse other-sprinkled single-document output into one typed section.
 */
export function coalesceOtherSections(
  sections: Section[],
  totalChunks: number,
  threshold: number,
  allChunks?: Chunk[],
): [Section[], string | null] {
  if (threshold <= 0 || totalChunks <= 0 || sections.length === 0) {
    return [sections, null];
  }

  const hasOther = sections.some((s) => s.type === OTHER_TYPE_ID);
  if (!hasOther) return [sections, null];

  const chunksByType: Record<string, number> = {};
  const confByType: Record<string, number[]> = {};

  for (const s of sections) {
    if (s.type === OTHER_TYPE_ID || s.type === FALLBACK_TYPE_ID) continue;
    const count = s.endChunk - s.startChunk + 1;
    chunksByType[s.type] = (chunksByType[s.type] ?? 0) + count;
    confByType[s.type] = confByType[s.type] ?? [];
    confByType[s.type].push(s.confidence);
  }

  const typeKeys = Object.keys(chunksByType);
  if (typeKeys.length === 0) return [sections, null];

  let dominantType = typeKeys[0];
  for (const t of typeKeys) {
    if (chunksByType[t] > chunksByType[dominantType]) dominantType = t;
  }

  const dominantFraction = chunksByType[dominantType] / totalChunks;
  if (dominantFraction < threshold) return [sections, null];

  const confs = confByType[dominantType] ?? [0];
  const mergedConf = confs.reduce((a, b) => a + b, 0) / confs.length;

  const resolvedChunks =
    allChunks ??
    Array.from({ length: totalChunks }, (_, i) => ({
      index: i,
      title: `Chunk ${i}`,
      content: "",
      signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: false },
      charOffset: 0,
      charLength: 0,
    }));

  const coalesced: Section = {
    type: dominantType,
    startChunk: 0,
    endChunk: totalChunks - 1,
    chunks: resolvedChunks,
    confidence: mergedConf,
  };

  return [[coalesced], dominantType];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function classifyChunksToSections(
  chunks: Chunk[],
  provider: ModelProvider,
  types: Array<{ id?: string; description?: string }>,
  options?: ClassifyOptions,
): Promise<ClassifyResult> {
  const shortDocChunks = options?.shortDocChunks ?? DEFAULT_SHORT_DOC_CHUNKS;
  const coalesceThreshold = options?.coalesceOtherThreshold ?? DEFAULT_COALESCE_OTHER_THRESHOLD;

  if (chunks.length === 0) {
    return { sections: [], corrections: 0, classifierSkipped: false };
  }

  if (shortDocChunks > 0 && chunks.length <= shortDocChunks) {
    return {
      sections: [fallbackSection(chunks)],
      corrections: 0,
      classifierSkipped: true,
    };
  }

  const validTypeIds = new Set(
    types
      .filter((t) => typeof t === "object" && t !== null && typeof t.id === "string" && t.id.trim())
      .map((t) => t.id!),
  );

  const prompt = buildClassifierPrompt(chunks, types);

  let raw: string | null = null;
  let error: string | null = null;

  try {
    raw = await provider.generate(prompt, true);
  } catch (exc: unknown) {
    const name = exc instanceof Error ? exc.constructor.name : "Error";
    const msg = exc instanceof Error ? exc.message : String(exc);
    error = `${name}: ${msg}`;
    console.log(`[koji-classify] Classifier error: ${error} — falling back to whole-document section`);
  }

  const parsed = raw !== null ? parseClassifierJson(raw) : null;
  let [sections, corrections] = normalizeClassifierResponse(parsed, chunks.length, validTypeIds, chunks);

  let coalesced: [Section[], string | null];
  coalesced = coalesceOtherSections(sections, chunks.length, coalesceThreshold, chunks);
  sections = coalesced[0];

  return {
    sections,
    corrections,
    classifierSkipped: false,
  };
}
