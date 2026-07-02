import { describe, it, expect } from "vitest";
import {
  scoreChunk,
  routeFields,
  routeAllChunks,
  groupRoutes,
  type FieldRoute,
} from "./router";
import type { Chunk } from "./chunker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<Chunk> & { index: number }): Chunk {
  return {
    title: "",
    content: "",
    signals: {
      has_dates: false,
      has_dollar_amounts: false,
      has_tables: false,
      has_key_value_pairs: false,
    },
    charOffset: 0,
    charLength: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// scoreChunk — hint-based scoring
// ---------------------------------------------------------------------------

describe("scoreChunk", () => {
  it("look_in: adds +15 when chunk category matches", () => {
    const chunk = makeChunk({ index: 0, category: "header" });
    const spec = { type: "string", hints: { look_in: ["header"] } };
    const score = scoreChunk(chunk, "field_name", spec, 5);
    expect(score).toBe(15);
  });

  it("look_in: scores 0 when chunk category does not match", () => {
    const chunk = makeChunk({ index: 0, category: "footer" });
    const spec = { type: "string", hints: { look_in: ["header"] } };
    const score = scoreChunk(chunk, "field_name", spec, 5);
    expect(score).toBe(0);
  });

  it("prefer_contains: adds +15 when phrase found in title+content", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Summary",
      content: "Total amount due: $500",
    });
    const spec = { type: "string", hints: { prefer_contains: ["amount due"] } };
    const score = scoreChunk(chunk, "field_name", spec, 5);
    expect(score).toBe(15);
  });

  it("prefer_contains: case insensitive", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Header",
      content: "AMOUNT DUE: $500",
    });
    const spec = { type: "string", hints: { prefer_contains: ["amount due"] } };
    const score = scoreChunk(chunk, "field_name", spec, 5);
    expect(score).toBe(15);
  });

  it("prefer_contains: only adds once even with multiple matching phrases", () => {
    const chunk = makeChunk({
      index: 0,
      content: "amount due total amount",
    });
    const spec = {
      type: "string",
      hints: { prefer_contains: ["amount due", "total amount"] },
    };
    // First match breaks, so only +15 once
    const score = scoreChunk(chunk, "field_name", spec, 5);
    expect(score).toBe(15);
  });

  it("prefer_position top: chunk 0 gets +10, last chunk gets 0", () => {
    const first = makeChunk({ index: 0 });
    const last = makeChunk({ index: 4 });
    const spec = { type: "string", hints: { prefer_position: "top" } };

    expect(scoreChunk(first, "f", spec, 5)).toBe(10);
    expect(scoreChunk(last, "f", spec, 5)).toBe(0);
  });

  it("prefer_position top: linear decay for middle chunks", () => {
    const mid = makeChunk({ index: 2 });
    const spec = { type: "string", hints: { prefer_position: "top" } };
    // frac = 2/4 = 0.5, score = 10 * (1 - 0.5) = 5
    expect(scoreChunk(mid, "f", spec, 5)).toBe(5);
  });

  it("prefer_position bottom: last chunk gets +10, first gets 0", () => {
    const first = makeChunk({ index: 0 });
    const last = makeChunk({ index: 4 });
    const spec = { type: "string", hints: { prefer_position: "bottom" } };

    expect(scoreChunk(first, "f", spec, 5)).toBe(0);
    expect(scoreChunk(last, "f", spec, 5)).toBe(10);
  });

  it("prefer_position: single chunk gets frac=0, top=10, bottom=0", () => {
    const chunk = makeChunk({ index: 0 });
    const topSpec = { type: "string", hints: { prefer_position: "top" } };
    const botSpec = { type: "string", hints: { prefer_position: "bottom" } };

    expect(scoreChunk(chunk, "f", topSpec, 1)).toBe(10);
    expect(scoreChunk(chunk, "f", botSpec, 1)).toBe(0);
  });

  it("patterns: adds +8 when regex matches title+content", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Invoice",
      content: "INV-12345 dated 2025-01-01",
    });
    const spec = { type: "string", hints: { patterns: ["INV-\\d+"] } };
    const score = scoreChunk(chunk, "f", spec, 5);
    expect(score).toBe(8);
  });

  it("patterns: only adds once even with multiple matching patterns", () => {
    const chunk = makeChunk({
      index: 0,
      content: "INV-123 PO-456",
    });
    const spec = { type: "string", hints: { patterns: ["INV-\\d+", "PO-\\d+"] } };
    const score = scoreChunk(chunk, "f", spec, 5);
    expect(score).toBe(8);
  });

  it("signals hint: adds +4 per matching signal", () => {
    const chunk = makeChunk({
      index: 0,
      signals: {
        has_dates: true,
        has_dollar_amounts: true,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const spec = {
      type: "string",
      hints: { signals: ["has_dates", "has_dollar_amounts"] },
    };
    const score = scoreChunk(chunk, "f", spec, 5);
    expect(score).toBe(8); // 4 + 4
  });

  it("signals hint: no score for non-matching signals", () => {
    const chunk = makeChunk({
      index: 0,
      signals: {
        has_dates: false,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const spec = {
      type: "string",
      hints: { signals: ["has_dates"] },
    };
    const score = scoreChunk(chunk, "f", spec, 5);
    expect(score).toBe(0);
  });

  it("hints are authoritative: returns early when hints score > 0", () => {
    // If hints scored, generic inference should NOT add to the score
    const chunk = makeChunk({
      index: 0,
      title: "effective_date section",
      content: "effective_date: 2025-01-01",
      signals: {
        has_dates: true,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const spec = {
      type: "date",
      hints: { signals: ["has_dates"] },
    };
    // hint signal match: +4. Should return 4, NOT 4 + generic inference
    const score = scoreChunk(chunk, "effective_date", spec, 5);
    expect(score).toBe(4);
  });

  it("multiple hints combine: look_in + prefer_contains + patterns + signals", () => {
    const chunk = makeChunk({
      index: 0,
      category: "header",
      title: "Header",
      content: "INV-123 amount due",
      signals: {
        has_dates: true,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const spec = {
      type: "string",
      hints: {
        look_in: ["header"],
        prefer_contains: ["amount due"],
        patterns: ["INV-\\d+"],
        signals: ["has_dates"],
      },
    };
    // 15 (look_in) + 15 (prefer_contains) + 8 (patterns) + 4 (signals) = 42
    const score = scoreChunk(chunk, "f", spec, 5);
    expect(score).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// scoreChunk — generic inference (no hints)
// ---------------------------------------------------------------------------

describe("scoreChunk — generic inference", () => {
  it("date type: +2 when chunk has_dates", () => {
    const chunk = makeChunk({
      index: 0,
      signals: {
        has_dates: true,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const spec = { type: "date" };
    const score = scoreChunk(chunk, "some_field", spec, 5);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it("number type: +2 for has_dollar_amounts, +2 for has_key_value_pairs", () => {
    const chunk = makeChunk({
      index: 0,
      signals: {
        has_dates: false,
        has_dollar_amounts: true,
        has_tables: false,
        has_key_value_pairs: true,
      },
    });
    const spec = { type: "number" };
    const score = scoreChunk(chunk, "x", spec, 5);
    // 2 (dollar) + 2 (kv) = 4, plus possible field name match
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it("array type: +2 when chunk has_tables", () => {
    const chunk = makeChunk({
      index: 0,
      signals: {
        has_dates: false,
        has_dollar_amounts: false,
        has_tables: true,
        has_key_value_pairs: false,
      },
    });
    const spec = { type: "array" };
    const score = scoreChunk(chunk, "x", spec, 5);
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it("field name in chunk title: +6", () => {
    const chunk = makeChunk({ index: 0, title: "invoice number" });
    const spec = { type: "string" };
    const score = scoreChunk(chunk, "invoice_number", spec, 5);
    // "invoice number" in title.lower() → +6
    expect(score).toBeGreaterThanOrEqual(6);
  });

  it("field name in chunk content: +3", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Other",
      content: "The invoice number is INV-001",
    });
    const spec = { type: "string" };
    const score = scoreChunk(chunk, "invoice_number", spec, 5);
    // "invoice number" in content → +3
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("individual field name words: +1.5 each for words > 2 chars", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Other",
      content: "policy effective details",
    });
    const spec = { type: "string" };
    // field name "policy_effective_date" → words: policy, effective, date
    // "policy" in text → +1.5, "effective" in text → +1.5, "date" not in text → 0
    // plus "policy effective date" not in title or content[:500] as full phrase
    const score = scoreChunk(chunk, "policy_effective_date", spec, 5);
    expect(score).toBeGreaterThanOrEqual(3.0);
  });

  it("skips individual words with length <= 2", () => {
    const chunk = makeChunk({
      index: 0,
      title: "Other",
      content: "a at the value",
    });
    const spec = { type: "string" };
    // "is_a_value" → words: is(2), a(1), value(5). Only "value" > 2 chars → +1.5
    const score = scoreChunk(chunk, "is_a_value", spec, 5);
    expect(score).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// routeFields
// ---------------------------------------------------------------------------

describe("routeFields", () => {
  it("routes fields to highest-scoring chunks", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        title: "Header",
        content: "Company name: Acme Corp",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
      makeChunk({
        index: 1,
        title: "Dates",
        content: "Effective date: 2025-01-01",
        signals: {
          has_dates: true,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
    ];

    const schema = {
      fields: {
        effective_date: { type: "date" },
      },
    };

    const routes = routeFields(schema, chunks);
    expect(routes).toHaveLength(1);
    // effective_date should prefer chunk 1 (has_dates + field name in content)
    expect(routes[0]!.chunks[0]!.index).toBe(1);
  });

  it("respects max_chunks_per_field default of 3", () => {
    const chunks: Chunk[] = Array.from({ length: 10 }, (_, i) =>
      makeChunk({
        index: i,
        title: `Section ${i}`,
        content: `invoice number INV-${i}`,
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
    );

    const schema = {
      fields: {
        invoice_number: { type: "string" },
      },
    };

    const routes = routeFields(schema, chunks);
    expect(routes[0]!.chunks.length).toBeLessThanOrEqual(3);
  });

  it("respects per-field hints.max_chunks override", () => {
    const chunks: Chunk[] = Array.from({ length: 10 }, (_, i) =>
      makeChunk({
        index: i,
        title: `Item Section ${i}`,
        content: `line items row ${i}`,
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: true,
          has_key_value_pairs: false,
        },
      }),
    );

    const schema = {
      fields: {
        line_items: {
          type: "array",
          hints: { max_chunks: 7 },
        },
      },
    };

    const routes = routeFields(schema, chunks);
    expect(routes[0]!.chunks.length).toBeLessThanOrEqual(7);
    expect(routes[0]!.chunks.length).toBeGreaterThan(3);
  });

  it("look_in acts as hard filter when matching chunks exist", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        category: "header",
        title: "Header",
        content: "name: Acme",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
      makeChunk({
        index: 1,
        category: "details",
        title: "Details with name",
        content: "company name appears here too with lots of name references name name name",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
    ];

    const schema = {
      fields: {
        company_name: {
          type: "string",
          hints: { look_in: ["header"] },
        },
      },
    };

    const routes = routeFields(schema, chunks);
    // Even though chunk 1 might score higher generically, look_in constrains to header
    expect(routes[0]!.chunks.every((c) => c.category === "header")).toBe(true);
  });

  it("look_in falls back to all chunks when no category match", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        category: "other",
        content: "some content with the field",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: true,
        },
      }),
    ];

    const schema = {
      fields: {
        my_field: {
          type: "string",
          hints: { look_in: ["nonexistent_category"] },
        },
      },
    };

    const routes = routeFields(schema, chunks);
    // Should still get routed (broadened/fallback), not empty
    expect(routes).toHaveLength(1);
  });

  it("source is 'hint' when field has hints and scores > 0", () => {
    const chunk = makeChunk({
      index: 0,
      category: "header",
      signals: {
        has_dates: false,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });
    const schema = {
      fields: {
        f: { type: "string", hints: { look_in: ["header"] } },
      },
    };

    const routes = routeFields(schema, [chunk]);
    expect(routes[0]!.source).toBe("hint");
  });

  it("source is 'signal_inferred' when no hints but scores > 0", () => {
    const chunk = makeChunk({
      index: 0,
      title: "effective date",
      signals: {
        has_dates: true,
        has_dollar_amounts: false,
        has_tables: false,
        has_key_value_pairs: false,
      },
    });

    const schema = {
      fields: {
        effective_date: { type: "date" },
      },
    };

    const routes = routeFields(schema, [chunk]);
    expect(routes[0]!.source).toBe("signal_inferred");
  });

  it("source is 'broadened' when no chunk scores > 0 but some have signals", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        title: "Irrelevant",
        content: "nothing useful here",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: false,
        },
      }),
      makeChunk({
        index: 1,
        title: "Also Irrelevant",
        content: "also nothing",
        signals: {
          has_dates: true,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: false,
        },
      }),
    ];

    const schema = {
      fields: {
        xyz_zzz_qqq: { type: "string" },
      },
    };

    const routes = routeFields(schema, chunks);
    expect(routes[0]!.source).toBe("broadened");
    // Should pick the chunk with signals
    expect(routes[0]!.chunks[0]!.index).toBe(1);
  });

  it("source is 'fallback' when no chunk scores > 0 and none have signals", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        title: "Empty",
        content: "",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: false,
        },
      }),
      makeChunk({
        index: 1,
        title: "Also Empty",
        content: "",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: false,
        },
      }),
    ];

    const schema = {
      fields: {
        xyz_zzz_qqq: { type: "string" },
      },
    };

    const routes = routeFields(schema, chunks);
    expect(routes[0]!.source).toBe("fallback");
  });

  it("fallback uses first N chunks", () => {
    const chunks: Chunk[] = Array.from({ length: 10 }, (_, i) =>
      makeChunk({
        index: i,
        title: `S${i}`,
        content: "",
        signals: {
          has_dates: false,
          has_dollar_amounts: false,
          has_tables: false,
          has_key_value_pairs: false,
        },
      }),
    );

    const schema = {
      fields: {
        xyz_zzz_qqq: { type: "string" },
      },
    };

    const routes = routeFields(schema, chunks, 3);
    expect(routes[0]!.chunks).toHaveLength(3);
    expect(routes[0]!.chunks[0]!.index).toBe(0);
    expect(routes[0]!.chunks[1]!.index).toBe(1);
    expect(routes[0]!.chunks[2]!.index).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// groupRoutes
// ---------------------------------------------------------------------------

describe("groupRoutes", () => {
  it("groups fields that share the same chunks", () => {
    const chunk0 = makeChunk({ index: 0 });
    const chunk1 = makeChunk({ index: 1 });

    const routes: FieldRoute[] = [
      { fieldName: "a", fieldSpec: { type: "string" }, chunks: [chunk0], source: "hint" },
      { fieldName: "b", fieldSpec: { type: "string" }, chunks: [chunk0], source: "hint" },
      { fieldName: "c", fieldSpec: { type: "string" }, chunks: [chunk1], source: "hint" },
    ];

    const groups = groupRoutes(routes);
    // a and b share chunk0, c is separate
    expect(groups.length).toBe(2);

    const groupWithAB = groups.find((g) =>
      g.fields.includes("a") && g.fields.includes("b"),
    );
    expect(groupWithAB).toBeDefined();
    expect(groupWithAB!.chunks).toHaveLength(1);
    expect(groupWithAB!.chunks[0]!.index).toBe(0);

    const groupWithC = groups.find((g) => g.fields.includes("c"));
    expect(groupWithC).toBeDefined();
    expect(groupWithC!.chunks[0]!.index).toBe(1);
  });

  it("merges fields with >= 50% chunk overlap", () => {
    const chunk0 = makeChunk({ index: 0 });
    const chunk1 = makeChunk({ index: 1 });
    const chunk2 = makeChunk({ index: 2 });

    const routes: FieldRoute[] = [
      {
        fieldName: "a",
        fieldSpec: { type: "string" },
        chunks: [chunk0, chunk1],
        source: "hint",
      },
      {
        fieldName: "b",
        fieldSpec: { type: "string" },
        chunks: [chunk0, chunk2],
        source: "hint",
      },
    ];

    const groups = groupRoutes(routes);
    // overlap: {0} intersection of {0,1} and {0,2} = 1 / max(2,2) = 0.5 → merge
    expect(groups.length).toBe(1);
    expect(groups[0]!.fields).toContain("a");
    expect(groups[0]!.fields).toContain("b");
    // Union of chunks
    const chunkIndices = groups[0]!.chunks.map((c) => c.index).sort();
    expect(chunkIndices).toEqual([0, 1, 2]);
  });

  it("keeps fields separate when overlap < 50%", () => {
    const chunk0 = makeChunk({ index: 0 });
    const chunk1 = makeChunk({ index: 1 });
    const chunk2 = makeChunk({ index: 2 });
    const chunk3 = makeChunk({ index: 3 });

    const routes: FieldRoute[] = [
      {
        fieldName: "a",
        fieldSpec: { type: "string" },
        chunks: [chunk0, chunk1, chunk2],
        source: "hint",
      },
      {
        fieldName: "b",
        fieldSpec: { type: "string" },
        chunks: [chunk0, chunk3],
        source: "hint",
      },
    ];

    // For b checking against a: overlap = |{0}| / max(|{0,1,2}|, 1) = 1/3 ≈ 0.33 < 0.5
    // Wait, overlap is computed as len(a_indices & b_indices) / max(len(a_indices), 1)
    // where a_indices is the "current" route's chunk_indices (the one being grouped)
    // Actually re-reading: chunk_indices = frozenset(c.index for c in route.chunks) — the primary route
    // overlap = len(chunk_indices & other_indices) / max(len(chunk_indices), 1)
    // For route a (primary): chunk_indices = {0,1,2}
    // For route b (other): other_indices = {0,3}
    // overlap = |{0}| / max(|{0,1,2}|, 1) = 1/3 < 0.5 → NOT merged
    const groups = groupRoutes(routes);
    expect(groups.length).toBe(2);
  });

  it("deduplicates chunks in group union", () => {
    const chunk0 = makeChunk({ index: 0 });
    const chunk1 = makeChunk({ index: 1 });

    const routes: FieldRoute[] = [
      { fieldName: "a", fieldSpec: { type: "string" }, chunks: [chunk0, chunk1], source: "hint" },
      { fieldName: "b", fieldSpec: { type: "string" }, chunks: [chunk0, chunk1], source: "hint" },
    ];

    const groups = groupRoutes(routes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.chunks).toHaveLength(2);
  });

  it("returns empty groups for empty routes", () => {
    const groups = groupRoutes([]);
    expect(groups).toHaveLength(0);
  });

  it("each field appears in exactly one group", () => {
    const chunk0 = makeChunk({ index: 0 });
    const chunk1 = makeChunk({ index: 1 });

    const routes: FieldRoute[] = [
      { fieldName: "a", fieldSpec: { type: "string" }, chunks: [chunk0], source: "hint" },
      { fieldName: "b", fieldSpec: { type: "string" }, chunks: [chunk0, chunk1], source: "hint" },
      { fieldName: "c", fieldSpec: { type: "string" }, chunks: [chunk1], source: "hint" },
    ];

    const groups = groupRoutes(routes);
    const allFields = groups.flatMap((g) => g.fields);
    expect(new Set(allFields).size).toBe(allFields.length);
    expect(allFields.sort()).toEqual(["a", "b", "c"]);
  });

  // Regression (oss-329): a per_section array field's expanded, multi-section
  // chunk set must not leak into a sibling field's extraction context via the
  // shared group union. Mirrors the Bellasera bug: insured_name (scalar) shares
  // the declarations chunk with coverages (per_section, spanning many section
  // chunks); before the fix insured_name absorbed all of coverages' sections
  // and flipped to the carrier name stamped on each coverage-part header.
  it("isolates a per_section field so siblings don't inherit its section union", () => {
    const decl = makeChunk({ index: 0, title: "DECLARATIONS" });
    const s1 = makeChunk({ index: 5, title: "CRIME COVERAGE PART DECLARATIONS" });
    const s2 = makeChunk({ index: 9, title: "PROPERTY COVERAGE PART DECLARATIONS" });
    const s3 = makeChunk({ index: 14, title: "LIABILITY COVERAGE PART DECLARATIONS" });

    const routes: FieldRoute[] = [
      // Scalar shares only the declarations chunk. Sorted first (shorter set),
      // so it is the grouping seed — the exact condition that triggered the bug.
      { fieldName: "insured_name", fieldSpec: { type: "string" }, chunks: [decl], source: "hint" },
      // per_section array spans the declarations chunk + 3 coverage sections.
      { fieldName: "coverages", fieldSpec: { type: "array" }, chunks: [decl, s1, s2, s3], source: "per_section" },
    ];

    const groups = groupRoutes(routes);

    const insuredGroup = groups.find((g) => g.fields.includes("insured_name"))!;
    // The scalar must NOT be grouped with coverages, and must see ONLY its own
    // declarations chunk — never the coverage-part sections.
    expect(insuredGroup.fields).toEqual(["insured_name"]);
    expect(insuredGroup.chunks.map((c) => c.index)).toEqual([0]);

    // coverages is its own singleton group holding all its section chunks.
    const covGroup = groups.find((g) => g.fields.includes("coverages"))!;
    expect(covGroup.fields).toEqual(["coverages"]);
    expect(covGroup.chunks.map((c) => c.index).sort((a, b) => a - b)).toEqual([0, 5, 9, 14]);

    // Every field still lands in exactly one group.
    const allFields = groups.flatMap((g) => g.fields);
    expect(allFields.sort()).toEqual(["coverages", "insured_name"]);
  });

  it("normal fields still group together when a per_section sibling is present", () => {
    const decl = makeChunk({ index: 0 });
    const s1 = makeChunk({ index: 5 });

    const routes: FieldRoute[] = [
      { fieldName: "insured_name", fieldSpec: { type: "string" }, chunks: [decl], source: "hint" },
      { fieldName: "policy_number", fieldSpec: { type: "string" }, chunks: [decl], source: "hint" },
      { fieldName: "coverages", fieldSpec: { type: "array" }, chunks: [decl, s1], source: "per_section" },
    ];

    const groups = groupRoutes(routes);
    // insured_name + policy_number still share the declarations chunk in one
    // group; coverages is isolated. Two groups total.
    expect(groups).toHaveLength(2);
    const scalarGroup = groups.find((g) => g.fields.includes("insured_name"))!;
    expect(scalarGroup.fields.sort()).toEqual(["insured_name", "policy_number"]);
    expect(scalarGroup.chunks.map((c) => c.index)).toEqual([0]);
  });

  // Regression (oss-335): hints.isolate pins a critical field to its own chunks
  // and its own instruction, so a sibling's routing change can't pull it into a
  // shared group and flip its output.
  it("isolates a field with hints.isolate into its own singleton group", () => {
    const decl = makeChunk({ index: 0 });
    const other = makeChunk({ index: 3 });

    const routes: FieldRoute[] = [
      // Shares the declarations chunk with a sibling, so without isolate they'd
      // group (100% overlap of the scalar's single chunk).
      {
        fieldName: "insured_name",
        fieldSpec: { type: "string", hints: { isolate: true } },
        chunks: [decl],
        source: "hint",
      },
      { fieldName: "policy_number", fieldSpec: { type: "string" }, chunks: [decl, other], source: "hint" },
    ];

    const groups = groupRoutes(routes);
    const insuredGroup = groups.find((g) => g.fields.includes("insured_name"))!;
    expect(insuredGroup.fields).toEqual(["insured_name"]);
    expect(insuredGroup.chunks.map((c) => c.index)).toEqual([0]);
    // policy_number is NOT dragged in, and never pulls insured_name into itself.
    expect(groups.find((g) => g.fields.includes("policy_number"))!.fields).toEqual(["policy_number"]);
  });

  it("an isolated field's group is stable when a sibling's routing changes", () => {
    const decl = makeChunk({ index: 0 });
    const a = makeChunk({ index: 4 });
    const b = makeChunk({ index: 8 });

    const isolated = {
      fieldName: "insured_name",
      fieldSpec: { type: "string", hints: { isolate: true } },
      chunks: [decl],
      source: "hint" as const,
    };
    // Sibling routes to {decl, a} in one run and {decl, b} in another (as if its
    // hint changed). The isolated field's group must be identical either way.
    const g1 = groupRoutes([isolated, { fieldName: "coverages", fieldSpec: { type: "array" }, chunks: [decl, a], source: "hint" }]);
    const g2 = groupRoutes([isolated, { fieldName: "coverages", fieldSpec: { type: "array" }, chunks: [decl, b], source: "hint" }]);
    const grp = (gs: typeof g1) => gs.find((g) => g.fields.includes("insured_name"))!;
    expect(grp(g1).fields).toEqual(["insured_name"]);
    expect(grp(g1).chunks.map((c) => c.index)).toEqual([0]);
    expect(grp(g2).chunks.map((c) => c.index)).toEqual(grp(g1).chunks.map((c) => c.index));
  });
});

describe("routeAllChunks (adaptive full-document routing)", () => {
  const schema = {
    fields: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "date" },
    },
  };
  const chunks = [makeChunk({ index: 0 }), makeChunk({ index: 1 }), makeChunk({ index: 2 })];

  it("routes every field to the full chunk set with source full_document", () => {
    const routes = routeAllChunks(schema, chunks);
    expect(routes.map((r) => r.fieldName).sort()).toEqual(["a", "b", "c"]);
    for (const r of routes) {
      expect(r.chunks).toHaveLength(3);
      expect(r.chunks).toEqual(chunks);
      expect(r.source).toBe("full_document");
    }
  });

  it("collapses to a single extraction group (one full-document LLM call)", () => {
    const groups = groupRoutes(routeAllChunks(schema, chunks));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.fields.sort()).toEqual(["a", "b", "c"]);
    expect(groups[0]!.chunks).toHaveLength(3);
  });

  it("returns no routes for a schema with no fields", () => {
    expect(routeAllChunks({ fields: {} }, chunks)).toEqual([]);
    expect(routeAllChunks({}, chunks)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// per_section — coverage-maximizing selection for array fields
// ---------------------------------------------------------------------------

describe("routeFields — per_section coverage-maximizing selection", () => {
  const covSignals = {
    has_dates: false,
    has_dollar_amounts: true,
    has_tables: true,
    has_key_value_pairs: true,
  };

  // A large multi-part package: `n` coverage-part sections, each a distinct
  // heading, plus one unrelated noise chunk. Every section chunk matches the
  // array field's hints, so a top-N pass would keep only the first few.
  function coveragePackage(n: number): Chunk[] {
    const chunks: Chunk[] = [];
    for (let i = 0; i < n; i++) {
      chunks.push(
        makeChunk({
          index: i,
          title: `COVERAGE PART ${i} DECLARATIONS`,
          category: "declarations",
          content: "coverage limit deductible table row",
          signals: { ...covSignals },
        }),
      );
    }
    chunks.push(makeChunk({ index: n, title: "Notes", category: "other", content: "misc" }));
    return chunks;
  }

  function arraySchema(extraHints: Record<string, unknown> = {}) {
    return {
      fields: {
        coverages: {
          type: "array",
          hints: {
            look_in: ["declarations"],
            signals: ["has_tables", "has_dollar_amounts"],
            patterns: ["coverage", "limit", "deductible"],
            ...extraHints,
          },
        },
      },
    };
  }

  it("without per_section, top-N drops sections on a 6-part package", () => {
    const routes = routeFields(arraySchema(), coveragePackage(6));
    expect(routes[0]!.chunks.length).toBeLessThanOrEqual(3);
    expect(routes[0]!.source).not.toBe("per_section");
  });

  it("with per_section, every distinct section reaches the extractor (6/6)", () => {
    const routes = routeFields(arraySchema({ per_section: true }), coveragePackage(6));
    const titles = new Set(routes[0]!.chunks.map((c) => c.title));
    expect(titles.size).toBe(6);
    expect(routes[0]!.source).toBe("per_section");
  });

  it("scales down to a small package without inflating (4/4)", () => {
    const routes = routeFields(arraySchema({ per_section: true }), coveragePackage(4));
    expect(new Set(routes[0]!.chunks.map((c) => c.title)).size).toBe(4);
  });

  it("returns representatives in document order (by index)", () => {
    const routes = routeFields(arraySchema({ per_section: true }), coveragePackage(5));
    const indices = routes[0]!.chunks.map((c) => c.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("caps distinct sections at hints.max_sections", () => {
    const routes = routeFields(arraySchema({ per_section: true, max_sections: 3 }), coveragePackage(6));
    expect(routes[0]!.chunks.length).toBe(3);
  });

  it("keeps ALL chunks of a section that spans multiple chunks (oss-345)", () => {
    const chunks: Chunk[] = [
      makeChunk({
        index: 0,
        title: "PROPERTY COVERAGE PART DECLARATIONS",
        category: "declarations",
        content: "coverage limit deductible",
        signals: { ...covSignals },
      }),
      makeChunk({
        index: 1,
        title: "PROPERTY COVERAGE PART DECLARATIONS", // same heading = same section (split page)
        category: "declarations",
        content: "coverage limit deductible continued",
        signals: { ...covSignals },
      }),
      makeChunk({
        index: 2,
        title: "LIABILITY COVERAGE PART DECLARATIONS",
        category: "declarations",
        content: "coverage limit deductible",
        signals: { ...covSignals },
      }),
    ];
    const routes = routeFields(arraySchema({ per_section: true }), chunks);
    // The PROPERTY section spans two chunks — BOTH are kept (rows in the second
    // chunk would otherwise be lost), plus the LIABILITY chunk = 3.
    expect(routes[0]!.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("caps chunks pulled from a single section at chunks_per_section", () => {
    const chunks: Chunk[] = Array.from({ length: 6 }, (_, i) =>
      makeChunk({
        index: i,
        title: "PROPERTY COVERAGE PART DECLARATIONS", // all one section
        category: "declarations",
        content: "coverage limit deductible",
        signals: { ...covSignals },
      }),
    );
    const routes = routeFields(arraySchema({ per_section: true, chunks_per_section: 2 }), chunks);
    expect(routes[0]!.chunks.length).toBe(2);
  });

  it("does not engage for a non-opted-in array field (default top-N)", () => {
    const routes = routeFields(arraySchema(), coveragePackage(6));
    expect(routes[0]!.source).toBe("hint");
  });
});

describe("routeFields — per_section section_anchor precision filter (oss-339)", () => {
  const covSignals = { has_dates: false, has_dollar_amounts: true, has_tables: true, has_key_value_pairs: true };

  // Two real coverage-part declaration sections + two boilerplate sections that
  // per_section would otherwise emit spurious rows from — all classified
  // `declarations` so look_in passes them and only the anchor can filter them.
  function packageWithBoilerplate(): Chunk[] {
    return [
      makeChunk({ index: 0, title: "COMMERCIAL PROPERTY COVERAGE PART DECLARATIONS", category: "declarations", content: "coverage limit deductible", signals: { ...covSignals } }),
      makeChunk({ index: 1, title: "COMMERCIAL GENERAL LIABILITY COVERAGE PART DECLARATIONS", category: "declarations", content: "coverage limit deductible", signals: { ...covSignals } }),
      // Boilerplate: a product-catalog menu (lists many coverage names, no "declarations").
      makeChunk({ index: 2, title: "PRODUCTS AND SERVICES", category: "declarations", content: "Commercial Umbrella Excess Workers Compensation Farm Liquor Liability", signals: { ...covSignals } }),
      // Boilerplate: a "who is an insured" text block.
      makeChunk({ index: 3, title: "WHO IS AN INSURED", category: "declarations", content: "Condominium Unit Owners are insured with respect to coverage limit", signals: { ...covSignals } }),
    ];
  }

  function schema(extraHints: Record<string, unknown>) {
    return {
      fields: {
        coverages: {
          type: "array",
          hints: { look_in: ["declarations"], signals: ["has_tables"], patterns: ["coverage", "limit", "deductible"], ...extraHints },
        },
      },
    };
  }

  it("without an anchor, per_section visits the boilerplate sections too", () => {
    const routes = routeFields(schema({ per_section: true }), packageWithBoilerplate());
    const titles = routes[0]!.chunks.map((c) => c.title);
    expect(titles).toContain("PRODUCTS AND SERVICES");
    expect(titles).toContain("WHO IS AN INSURED");
    expect(routes[0]!.chunks.length).toBe(4);
  });

  it("with a section_anchor, only anchored sections are visited", () => {
    const routes = routeFields(
      schema({ per_section: true, section_anchor: "COVERAGE PART DECLARATIONS" }),
      packageWithBoilerplate(),
    );
    const titles = routes[0]!.chunks.map((c) => c.title);
    expect(titles).toEqual([
      "COMMERCIAL PROPERTY COVERAGE PART DECLARATIONS",
      "COMMERCIAL GENERAL LIABILITY COVERAGE PART DECLARATIONS",
    ]);
    expect(routes[0]!.source).toBe("per_section");
  });

  it("accepts a list of anchor patterns", () => {
    const routes = routeFields(
      schema({ per_section: true, section_anchor: ["COVERAGE PART DECLARATIONS", "RECORD OF ADDITIONAL INSUREDS"] }),
      packageWithBoilerplate(),
    );
    expect(routes[0]!.chunks.length).toBe(2);
  });

  it("falls back to all sections when the anchor matches nothing", () => {
    const routes = routeFields(
      schema({ per_section: true, section_anchor: "THIS MATCHES NO SECTION XYZ" }),
      packageWithBoilerplate(),
    );
    // Rather than vanish, the field keeps all sections (a too-narrow pattern
    // shouldn't silently drop it).
    expect(routes[0]!.chunks.length).toBe(4);
  });

  it("matches an anchor found in the body, not just the heading", () => {
    const chunks: Chunk[] = [
      makeChunk({ index: 0, title: "Page 3", category: "declarations", content: "COVERAGE PART DECLARATIONS coverage limit deductible", signals: { ...covSignals } }),
      makeChunk({ index: 1, title: "Page 4", category: "declarations", content: "misc boilerplate text with no anchor", signals: { ...covSignals } }),
    ];
    const routes = routeFields(schema({ per_section: true, section_anchor: "COVERAGE PART DECLARATIONS" }), chunks);
    expect(routes[0]!.chunks.map((c) => c.index)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// neighbor_radius — label-anchored value routing (oss-340)
// ---------------------------------------------------------------------------

describe("routeFields — neighbor_radius pulls adjacent chunks", () => {
  // The label is in a declarations chunk; the value sits in the NEXT chunk,
  // which is a different category that look_in would otherwise exclude.
  function splitLabelValue(): Chunk[] {
    return [
      makeChunk({ index: 0, title: "Header", category: "declarations", content: "policy info", signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: true } }),
      makeChunk({ index: 1, title: "Premium", category: "declarations", content: "TOTAL DEPOSIT PREMIUM", signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: true } }),
      // Value chunk — different category (excluded by look_in), holds "$1,691".
      makeChunk({ index: 2, title: "amounts", category: "other", content: "$1,691", signals: { has_dates: false, has_dollar_amounts: true, has_tables: false, has_key_value_pairs: false } }),
    ];
  }

  function premiumSchema(extraHints: Record<string, unknown> = {}) {
    return {
      fields: {
        premium: {
          type: "string",
          hints: { look_in: ["declarations"], prefer_contains: ["total deposit premium"], max_chunks: 1, ...extraHints },
        },
      },
    };
  }

  it("without neighbor_radius, the value chunk is unreachable (label chunk only)", () => {
    const routes = routeFields(premiumSchema(), splitLabelValue());
    const idx = routes[0]!.chunks.map((c) => c.index);
    expect(idx).toEqual([1]); // label chunk only — value in chunk 2 not routed
  });

  it("with neighbor_radius:1, the adjacent value chunk is pulled in", () => {
    const routes = routeFields(premiumSchema({ neighbor_radius: 1 }), splitLabelValue());
    const idx = routes[0]!.chunks.map((c) => c.index);
    expect(idx).toContain(1); // label
    expect(idx).toContain(2); // value (different category, from the full set)
  });

  it("pulls neighbors on both sides and stays in document order", () => {
    const chunks = [
      makeChunk({ index: 0, title: "a", category: "other", content: "before" }),
      makeChunk({ index: 1, title: "label", category: "declarations", content: "TOTAL DEPOSIT PREMIUM", signals: { has_dates: false, has_dollar_amounts: false, has_tables: false, has_key_value_pairs: true } }),
      makeChunk({ index: 2, title: "c", category: "other", content: "after" }),
    ];
    const routes = routeFields(premiumSchema({ neighbor_radius: 1 }), chunks);
    expect(routes[0]!.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("radius 0 (default) is a no-op", () => {
    const routes = routeFields(premiumSchema({ neighbor_radius: 0 }), splitLabelValue());
    expect(routes[0]!.chunks.map((c) => c.index)).toEqual([1]);
  });
});
