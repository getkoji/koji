/**
 * Context-window budgeting for extraction prompts.
 *
 * Every extraction call reserves `completionReserve(contextTokens)` for the
 * response, so the prompt itself must fit in the model's context window minus
 * that reserve. The window is per-model: it comes from the provider
 * (`ModelProvider.contextTokens`), not a global constant, because an 8k local
 * model and a 128k hosted model need very different split points.
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
 * Token estimation is content-aware, not a flat chars/token ratio. Running
 * prose tokenizes at ~4 chars/token, but digit runs and non-ASCII/control bytes
 * are far denser: a broken font layer (glyph-id bytes, no ToUnicode CMap) or a
 * number-heavy table measured ~1.1–1.2 chars/token with the o200k tokenizer —
 * 3× what a flat 3.25 assumes. A flat ratio therefore *undercounts* exactly the
 * documents that overflow, letting a 350k-token prompt slip past the guard and
 * hit the model's 128k wall as an unrecoverable 400. We instead weight each
 * character class by its measured token cost so the estimate stays at-or-above
 * the real count for dense content while leaving clean prose unchanged.
 * Underestimating means a 400 instead of one extra split, so the estimate errs
 * toward splitting; the group extractor also retries-on-overflow as a backstop
 * for the residual cases where even this estimate guesses low.
 */

import type { Chunk } from "./chunker";

/** Default context window for the hosted providers. 128k is the floor across
 * the mainstream extraction models (gpt-4o, gpt-4o-mini, claude); larger-window
 * models simply split less often than they strictly need to. Providers report
 * their real window via `ModelProvider.contextTokens` — this is only the
 * fallback when configuration doesn't say. */
export const DEFAULT_CONTEXT_TOKENS = 128_000;

/** Upper bound on the completion reserve. The reserve itself is
 * `completionReserve(contextTokens)`; providers send exactly that as their
 * `max_tokens` / `num_predict`, so the budgeting reserve and the cap the model
 * is actually given are one number rather than two constants that drift. */
export const COMPLETION_MAX_TOKENS = 16_384;

/** Headroom for estimation error and message scaffolding, for a mainstream
 * window. Scaled down proportionally for small windows — see `safetyMargin`. */
const SAFETY_MARGIN_TOKENS = 2_048;

/** Fraction of the window a completion may claim. A small-window model cannot
 * spend 16k tokens on the response and still have room for a prompt, so the
 * reserve tracks the window instead of being a flat constant. */
const COMPLETION_RESERVE_FRACTION = 4;

/** Fraction of the window given to estimation headroom on small windows. */
const SAFETY_MARGIN_FRACTION = 16;

/**
 * Tokens reserved for the model's response given a context window. Providers
 * send this value as their `max_tokens` (`num_predict` on Ollama), so the
 * amount the budget subtracts is exactly the amount the model may produce.
 *
 * Capped at `COMPLETION_MAX_TOKENS` (a mainstream 128k window resolves to
 * 16,384, unchanged) and at a quarter of the window below that.
 */
export function completionReserve(contextTokens: number = DEFAULT_CONTEXT_TOKENS): number {
  return Math.max(
    1,
    Math.min(COMPLETION_MAX_TOKENS, Math.floor(contextTokens / COMPLETION_RESERVE_FRACTION)),
  );
}

/** Estimation headroom for a window: the flat margin on mainstream windows,
 * proportional on small ones (a fixed 2k margin would eat a quarter of an 8k
 * window on top of the completion reserve and leave almost nothing to read). */
function safetyMargin(contextTokens: number): number {
  return Math.max(
    0,
    Math.min(SAFETY_MARGIN_TOKENS, Math.floor(contextTokens / SAFETY_MARGIN_FRACTION)),
  );
}

/** Chars per token for running prose / ASCII letters and spaces — the loosest
 * (most token-efficient) class, where BPE merges whole words. */
const CHARS_PER_TOKEN = 3.25;

/** Per-chunk prompt scaffolding: `### {title}\n\n` plus the `\n\n---\n\n`
 * separator between blocks. */
const CHUNK_BLOCK_OVERHEAD_CHARS = 16;

/** Token cost per character by class, calibrated against o200k_base on real
 * documents (see the estimator comment). Costs are conservative: each is at or
 * above the measured cost so a prompt is never estimated smaller than it
 * tokenizes.
 *   - digits: ~1.15 chars/token (o200k groups ≤3 digits/token, but mixed
 *     numeric/punctuation tables run denser) → 1/1.15 ≈ 0.87 tok/char
 *   - non-ASCII / C0 control: worst case, ~1.6 tok/char (multibyte UTF-8 and
 *     lone control/0xFF bytes from broken font layers each cost ≥1 token, often
 *     more) — clean text has ~0 of these, so this never inflates prose
 *   - other ASCII punctuation/symbols: ~2 chars/token */
const TOK_PER_DIGIT = 1 / 1.15;
const TOK_PER_NONPRINT = 1.6;
const TOK_PER_OTHER_ASCII = 1 / 2.0;
const TOK_PER_PROSE = 1 / CHARS_PER_TOKEN;

/**
 * Estimate the token count of `text`, weighting each character by the token
 * cost of its class. Deliberately conservative (never under-counts on the
 * dense/garbled content that overflows) while matching the old flat estimate on
 * clean prose, which is almost entirely letters and spaces.
 */
export function estimateTokens(text: string): number {
  let digits = 0;
  let nonPrint = 0;
  let otherAscii = 0;
  let prose = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) {
      // Non-ASCII or a C0 control other than tab/newline/CR: the token-dense
      // classes — multibyte glyphs and the lone control/0xFF bytes a broken
      // ToUnicode CMap leaks into the text layer.
      nonPrint++;
    } else if (c >= 48 && c <= 57) {
      digits++;
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 9 || c === 10 || c === 13) {
      prose++;
    } else {
      otherAscii++;
    }
  }
  return Math.ceil(
    prose * TOK_PER_PROSE +
      digits * TOK_PER_DIGIT +
      nonPrint * TOK_PER_NONPRINT +
      otherAscii * TOK_PER_OTHER_ASCII,
  );
}

/** Whether a fully-built prompt fits the context window with the completion
 * reserve and safety margin. Pass the provider's `contextTokens` — the default
 * is only for callers with no provider in hand. */
export function promptFits(
  prompt: string,
  contextTokens: number = DEFAULT_CONTEXT_TOKENS,
): boolean {
  return (
    estimateTokens(prompt) + completionReserve(contextTokens) + safetyMargin(contextTokens) <=
    contextTokens
  );
}

/** Character budget for an entire prompt (everything but the completion). */
export function promptCharBudget(
  contextTokens: number = DEFAULT_CONTEXT_TOKENS,
): number {
  return Math.max(
    0,
    Math.floor(
      (contextTokens - completionReserve(contextTokens) - safetyMargin(contextTokens)) *
        CHARS_PER_TOKEN,
    ),
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
