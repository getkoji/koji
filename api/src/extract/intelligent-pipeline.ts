/**
 * Intelligent extraction pipeline — port of Python services/extract/pipeline.py.
 *
 * Replaces the single-shot extractFields approach with:
 *   1. Document mapping (chunk, classify, detect signals)
 *   2. Optional packet classification (split multi-doc uploads into sections)
 *   3. Field routing (score chunks per field, group by overlap)
 *   4. Parallel group extraction (one LLM call per group)
 *   5. Wave-based field dependencies (toposort, conditional hints)
 *   6. Gap-fill retries (same-chunk × 3, broadened)
 *   7. Reconciliation + confidence scoring
 *   8. Verbatim snap-to-source
 *
 * The return type matches ExtractionResult so callers don't need changes.
 */

import { buildDocumentMap, type Chunk } from "./document-map";
import { routeFields, groupRoutes } from "./router";
import { toposortFields, resolveConditionalHints, resolveWaveFields } from "./waves";
import { extractGroup, fillGap } from "./group-extract";
import {
  reconcile,
  computeProvenanceStrength,
  computeFieldConfidence,
  scoreLabel,
  snapToSource,
} from "./reconcile";
import { classifyChunksToSections, type Section } from "./packet-splitter";
import type { ModelProvider } from "./providers";
import type { ExtractionResult } from "./pipeline";
import type { TextMap } from "./provenance";
import { resolveProvenance } from "./provenance";

export type { Chunk };

// ── Section-level extraction ────────────────────────────────────────

interface SectionResult {
  extracted: Record<string, unknown>;
  confidence: Record<string, string>;
  confidence_scores: Record<string, number>;
  gap_filled: string[];
  groups: Array<{ fields: string[]; chunkCount: number }>;
  source_texts: Record<string, string[]>;
}

/**
 * Run the wave + gap-fill extraction pipeline against a chunk slice.
 * Shared by both the classifier-on and classifier-off paths.
 */
async function extractOneSection(
  sectionChunks: Chunk[],
  allChunks: Chunk[],
  schemaDef: Record<string, unknown>,
  schemaName: string,
  provider: ModelProvider,
  fields: Record<string, Record<string, unknown>>,
): Promise<SectionResult> {
  const contextChunks = sectionChunks.slice(0, 2);
  const waves = toposortFields(schemaDef);

  const accumulated: {
    extracted: Record<string, unknown>;
    confidence: Record<string, string>;
    confidence_scores: Record<string, number>;
  } = { extracted: {}, confidence: {}, confidence_scores: {} };

  const allRoutes: Array<{ fieldName: string; chunks: Chunk[] }> = [];
  const allGroups: Array<{ fields: string[]; chunkCount: number }> = [];
  const allSourceTexts: Record<string, string[]> = {};

  // ── Wave loop ─────────────────────────────────────────────────

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex]!;
    const waveSchema = resolveWaveFields(schemaDef, wave, accumulated.extracted);

    const waveRoutes = routeFields(waveSchema, sectionChunks);
    for (const r of waveRoutes) {
      allRoutes.push({ fieldName: r.fieldName, chunks: r.chunks });
    }

    const waveGroups = groupRoutes(waveRoutes);
    for (const g of waveGroups) {
      allGroups.push({ fields: g.fields, chunkCount: g.chunks.length });
    }

    console.log(`[koji-extract] Wave ${waveIndex}: ${waveGroups.length} groups`);

    const groupResults = await Promise.all(
      waveGroups.map((g) =>
        extractGroup(g, schemaName, provider, contextChunks, schemaDef),
      ),
    );

    // Collect source texts
    for (const result of groupResults) {
      const st = result.__source_texts as Record<string, string[]> | undefined;
      if (st) {
        for (const [field, texts] of Object.entries(st)) {
          allSourceTexts[field] = texts;
        }
        delete result.__source_texts;
      }
    }

    const waveResult = reconcile(groupResults, waveSchema);

    // Re-score confidence with actual route chunks
    const waveFields = (waveSchema.fields ?? {}) as Record<string, Record<string, unknown>>;
    for (const [fieldName, value] of Object.entries(waveResult.extracted)) {
      const route = waveRoutes.find((r) => r.fieldName === fieldName);
      const routeChunks = route?.chunks ?? [];
      const fieldType = (waveFields[fieldName]?.type as string) ?? "string";
      if (value != null) {
        const prov = computeProvenanceStrength(value, routeChunks, fieldType);
        const isValid = waveResult.confidence[fieldName] !== "not_found";
        const score = computeFieldConfidence({ provenanceStrength: prov, validationPassed: isValid });
        waveResult.confidence_scores[fieldName] = score;
        waveResult.confidence[fieldName] = scoreLabel(score);
      }
    }

    Object.assign(accumulated.extracted, waveResult.extracted);
    Object.assign(accumulated.confidence, waveResult.confidence);
    Object.assign(accumulated.confidence_scores, waveResult.confidence_scores);
  }

  // ── Same-chunk retries ────────────────────────────────────────

  const MAX_SAME_CHUNK_RETRIES = 3;
  const routeByField = new Map<string, Chunk[]>();
  for (const r of allRoutes) {
    routeByField.set(r.fieldName, r.chunks);
  }

  let missingRequired = getMissingRequired(accumulated, fields);
  const gapFilled: string[] = [];

  if (missingRequired.length > 0) {
    let retryFields = missingRequired.filter(
      (f) => routeByField.has(f) && (routeByField.get(f)?.length ?? 0) > 0,
    );

    for (let retryRound = 1; retryRound <= MAX_SAME_CHUNK_RETRIES; retryRound++) {
      if (retryFields.length === 0) break;

      console.log(
        `[koji-extract] Same-chunk retry ${retryRound}/${MAX_SAME_CHUNK_RETRIES} for ${retryFields.length} fields`,
      );

      const retryResults = await Promise.all(
        retryFields.map((fieldName) => {
          const fieldSpec = resolveConditionalHints(fields[fieldName]!, accumulated.extracted);
          const fieldChunks = routeByField.get(fieldName) ?? [];
          return fillGap(fieldName, fieldSpec, fieldChunks, schemaName, provider, contextChunks)
            .then((result) => ({ fieldName, result, fieldChunks }));
        }),
      );

      const stillMissing: string[] = [];
      for (const { fieldName, result, fieldChunks } of retryResults) {
        const value = result[fieldName];
        if (value != null) {
          accumulated.extracted[fieldName] = value;
          const fieldSpec = fields[fieldName]!;
          const prov = computeProvenanceStrength(value, fieldChunks, (fieldSpec.type as string) ?? "string");
          const score = computeFieldConfidence({ provenanceStrength: prov, validationPassed: true });
          accumulated.confidence_scores[fieldName] = score;
          accumulated.confidence[fieldName] = scoreLabel(score);
          gapFilled.push(fieldName);
        } else {
          stillMissing.push(fieldName);
        }
      }
      retryFields = stillMissing;
    }

    missingRequired = getMissingRequired(accumulated, fields);
  }

  // ── Broadened gap-fill ────────────────────────────────────────

  if (missingRequired.length > 0) {
    console.log(`[koji-extract] Broadened gap-fill for ${missingRequired.length} fields`);

    const gapResults = await Promise.all(
      missingRequired.map((fieldName) => {
        const fieldSpec = resolveConditionalHints(fields[fieldName]!, accumulated.extracted);
        const strippedSpec = { ...fieldSpec };
        delete (strippedSpec as Record<string, unknown>).hints;
        const broadenedRoutes = routeFields(
          { fields: { [fieldName]: strippedSpec } } as Record<string, unknown>,
          sectionChunks,
          6,
        );
        const broadenedChunks = broadenedRoutes.length > 0
          ? broadenedRoutes[0]!.chunks
          : sectionChunks.slice(0, 6);

        return fillGap(fieldName, fieldSpec, broadenedChunks, schemaName, provider, contextChunks)
          .then((result) => ({ fieldName, result, broadenedChunks }));
      }),
    );

    for (const { fieldName, result, broadenedChunks } of gapResults) {
      const value = result[fieldName];
      if (value != null) {
        accumulated.extracted[fieldName] = value;
        const fieldSpec = fields[fieldName]!;
        const prov = computeProvenanceStrength(value, broadenedChunks, (fieldSpec.type as string) ?? "string");
        const score = computeFieldConfidence({ provenanceStrength: prov, validationPassed: true });
        accumulated.confidence_scores[fieldName] = score;
        accumulated.confidence[fieldName] = scoreLabel(score);
        gapFilled.push(fieldName);
      }
    }
  }

  // ── Verbatim snap-to-source ───────────────────────────────────

  for (const [fieldName, value] of Object.entries(accumulated.extracted)) {
    if (typeof value !== "string" || !value) continue;
    const fieldSpec = fields[fieldName];
    if (fieldSpec?.verbatim) {
      const snapped = snapToSource(value, sectionChunks);
      if (snapped !== value) {
        accumulated.extracted[fieldName] = snapped;
      }
    }
  }

  return {
    extracted: accumulated.extracted,
    confidence: accumulated.confidence,
    confidence_scores: accumulated.confidence_scores,
    gap_filled: gapFilled,
    groups: allGroups,
    source_texts: allSourceTexts,
  };
}

// ── Main entry point ────────────────────────────────────────────────

export async function intelligentExtract(
  markdown: string,
  schemaDef: Record<string, unknown>,
  provider: ModelProvider,
  model: string,
  textMap?: TextMap,
): Promise<ExtractionResult> {
  const start = Date.now();
  const schemaName = (schemaDef.name as string) ?? "unknown";
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const fieldNames = new Set(Object.keys(fields));

  console.log(
    `[koji-extract] intelligent pipeline: model=${model}, ` +
    `markdown=${markdown.length} chars, fields=${[...fieldNames].join(",")}`,
  );

  // Phase 1: Document mapping
  const chunks = buildDocumentMap(markdown, schemaDef);
  console.log(`[koji-extract] Map: ${chunks.length} chunks`);

  if (chunks.length === 0) {
    return emptyResult(model, schemaName, fieldNames, start);
  }

  // Phase 2: Classifier (optional — splits multi-doc packets into sections)
  const classifyConfig = schemaDef.classify as Record<string, unknown> | undefined;

  if (classifyConfig) {
    return classifierPath(
      chunks, classifyConfig, schemaDef, schemaName, fields,
      fieldNames, provider, model, markdown, textMap, start,
    );
  }

  // ── Classifier OFF: single-section extraction ───────────────────

  const sectionResult = await extractOneSection(chunks, chunks, schemaDef, schemaName, provider, fields);

  const provenance = textMap
    ? resolveProvenance(sectionResult.extracted, markdown, textMap, {}, fields, {}, {})
    : undefined;

  const elapsedMs = Date.now() - start;
  console.log(
    `[koji-extract] Extracted ${Object.keys(sectionResult.extracted).length} fields in ${elapsedMs}ms ` +
    `(${chunks.length} chunks, ${sectionResult.groups.length} groups, ${sectionResult.gap_filled.length} gap-filled)`,
  );

  return {
    model,
    strategy: "intelligent",
    schema: schemaName,
    elapsed_ms: elapsedMs,
    extracted: sectionResult.extracted,
    confidence: sectionResult.confidence,
    confidence_scores: sectionResult.confidence_scores,
    provenance,
    gap_filled: sectionResult.gap_filled,
    document_map_summary: { total_chunks: chunks.length },
    routing_plan: {},
    groups: sectionResult.groups,
    ...(Object.keys(sectionResult.source_texts).length > 0
      ? { source_texts: sectionResult.source_texts }
      : {}),
  };
}

// ── Classifier path ─────────────────────────────────────────────────

async function classifierPath(
  chunks: Chunk[],
  classifyConfig: Record<string, unknown>,
  schemaDef: Record<string, unknown>,
  schemaName: string,
  fields: Record<string, Record<string, unknown>>,
  fieldNames: Set<string>,
  provider: ModelProvider,
  model: string,
  markdown: string,
  textMap: TextMap | undefined,
  start: number,
): Promise<ExtractionResult> {
  const types = (classifyConfig.types ?? []) as Array<{ id?: string; description?: string }>;
  const applyTo = schemaDef.apply_to as string[] | undefined;

  // If schema declares apply_to, force classifier even on short docs
  const classifyOptions: Record<string, unknown> = {};
  if (classifyConfig.short_doc_chunks != null) {
    classifyOptions.shortDocChunks = classifyConfig.short_doc_chunks;
  }
  if (classifyConfig.coalesce_other_threshold != null) {
    classifyOptions.coalesceOtherThreshold = classifyConfig.coalesce_other_threshold;
  }
  if (applyTo != null) {
    classifyOptions.shortDocChunks = 0;
  }

  const classifyResult = await classifyChunksToSections(
    chunks, provider, types, classifyOptions,
  );

  console.log(
    `[koji-extract] Classifier: ${classifyResult.sections.length} section(s) ` +
    `(${classifyResult.corrections} corrections)`,
  );

  // Extract each matching section
  const sectionResults: Array<Record<string, unknown>> = [];
  for (const section of classifyResult.sections) {
    if (!sectionMatchesSchema(section, schemaDef, applyTo)) {
      continue;
    }

    const sectionChunks = section.chunks;
    if (sectionChunks.length === 0) continue;

    console.log(
      `[koji-extract] Extracting section type=${section.type} (${sectionChunks.length} chunks)`,
    );

    const sr = await extractOneSection(sectionChunks, chunks, schemaDef, schemaName, provider, fields);
    sectionResults.push({
      section_type: section.type,
      section_confidence: section.confidence,
      ...sr,
    });
  }

  const elapsedMs = Date.now() - start;

  if (sectionResults.length === 0) {
    console.log("[koji-extract] No matching sections found");
    return {
      ...emptyResult(model, schemaName, fieldNames, start),
      elapsed_ms: elapsedMs,
      document_map_summary: { total_chunks: chunks.length },
    };
  }

  // For now, return the first matching section's results.
  // The Python pipeline returns a sections list; callers that need
  // multi-section support can read the sections array.
  const first = sectionResults[0]! as SectionResult & { section_type: string };
  return {
    model,
    strategy: "intelligent",
    schema: schemaName,
    elapsed_ms: elapsedMs,
    extracted: first.extracted,
    confidence: first.confidence,
    confidence_scores: first.confidence_scores,
    gap_filled: first.gap_filled,
    document_map_summary: { total_chunks: chunks.length },
    routing_plan: {},
    groups: first.groups,
    ...(Object.keys(first.source_texts).length > 0
      ? { source_texts: first.source_texts }
      : {}),
  };
}

function sectionMatchesSchema(
  section: Section,
  schemaDef: Record<string, unknown>,
  applyTo: string[] | undefined,
): boolean {
  if (!applyTo) return true;
  if (!Array.isArray(applyTo)) return false;
  return applyTo.includes(section.type);
}

// ── Helpers ──────────────────────────────────────────────────────────

function getMissingRequired(
  accumulated: { confidence: Record<string, string> },
  fields: Record<string, Record<string, unknown>>,
): string[] {
  return Object.entries(accumulated.confidence)
    .filter(([name, conf]) => conf === "not_found" && fields[name]?.required)
    .map(([name]) => name);
}

function emptyResult(
  model: string,
  schemaName: string,
  fieldNames: Set<string>,
  startTime: number,
): ExtractionResult {
  return {
    model,
    strategy: "intelligent",
    schema: schemaName,
    elapsed_ms: Date.now() - startTime,
    extracted: Object.fromEntries([...fieldNames].map((f) => [f, null])),
    confidence: Object.fromEntries([...fieldNames].map((f) => [f, "not_found"])),
    confidence_scores: Object.fromEntries([...fieldNames].map((f) => [f, 0])),
  };
}
