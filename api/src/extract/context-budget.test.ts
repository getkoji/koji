import { describe, it, expect } from "vitest";
import type { Chunk } from "./chunker";
import {
  COMPLETION_MAX_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  estimateTokens,
  packChunksToBudget,
  promptCharBudget,
  promptFits,
  splitChunkByChars,
} from "./context-budget";

function makeChunk(index: number, title: string, content: string): Chunk {
  return { index, title, content, signals: {}, charOffset: 0, charLength: content.length };
}

describe("estimateTokens", () => {
  it("estimates conservatively (under 4 chars per token)", () => {
    expect(estimateTokens("x".repeat(400))).toBeGreaterThanOrEqual(100);
  });

  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  // oss-434: the estimate is content-aware. Digit-dense and non-ASCII/control
  // content tokenizes far denser than prose, so for the same length the
  // estimate must be higher — a flat chars/token ratio undercounts exactly the
  // documents that overflow.
  it("estimates digit-dense content higher than prose of the same length", () => {
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(1000);
    const digits = "1234567890".repeat(prose.length / 10);
    expect(estimateTokens(digits)).toBeGreaterThan(estimateTokens(prose));
  });

  it("estimates control/0xFF garbage near one token per char", () => {
    // A broken font layer leaks C0 control bytes and 0xFF in place of text.
    const garbage = "ÿ".repeat(10_000);
    // Measured ~1.1 chars/token on real garbled docs; the estimate must be at
    // least ~1 token/char so it never clears a prompt the model will reject.
    expect(estimateTokens(garbage)).toBeGreaterThanOrEqual(garbage.length);
  });

  it("leaves clean prose roughly at the old flat estimate (no over-split regression)", () => {
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(1000);
    const flat = Math.ceil(prose.length / 3.25);
    const est = estimateTokens(prose);
    // Within ~10% of the historical estimate for prose.
    expect(est).toBeGreaterThanOrEqual(Math.floor(flat * 0.9));
    expect(est).toBeLessThanOrEqual(Math.ceil(flat * 1.1));
  });
});

describe("promptFits", () => {
  it("accepts a small prompt", () => {
    expect(promptFits("Extract the following fields.")).toBe(true);
  });

  it("rejects a prompt near the full context window", () => {
    // ~128k tokens of content — no room for the completion reserve.
    expect(promptFits("x".repeat(DEFAULT_CONTEXT_TOKENS * 4))).toBe(false);
  });

  it("rejects a prompt that only exceeds the window with the completion reserve", () => {
    // Fits the window alone, but not window - completion - margin. This is the
    // exact production failure: 114,675 message tokens + 16,384 completion.
    const chars = promptCharBudget() + COMPLETION_MAX_TOKENS; // safely past the budget
    expect(estimateTokens("x".repeat(chars))).toBeLessThan(DEFAULT_CONTEXT_TOKENS);
    expect(promptFits("x".repeat(chars))).toBe(false);
  });
});

describe("splitChunkByChars", () => {
  it("returns the chunk unchanged when under the cap", () => {
    const chunk = makeChunk(0, "Section", "short content");
    expect(splitChunkByChars(chunk, 1000)).toEqual([chunk]);
  });

  it("splits at line boundaries, first part keeping the title", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"y".repeat(50)}`);
    const chunk = makeChunk(3, "Big Section", lines.join("\n"));
    const parts = splitChunkByChars(chunk, 1000);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.title).toBe("Big Section");
    expect(parts[1]!.title).toBe("Big Section (part 2)");
    for (const p of parts) {
      expect(p.content.length).toBeLessThanOrEqual(1000);
    }
    // No content lost
    expect(parts.map((p) => p.content).join("\n")).toBe(chunk.content);
  });

  it("hard-cuts a single line longer than the cap (wide table rows)", () => {
    const chunk = makeChunk(0, "Table", "| a | b |".repeat(2000)); // one 16k-char line
    const parts = splitChunkByChars(chunk, 1000);
    expect(parts.length).toBeGreaterThan(10);
    for (const p of parts) {
      expect(p.content.length).toBeLessThanOrEqual(1000);
    }
  });

  it("advances charOffset across parts", () => {
    const lines = Array.from({ length: 40 }, () => "z".repeat(90));
    const chunk = { ...makeChunk(0, "S", lines.join("\n")), charOffset: 500 };
    const parts = splitChunkByChars(chunk, 1000);
    expect(parts[0]!.charOffset).toBe(500);
    expect(parts[1]!.charOffset).toBe(500 + parts[0]!.content.length + 1);
  });
});

describe("packChunksToBudget", () => {
  it("keeps a fitting set in a single bin", () => {
    const chunks = [makeChunk(0, "A", "a".repeat(100)), makeChunk(1, "B", "b".repeat(100))];
    expect(packChunksToBudget(chunks, 10_000)).toEqual([chunks]);
  });

  it("packs into consecutive bins preserving order", () => {
    const chunks = Array.from({ length: 6 }, (_, i) => makeChunk(i, `S${i}`, "c".repeat(400)));
    const bins = packChunksToBudget(chunks, 1000);
    expect(bins.length).toBeGreaterThan(1);
    // Flattened bins reproduce the original order
    expect(bins.flat().map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const bin of bins) {
      const total = bin.reduce((n, c) => n + c.content.length, 0);
      expect(total).toBeLessThanOrEqual(1000);
    }
  });

  it("splits a single chunk larger than the whole budget", () => {
    const monster = makeChunk(0, "Monster", "m".repeat(5000));
    const bins = packChunksToBudget([makeChunk(1, "Small", "s"), monster], 1000);
    for (const bin of bins) {
      const total = bin.reduce((n, c) => n + c.content.length + c.title.length + 16, 0);
      expect(total).toBeLessThanOrEqual(1000);
    }
    // All monster content survives, in order
    const monsterContent = bins
      .flat()
      .filter((c) => c.title.startsWith("Monster"))
      .map((c) => c.content)
      .join("");
    expect(monsterContent).toBe(monster.content);
  });

  it("never returns an empty bin for non-empty input", () => {
    const bins = packChunksToBudget([makeChunk(0, "A", "a")], 100);
    expect(bins).toEqual([[makeChunk(0, "A", "a")]]);
  });
});
