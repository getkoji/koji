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
  source: "hint" | "signal_inferred" | "broadened" | "fallback" | "full_document" | "per_section";
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
// Coverage-maximizing selection (per_section)
// ---------------------------------------------------------------------------

/** Default cap on distinct sections a `per_section` field will pull. */
const DEFAULT_MAX_SECTIONS = 24;

/**
 * The section a chunk belongs to, for coverage-maximizing selection. Generic:
 * the heading text (`title`) identifies a section — distinct parts of a large
 * package carry distinct headings. Falls back to `category`, then a shared
 * bucket, so untitled chunks don't each become their own "section".
 */
function sectionKey(chunk: Chunk): string {
  const title = (chunk.title ?? "").trim().toLowerCase();
  if (title) return `t:${title}`;
  if (chunk.category) return `c:${chunk.category}`;
  return "__untitled";
}

/** How much of a chunk's body to scan when anchor-matching a section. */
const ANCHOR_SCAN = 800;

/**
 * Compile a `section_anchor` hint (a regex string or a list of them) into
 * RegExps. Invalid patterns are skipped rather than failing the whole route.
 */
function compileSectionAnchors(raw: unknown): RegExp[] {
  const patterns = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== "string" || !p) continue;
    try {
      compiled.push(new RegExp(p, "i"));
    } catch {
      // Skip a malformed pattern — a schema-author bug shouldn't drop the field.
    }
  }
  return compiled;
}

/**
 * Whether a chunk's section matches any anchor pattern. Matches against the
 * heading plus the head of the body so an anchor works whether the identifying
 * phrase is the title or the top line of the section.
 */
function matchesAnchor(chunk: Chunk, anchors: RegExp[]): boolean {
  const text = `${chunk.title ?? ""}\n${(chunk.content ?? "").slice(0, ANCHOR_SCAN)}`;
  return anchors.some((re) => re.test(text));
}

/**
 * Coverage-maximizing selection for an array field: instead of the globally
 * top-N chunks (which collapse onto the highest-scoring few and starve whole
 * sections on large multi-part documents), take the best-scoring chunk from
 * EACH distinct section so every qualifying section reaches the extractor.
 *
 * `scored` must be sorted by score descending — so the first chunk seen per
 * section is that section's best, and the Map preserves score-descending
 * section order for the safety cap. Returns chunks in document order (by
 * index) for a stable, readable prompt.
 */
/** Default cap on chunks pulled from a single section. Sections whose table
 *  spans multiple chunks need more than one, or rows in the dropped chunks are
 *  lost; the cap bounds context on pathologically large sections. */
const DEFAULT_CHUNKS_PER_SECTION = 4;

function selectCoverageMax(
  scored: Array<[number, Chunk]>,
  maxSections: number,
  chunksPerSection: number = DEFAULT_CHUNKS_PER_SECTION,
): { chunks: Chunk[]; sectionsFound: number } {
  // Group ALL chunks per section (score-descending within each), not just the
  // best one — a coverage-part/limits table that spans multiple chunks with the
  // same heading must keep every chunk, or the rows in the dropped chunks never
  // reach the model (the intra-section recall bug).
  const bySection = new Map<string, Chunk[]>();
  for (const [, chunk] of scored) {
    const key = sectionKey(chunk);
    const bucket = bySection.get(key);
    if (bucket) bucket.push(chunk);
    else bySection.set(key, [chunk]);
  }
  const sectionsFound = bySection.size;
  // Insertion order = score-descending by each section's best chunk, so slicing
  // keeps the highest-scoring sections when there are more than the cap.
  const chunks: Chunk[] = [];
  for (const bucket of [...bySection.values()].slice(0, maxSections)) {
    chunks.push(...bucket.slice(0, chunksPerSection));
  }
  chunks.sort((a, b) => a.index - b.index);
  return { chunks, sectionsFound };
}

/**
 * Expand a selected chunk set to include chunks within ±`radius` document
 * positions (by `index`), looked up in the FULL chunk set — so a neighbor in a
 * different category (one `look_in` filtered out) is still reachable. Lets a
 * field reach a value that sits in a chunk adjacent to the one holding its
 * label. Returns chunks in document order.
 */
function expandNeighbors(selected: Chunk[], all: Chunk[], radius: number): Chunk[] {
  const byIndex = new Map<number, Chunk>();
  for (const c of all) byIndex.set(c.index, c);
  const out = new Map<number, Chunk>();
  for (const c of selected) out.set(c.index, c);
  for (const c of selected) {
    for (let d = 1; d <= radius; d++) {
      for (const ni of [c.index - d, c.index + d]) {
        const n = byIndex.get(ni);
        if (n && !out.has(ni)) out.set(ni, n);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
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

    // `per_section`: coverage-maximizing selection. For an array field on a
    // large multi-part document, one chunk per distinct section reaches the
    // extractor — not just the globally top-N (which collapse onto the few
    // highest-scoring chunks and drop whole sections). Opt-in per field, so
    // small/monoline docs are unaffected (they simply have fewer sections).
    const perSection = hints.per_section === true;
    let topChunks: Chunk[];
    if (perSection && scored.length > 0) {
      const maxSections =
        typeof hints.max_sections === "number" && hints.max_sections > 0
          ? hints.max_sections
          : DEFAULT_MAX_SECTIONS;
      // `section_anchor` gates WHICH sections per_section visits: only sections
      // whose heading/top-of-body matches an anchor pattern get a representative
      // chunk. This stops per_section from over-producing spurious rows out of
      // boilerplate (product-catalog menus, "who is an insured" blocks) on large
      // packages. If the anchor matches nothing, fall back to all sections (a
      // too-narrow pattern shouldn't make a field silently vanish).
      const anchors = compileSectionAnchors(hints.section_anchor);
      let scopedScored = scored;
      if (anchors.length > 0) {
        const filtered = scored.filter(([, c]) => matchesAnchor(c, anchors));
        if (filtered.length > 0) {
          scopedScored = filtered;
        } else {
          console.warn(
            `[koji-extract] Route: field '${fieldName}' section_anchor matched no section — using all sections.`,
          );
        }
      }
      const chunksPerSection =
        typeof hints.chunks_per_section === "number" && hints.chunks_per_section > 0
          ? hints.chunks_per_section
          : DEFAULT_CHUNKS_PER_SECTION;
      const sel = selectCoverageMax(scopedScored, maxSections, chunksPerSection);
      topChunks = sel.chunks;
      if (sel.sectionsFound > maxSections) {
        console.warn(
          `[koji-extract] Route: field '${fieldName}' per_section capped ` +
            `${sel.sectionsFound} sections to ${maxSections} (raise hints.max_sections to include all).`,
        );
      }
    } else {
      topChunks = scored.slice(0, fieldCap).map(([, c]) => c);
    }

    // `neighbor_radius`: a value can land in a different chunk than its label
    // (e.g. a dense dec where "$1,691" and its "TOTAL DEPOSIT PREMIUM" label
    // split across a chunk boundary), so no single routed chunk holds both
    // anchor and value and the field is unreachable via look_in/prefer_contains
    // alone. When set, also pull chunks within ±radius document positions of
    // each selected chunk. Opt-in; pair with prefer_contains/patterns so the
    // label chunk is the one selected and its neighbor carries the value.
    const neighborRadius =
      typeof hints.neighbor_radius === "number" && hints.neighbor_radius > 0
        ? hints.neighbor_radius
        : 0;
    if (neighborRadius > 0 && topChunks.length > 0) {
      topChunks = expandNeighbors(topChunks, chunks, neighborRadius);
    }

    if (topChunks.length > 0) {
      const source = perSection ? "per_section" : hasHints ? "hint" : "signal_inferred";
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

/**
 * Route every field to the full chunk set — used by adaptive routing when a
 * document is small enough that per-field selection only loses context. Each
 * field gets all chunks, so `groupRoutes` collapses them into a single group
 * (one full-document LLM call). Generic and document-type agnostic — the only
 * input is the chunk count, never the content or category.
 */
export function routeAllChunks(
  schemaDef: Record<string, unknown>,
  chunks: Chunk[],
): FieldRoute[] {
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(fields).map(([fieldName, fieldSpec]) => ({
    fieldName,
    fieldSpec,
    chunks,
    source: "full_document" as const,
  }));
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

  // Some fields extract in isolation — each becomes its own singleton group and
  // takes no part in the overlap-based grouping below (as either a seed or a
  // candidate). Two cases:
  //
  //  • per_section fields, whose chunk set is deliberately expanded to one chunk
  //    per section (potentially spanning the whole document). Folding that union
  //    into a shared group would make every sibling extract against all those
  //    sections — a scalar sharing one section chunk would inherit the rest and
  //    mis-extract (e.g. a carrier name stamped on each coverage-part header).
  //
  //  • fields with `hints.isolate: true`. A grouped field is extracted in one
  //    LLM call over the UNION of the group's chunks, alongside every other
  //    member's instructions — so its output depends on siblings' routing and
  //    flips when an unrelated field's hint changes. `isolate` pins a critical
  //    field to exactly its own routed chunks and its own instruction, making it
  //    stable with respect to the rest of the schema.
  const isIsolated = (r: FieldRoute): boolean =>
    r.source === "per_section" ||
    ((r.fieldSpec.hints as Record<string, unknown> | undefined)?.isolate === true);

  const groupableRoutes = routes.filter((r) => !isIsolated(r));
  for (const route of routes) {
    if (!isIsolated(route)) continue;
    groups.push({
      fields: [route.fieldName],
      fieldSpecs: { [route.fieldName]: route.fieldSpec },
      chunks: [...route.chunks],
    });
  }

  const usedFields = new Set<string>();

  const sorted = [...groupableRoutes].sort((a, b) => {
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
    for (const other of groupableRoutes) {
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
