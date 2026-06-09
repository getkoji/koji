import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelProvider } from "./providers";
import type { Chunk } from "./chunker";
import {
  classifyChunksToSections,
  normalizeClassifierResponse,
  coalesceOtherSections,
  type Section,
  type ClassifyResult,
  OTHER_TYPE_ID,
  FALLBACK_TYPE_ID,
} from "./packet-splitter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunks(n: number): Chunk[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    title: `Chunk ${i}`,
    content: `Content of chunk ${i}`,
    signals: {
      has_dates: false,
      has_dollar_amounts: false,
      has_tables: false,
      has_key_value_pairs: false,
    },
    charOffset: i * 100,
    charLength: 100,
  }));
}

function mockProvider(response: string): ModelProvider {
  return {
    generate: vi.fn().mockResolvedValue(response),
  };
}

function failingProvider(error: Error): ModelProvider {
  return {
    generate: vi.fn().mockRejectedValue(error),
  };
}

const TYPES = [
  { id: "invoice", description: "An invoice document" },
  { id: "coi", description: "Certificate of insurance" },
];

// ---------------------------------------------------------------------------
// Short-doc bypass
// ---------------------------------------------------------------------------

describe("short-doc bypass", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("skips classifier for 1-chunk doc (default threshold)", async () => {
    const chunks = makeChunks(1);
    const provider = mockProvider("should not be called");
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(result.classifierSkipped).toBe(true);
    expect(result.corrections).toBe(0);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("skips classifier for 2-chunk doc (default threshold)", async () => {
    const chunks = makeChunks(2);
    const provider = mockProvider("should not be called");
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(result.sections[0].startChunk).toBe(0);
    expect(result.sections[0].endChunk).toBe(1);
    expect(result.classifierSkipped).toBe(true);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("does NOT skip classifier for 3-chunk doc", async () => {
    const chunks = makeChunks(3);
    const provider = mockProvider(
      JSON.stringify({
        sections: [{ type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.9 }],
      }),
    );
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.classifierSkipped).toBe(false);
    expect(provider.generate).toHaveBeenCalled();
  });

  it("returns empty sections for empty chunk list", async () => {
    const provider = mockProvider("unused");
    const result = await classifyChunksToSections([], provider, TYPES);

    expect(result.sections).toHaveLength(0);
    expect(result.classifierSkipped).toBe(false);
  });

  it("short_doc_chunks=0 disables bypass", async () => {
    const chunks = makeChunks(2);
    const provider = mockProvider(
      JSON.stringify({
        sections: [{ type: "invoice", start_chunk: 0, end_chunk: 1, confidence: 0.95 }],
      }),
    );
    const result = await classifyChunksToSections(chunks, provider, TYPES, {
      shortDocChunks: 0,
    });

    expect(result.classifierSkipped).toBe(false);
    expect(provider.generate).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Valid LLM response
// ---------------------------------------------------------------------------

describe("valid LLM response", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("produces correct sections from a clean response", async () => {
    const chunks = makeChunks(6);
    const provider = mockProvider(
      JSON.stringify({
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.95 },
          { type: "coi", start_chunk: 3, end_chunk: 5, confidence: 0.88 },
        ],
      }),
    );
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].type).toBe("invoice");
    expect(result.sections[0].startChunk).toBe(0);
    expect(result.sections[0].endChunk).toBe(2);
    expect(result.sections[0].chunks).toHaveLength(3);
    expect(result.sections[1].type).toBe("coi");
    expect(result.sections[1].startChunk).toBe(3);
    expect(result.sections[1].endChunk).toBe(5);
    expect(result.corrections).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Normalizer failure modes (unit tests on normalizeClassifierResponse)
// ---------------------------------------------------------------------------

describe("normalizeClassifierResponse", () => {
  const validTypes = new Set(["invoice", "coi"]);

  it("failure 1: invalid JSON (null) → fallback", () => {
    const [sections, corrections] = normalizeClassifierResponse(null, 5, validTypes);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBe(1);
  });

  it("failure 1: non-dict response → fallback", () => {
    const [sections, corrections] = normalizeClassifierResponse("not a dict" as any, 5, validTypes);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBe(1);
  });

  it("failure 2: empty sections list → fallback", () => {
    const [sections, corrections] = normalizeClassifierResponse({ sections: [] }, 5, validTypes);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBe(1);
  });

  it("failure 2: missing sections key → fallback", () => {
    const [sections, corrections] = normalizeClassifierResponse({ data: [] }, 5, validTypes);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBe(1);
  });

  it("failure 3: out-of-range indices → dropped", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.9 },
          { type: "coi", start_chunk: 3, end_chunk: 10, confidence: 0.8 }, // end out of range for 5 chunks
        ],
      },
      5,
      validTypes,
    );
    // Only invoice kept, gap filled with other
    expect(sections.some((s) => s.type === "invoice")).toBe(true);
    expect(corrections).toBeGreaterThan(0);
    // The out-of-range section should not appear
    expect(sections.every((s) => s.endChunk < 5)).toBe(true);
  });

  it("failure 3: negative indices → dropped", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [{ type: "invoice", start_chunk: -1, end_chunk: 2, confidence: 0.9 }],
      },
      5,
      validTypes,
    );
    // Dropped, then fallback because nothing valid remains
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 4: inverted range (start > end) → dropped", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [{ type: "invoice", start_chunk: 4, end_chunk: 1, confidence: 0.9 }],
      },
      5,
      validTypes,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 5: overlapping ranges → first-start-wins trimming", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 3, confidence: 0.9 },
          { type: "coi", start_chunk: 2, end_chunk: 4, confidence: 0.8 },
        ],
      },
      5,
      validTypes,
    );
    // invoice: 0-3, coi trimmed to 4-4
    const invoice = sections.find((s) => s.type === "invoice");
    const coi = sections.find((s) => s.type === "coi");
    expect(invoice).toBeDefined();
    expect(invoice!.startChunk).toBe(0);
    expect(invoice!.endChunk).toBe(3);
    expect(coi).toBeDefined();
    expect(coi!.startChunk).toBe(4);
    expect(coi!.endChunk).toBe(4);
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 5: overlap completely consumed → dropped", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 4, confidence: 0.9 },
          { type: "coi", start_chunk: 1, end_chunk: 3, confidence: 0.8 },
        ],
      },
      5,
      validTypes,
    );
    // coi is entirely within invoice, so it's dropped
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe("invoice");
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 6: gaps between ranges → filled with other", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 1, confidence: 0.9 },
          { type: "coi", start_chunk: 4, end_chunk: 5, confidence: 0.8 },
        ],
      },
      6,
      validTypes,
    );
    expect(sections).toHaveLength(3);
    expect(sections[0].type).toBe("invoice");
    expect(sections[1].type).toBe(OTHER_TYPE_ID);
    expect(sections[1].startChunk).toBe(2);
    expect(sections[1].endChunk).toBe(3);
    expect(sections[2].type).toBe("coi");
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 6: trailing gap → filled with other", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [{ type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.9 }],
      },
      5,
      validTypes,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].type).toBe("invoice");
    expect(sections[1].type).toBe(OTHER_TYPE_ID);
    expect(sections[1].startChunk).toBe(3);
    expect(sections[1].endChunk).toBe(4);
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 6: leading gap → filled with other", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [{ type: "invoice", start_chunk: 2, end_chunk: 4, confidence: 0.9 }],
      },
      5,
      validTypes,
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].type).toBe(OTHER_TYPE_ID);
    expect(sections[0].startChunk).toBe(0);
    expect(sections[0].endChunk).toBe(1);
    expect(sections[1].type).toBe("invoice");
    expect(corrections).toBeGreaterThan(0);
  });

  it("failure 7: unknown type IDs → coerced to other", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.9 },
          { type: "unknown_type", start_chunk: 3, end_chunk: 4, confidence: 0.7 },
        ],
      },
      5,
      validTypes,
    );
    expect(sections[0].type).toBe("invoice");
    expect(sections[1].type).toBe(OTHER_TYPE_ID);
    expect(corrections).toBeGreaterThan(0);
  });

  it("allows 'other' type even if not in validTypes", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 2, confidence: 0.9 },
          { type: "other", start_chunk: 3, end_chunk: 4, confidence: 0.5 },
        ],
      },
      5,
      validTypes,
    );
    expect(sections[1].type).toBe("other");
    // No correction for "other" type
  });

  it("returns empty for total_chunks=0", () => {
    const [sections, corrections] = normalizeClassifierResponse(
      { sections: [{ type: "invoice", start_chunk: 0, end_chunk: 0 }] },
      0,
      validTypes,
    );
    expect(sections).toHaveLength(0);
    expect(corrections).toBe(0);
  });

  it("tracks corrections accurately across multiple fixups", () => {
    // 1 overlap + 1 unknown type + 1 trailing gap = 3 corrections
    const [sections, corrections] = normalizeClassifierResponse(
      {
        sections: [
          { type: "invoice", start_chunk: 0, end_chunk: 3, confidence: 0.9 },
          { type: "bogus", start_chunk: 2, end_chunk: 5, confidence: 0.7 }, // overlap (1) + unknown type (1)
        ],
      },
      8,
      validTypes,
    );
    // invoice 0-3, bogus trimmed to 4-5 + coerced to other (2 corrections), trailing gap 6-7 (1 more)
    expect(corrections).toBe(3);
    expect(sections).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Coalesce
// ---------------------------------------------------------------------------

describe("coalesceOtherSections", () => {
  it("dominant type absorbs other sections", () => {
    // 4 invoice chunks + 1 other chunk out of 5 = 80% invoice
    const sections: Section[] = [
      { type: "invoice", startChunk: 0, endChunk: 3, chunks: makeChunks(4), confidence: 0.9 },
      { type: OTHER_TYPE_ID, startChunk: 4, endChunk: 4, chunks: makeChunks(1), confidence: 0 },
    ];
    const [result, dominant] = coalesceOtherSections(sections, 5, 0.5);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("invoice");
    expect(dominant).toBe("invoice");
  });

  it("no dominant type → no change", () => {
    // 2 invoice + 2 coi + 1 other = neither dominates at 50%
    const sections: Section[] = [
      { type: "invoice", startChunk: 0, endChunk: 1, chunks: makeChunks(2), confidence: 0.9 },
      { type: "coi", startChunk: 2, endChunk: 3, chunks: makeChunks(2), confidence: 0.8 },
      { type: OTHER_TYPE_ID, startChunk: 4, endChunk: 4, chunks: makeChunks(1), confidence: 0 },
    ];
    const [result, dominant] = coalesceOtherSections(sections, 5, 0.5);
    expect(result).toHaveLength(3);
    expect(dominant).toBeNull();
  });

  it("threshold=0 disables coalescing", () => {
    const sections: Section[] = [
      { type: "invoice", startChunk: 0, endChunk: 3, chunks: makeChunks(4), confidence: 0.9 },
      { type: OTHER_TYPE_ID, startChunk: 4, endChunk: 4, chunks: makeChunks(1), confidence: 0 },
    ];
    const [result, dominant] = coalesceOtherSections(sections, 5, 0);
    expect(result).toHaveLength(2);
    expect(dominant).toBeNull();
  });

  it("no other sections → no change", () => {
    const sections: Section[] = [
      { type: "invoice", startChunk: 0, endChunk: 2, chunks: makeChunks(3), confidence: 0.9 },
      { type: "coi", startChunk: 3, endChunk: 4, chunks: makeChunks(2), confidence: 0.8 },
    ];
    const [result, dominant] = coalesceOtherSections(sections, 5, 0.5);
    expect(result).toHaveLength(2);
    expect(dominant).toBeNull();
  });

  it("empty sections → no change", () => {
    const [result, dominant] = coalesceOtherSections([], 5, 0.5);
    expect(result).toHaveLength(0);
    expect(dominant).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: LLM error handling
// ---------------------------------------------------------------------------

describe("LLM error handling", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("provider error → fallback section", async () => {
    const chunks = makeChunks(5);
    const provider = failingProvider(new Error("API timeout"));
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe(FALLBACK_TYPE_ID);
  });

  it("invalid JSON from LLM → fallback section", async () => {
    const chunks = makeChunks(5);
    const provider = mockProvider("this is not json at all {{{}}}");
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe(FALLBACK_TYPE_ID);
    expect(result.corrections).toBeGreaterThan(0);
  });

  it("JSON wrapped in markdown fences → extracted and parsed", async () => {
    const chunks = makeChunks(5);
    const provider = mockProvider(
      '```json\n{"sections": [{"type": "invoice", "start_chunk": 0, "end_chunk": 4, "confidence": 0.9}]}\n```',
    );
    const result = await classifyChunksToSections(chunks, provider, TYPES);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].type).toBe("invoice");
  });
});
