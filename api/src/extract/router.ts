/**
 * Phase 2: Field Router — match schema fields to the right chunks using schema hints.
 *
 * Faithful TypeScript port of services/extract/router.py. This module is
 * 100% deterministic (no LLM calls). It scores each field against each
 * chunk to find the most relevant chunks for extraction.
 */

import type { Chunk } from "./chunker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldRoute {
  fieldName: string;
  fieldSpec: Record<string, unknown>;
  chunks: Chunk[];
  source: "hint" | "signal_inferred" | "broadened" | "fallback";
}

export interface RouteGroup {
  fields: string[];
  fieldSpecs: Record<string, Record<string, unknown>>;
  chunks: Chunk[];
}

// ---------------------------------------------------------------------------
// Generic signal inference
// ---------------------------------------------------------------------------

/** When the schema has no hints, infer what to look for based on field type. */
const TYPE_SIGNAL_MAP: Record<string, string[]> = {
  date: ["has_dates"],
  number: ["has_dollar_amounts", "has_key_value_pairs"],
  string: ["has_key_value_pairs"],
  enum: ["has_key_value_pairs"],
  array: ["has_tables"],
};

// ---------------------------------------------------------------------------
// Chunk signal helper
// ---------------------------------------------------------------------------

/** Check whether a signal is present (truthy) on a chunk. */
function chunkHasSignal(chunk: Chunk, signal: string): boolean {
  return !!(chunk.signals as Record<string, unknown>)[signal];
}

/** Check whether a chunk has any truthy signal. */
function chunkHasAnySignal(chunk: Chunk): boolean {
  const signals = chunk.signals as Record<string, unknown>;
  return Object.values(signals).some((v) => !!v);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score how likely a chunk is to contain a field.
 * Uses schema hints or generic inference.
 *
 * Exported for testing — not part of the public API.
 */
export function scoreChunk(
  chunk: Chunk,
  fieldName: string,
  fieldSpec: Record<string, unknown>,
  totalChunks: number = 1,
): number {
  let score = 0;
  const hints = (fieldSpec.hints ?? {}) as Record<string, unknown>;

  // ── Hint-based scoring (user-defined, highest priority) ──

  const lookIn = (hints.look_in ?? []) as string[];
  if (lookIn.length > 0) {
    if (chunk.category && lookIn.includes(chunk.category)) {
      score += 15;
    }
  }

  const preferContains = (hints.prefer_contains ?? []) as string[];
  if (preferContains.length > 0) {
    const haystack = `${chunk.title} ${chunk.content}`.toLowerCase();
    for (const phrase of preferContains) {
      if (typeof phrase === "string" && phrase && haystack.includes(phrase.toLowerCase())) {
        score += 15;
        break;
      }
    }
  }

  const preferPosition = hints.prefer_position as string | undefined;
  if (preferPosition) {
    let frac: number;
    if (totalChunks <= 1) {
      frac = 0;
    } else {
      frac = chunk.index / (totalChunks - 1);
    }
    if (preferPosition === "top") {
      score += 10 * (1 - frac);
    } else if (preferPosition === "bottom") {
      score += 10 * frac;
    }
  }

  const patterns = (hints.patterns ?? []) as string[];
  if (patterns.length > 0) {
    const text = `${chunk.title} ${chunk.content.slice(0, 1500)}`.toLowerCase();
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(text)) {
          score += 8;
          break;
        }
      } catch {
        // Skip invalid patterns
      }
    }
  }

  const signalsHint = (hints.signals ?? []) as string[];
  if (signalsHint.length > 0) {
    for (const signal of signalsHint) {
      if (chunkHasSignal(chunk, signal)) {
        score += 4;
      }
    }
  }

  // If we had hints and scored, return early — hints are authoritative
  const hasHints = Object.keys(hints).length > 0;
  if (hasHints && score > 0) {
    return score;
  }

  // ── Generic inference (no hints provided) ──

  const fieldType = (fieldSpec.type as string) ?? "string";
  const inferredSignals = TYPE_SIGNAL_MAP[fieldType] ?? [];
  for (const signal of inferredSignals) {
    if (chunkHasSignal(chunk, signal)) {
      score += 2;
    }
  }

  // Field name appears in chunk title or content (fuzzy)
  const fieldWords = fieldName.replace(/_/g, " ").toLowerCase();
  if (chunk.title.toLowerCase().includes(fieldWords)) {
    score += 6;
  } else if (chunk.content.slice(0, 500).toLowerCase().includes(fieldWords)) {
    score += 3;
  }

  // Individual words from field name
  const words = fieldName.toLowerCase().split("_");
  const text = `${chunk.title} ${chunk.content.slice(0, 500)}`.toLowerCase();
  let wordHits = 0;
  for (const w of words) {
    if (w.length > 2 && text.includes(w)) {
      wordHits++;
    }
  }
  score += wordHits * 1.5;

  return score;
}

// ---------------------------------------------------------------------------
// Per-field max chunks
// ---------------------------------------------------------------------------

function fieldMaxChunks(fieldSpec: Record<string, unknown>, defaultMax: number): number {
  const hints = (fieldSpec.hints ?? {}) as Record<string, unknown>;
  const override = hints.max_chunks;
  if (typeof override === "number" && override > 0) {
    return override;
  }
  return defaultMax;
}

// ---------------------------------------------------------------------------
// Route fields
// ---------------------------------------------------------------------------

/**
 * Route each schema field to the most relevant chunks.
 *
 * `maxChunksPerField` is the default cap. Individual fields can
 * override via `hints.max_chunks` in the schema.
 */
export function routeFields(
  schemaDef: Record<string, unknown>,
  chunks: Chunk[],
  maxChunksPerField: number = 3,
): FieldRoute[] {
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const routes: FieldRoute[] = [];

  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    const hasHints = !!fieldSpec.hints;
    const fieldCap = fieldMaxChunks(fieldSpec, maxChunksPerField);

    // look_in is a hard filter when any chunks match
    const hints = (fieldSpec.hints ?? {}) as Record<string, unknown>;
    const lookIn = (hints.look_in ?? []) as string[];
    let candidateChunks = chunks;
    if (lookIn.length > 0) {
      const matches = chunks.filter((c) => c.category && lookIn.includes(c.category));
      if (matches.length > 0) {
        candidateChunks = matches;
      }
    }

    // Score every candidate chunk for this field
    const totalChunks = chunks.length;
    const scored: Array<[number, Chunk]> = [];
    for (const chunk of candidateChunks) {
      const s = scoreChunk(chunk, fieldName, fieldSpec, totalChunks);
      if (s > 0) {
        scored.push([s, chunk]);
      }
    }

    scored.sort((a, b) => b[0] - a[0]);
    const topChunks = scored.slice(0, fieldCap).map(([, c]) => c);

    if (topChunks.length > 0) {
      const source = hasHints ? "hint" : "signal_inferred";
      routes.push({
        fieldName,
        fieldSpec,
        chunks: topChunks,
        source,
      });
    } else {
      // Nothing matched — broaden to any chunk with generic signals
      const broadened = chunks.filter((c) => chunkHasAnySignal(c));
      if (broadened.length > 0) {
        routes.push({
          fieldName,
          fieldSpec,
          chunks: broadened.slice(0, fieldCap),
          source: "broadened",
        });
      } else {
        // Last resort — first chunks
        routes.push({
          fieldName,
          fieldSpec,
          chunks: chunks.slice(0, fieldCap),
          source: "fallback",
        });
      }
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Group routes
// ---------------------------------------------------------------------------

/**
 * Group fields that share the same chunks into extraction groups.
 * Minimizes LLM calls — fields from the same chunk get extracted together.
 */
export function groupRoutes(routes: FieldRoute[]): RouteGroup[] {
  const groups: RouteGroup[] = [];
  const usedFields = new Set<string>();

  const sorted = [...routes].sort((a, b) => {
    const aIndices = a.chunks.map((c) => c.index);
    const bIndices = b.chunks.map((c) => c.index);
    for (let i = 0; i < Math.max(aIndices.length, bIndices.length); i++) {
      const ai = aIndices[i] ?? -1;
      const bi = bIndices[i] ?? -1;
      if (ai !== bi) return ai - bi;
    }
    return 0;
  });

  for (const route of sorted) {
    if (usedFields.has(route.fieldName)) continue;

    const chunkIndices = new Set(route.chunks.map((c) => c.index));

    // Find other fields that share the same chunks
    const groupFields: FieldRoute[] = [route];
    for (const other of routes) {
      if (usedFields.has(other.fieldName) || other.fieldName === route.fieldName) {
        continue;
      }
      const otherIndices = new Set(other.chunks.map((c) => c.index));
      let overlapCount = 0;
      for (const idx of chunkIndices) {
        if (otherIndices.has(idx)) overlapCount++;
      }
      const overlap = overlapCount / Math.max(chunkIndices.size, 1);
      if (overlap >= 0.5) {
        groupFields.push(other);
      }
    }

    // Collect unique chunks
    const allChunks = new Map<number, Chunk>();
    for (const fieldRoute of groupFields) {
      for (const chunk of fieldRoute.chunks) {
        allChunks.set(chunk.index, chunk);
      }
    }

    const fieldNames = groupFields.map((f) => f.fieldName);
    const fieldSpecs: Record<string, Record<string, unknown>> = {};
    for (const f of groupFields) {
      fieldSpecs[f.fieldName] = f.fieldSpec;
    }

    for (const name of fieldNames) {
      usedFields.add(name);
    }

    groups.push({
      fields: fieldNames,
      fieldSpecs,
      chunks: [...allChunks.values()],
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Summarize routing (for logging)
// ---------------------------------------------------------------------------

export function summarizeRouting(routes: FieldRoute[]): Record<string, unknown> {
  const plan: Record<string, unknown> = {};
  for (const route of routes) {
    plan[route.fieldName] = {
      chunks: route.chunks.map((c) => `${c.index}: ${c.title}`),
      source: route.source,
    };
  }
  return plan;
}
