/**
 * Context-window budgeting for extraction prompts.
 *
 * Every extraction call reserves `COMPLETION_MAX_TOKENS` for the response, so
 * the prompt itself must fit in the model's context window minus that reserve.
 * Nothing between the parser and the provider used to enforce this: chunks are
 * split by heading (unbounded size for heading-poor documents), the router caps
 * chunk *counts* but never characters, and prompt builders concatenate chunk
 * content verbatim — so a large document produced a prompt past the window and
 * the provider returned 400 `context_length_exceeded`.
 *
 * This module is the guard: estimate a prompt's token count, and when a chunk
 * set is too large for one call, pack it into consecutive budget-fitting
 * subsets (splitting any single oversized chunk at line boundaries). The
 * callers in group-extract.ts run one call per subset and merge the results.
 *
 * Token estimation is chars/3.25 — deliberately conservative. Dense markdown
 * tables (pipes, numbers) tokenize at ~3–3.5 chars/token, well below the ~4 of
 * running prose; underestimating tokens here means a 400 instead of one extra
 * split, so the estimate errs toward splitting.
 */

import type { Chunk } from "./chunker";

/** Assumed model context window. 128k is the floor across the mainstream
 * extraction models (gpt-4o, gpt-4o-mini, claude); larger-window models simply
 * split less often than they strictly need to. */
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/** Completion reserve — must match the `max_tokens` the providers send. */
export const COMPLETION_MAX_TOKENS = 16_384;

/** Headroom for estimation error and message scaffolding. */
const SAFETY_MARGIN_TOKENS = 2_048;

const CHARS_PER_TOKEN = 3.25;

/** Per-chunk prompt scaffolding: `### {title}\n\n` plus the `\n\n---\n\n`
 * separator between blocks. */
const CHUNK_BLOCK_OVERHEAD_CHARS = 16;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Whether a fully-built prompt fits the context window with the completion
 * reserve and safety margin. */
export function promptFits(
  prompt: string,
  contextTokens: number = DEFAULT_CONTEXT_TOKENS,
): boolean {
  return (
    estimateTokens(prompt) + COMPLETION_MAX_TOKENS + SAFETY_MARGIN_TOKENS <= contextTokens
  );
}

/** Character budget for an entire prompt (everything but the completion). */
export function promptCharBudget(
  contextTokens: number = DEFAULT_CONTEXT_TOKENS,
): number {
  return Math.floor(
    (contextTokens - COMPLETION_MAX_TOKENS - SAFETY_MARGIN_TOKENS) * CHARS_PER_TOKEN,
  );
}

/**
 * Split one oversized chunk into parts of at most `maxChars` at line
 * boundaries (hard-cutting a single line longer than the cap — wide table rows
 * can be enormous single lines). Part 1 keeps the original title; later parts
 * get ` (part N)`, mirroring the line-count splitter in document-map. Char
 * offsets track the parent so positional metadata stays roughly meaningful.
 */
export function splitChunkByChars(chunk: Chunk, maxChars: number): Chunk[] {
  if (chunk.content.length <= maxChars) return [chunk];

  const pieces: string[] = [];
  for (const line of chunk.content.split("\n")) {
    if (line.length <= maxChars) {
      pieces.push(line);
      continue;
    }
    for (let start = 0; start < line.length; start += maxChars) {
      pieces.push(line.slice(start, start + maxChars));
    }
  }

  const parts: Chunk[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let consumed = 0;

  const flush = (): void => {
    if (currentChars === 0) return;
    const content = current.join("\n");
    const n = parts.length;
    parts.push({
      ...chunk,
      title: n === 0 ? chunk.title : `${chunk.title} (part ${n + 1})`,
      content,
      charOffset: chunk.charOffset !== undefined ? chunk.charOffset + consumed : undefined,
      charLength: content.length,
    });
    consumed += content.length + 1; // +1 for the newline between parts
    current = [];
    currentChars = 0;
  };

  for (const piece of pieces) {
    if (currentChars > 0 && currentChars + piece.length + 1 > maxChars) flush();
    current.push(piece);
    currentChars += piece.length + (current.length > 1 ? 1 : 0);
  }
  flush();

  return parts;
}

/**
 * Pack chunks into consecutive subsets whose combined content fits
 * `contentCharBudget`. Order is preserved (subsets are consecutive runs, so
 * each call reads a contiguous stretch of the document). A single chunk larger
 * than the budget is split first via `splitChunkByChars`. Always returns at
 * least one subset, and no subset is empty.
 */
export function packChunksToBudget(
  chunks: Chunk[],
  contentCharBudget: number,
): Chunk[][] {
  const weight = (c: Chunk): number =>
    c.content.length + c.title.length + CHUNK_BLOCK_OVERHEAD_CHARS;

  const expanded: Chunk[] = [];
  for (const chunk of chunks) {
    if (weight(chunk) > contentCharBudget) {
      expanded.push(
        ...splitChunkByChars(
          chunk,
          Math.max(1, contentCharBudget - chunk.title.length - CHUNK_BLOCK_OVERHEAD_CHARS - 16),
        ),
      );
    } else {
      expanded.push(chunk);
    }
  }

  const bins: Chunk[][] = [];
  let bin: Chunk[] = [];
  let binChars = 0;
  for (const chunk of expanded) {
    const w = weight(chunk);
    if (bin.length > 0 && binChars + w > contentCharBudget) {
      bins.push(bin);
      bin = [];
      binChars = 0;
    }
    bin.push(chunk);
    binChars += w;
  }
  if (bin.length > 0) bins.push(bin);

  return bins.length > 0 ? bins : [[]];
}
