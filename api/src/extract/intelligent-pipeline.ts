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
import { routeFields, routeAllChunks, groupRoutes } from "./router";
import { toposortFields, resolveConditionalHints, resolveWaveFields, getSkippedFields } from "./waves";
import { enumerateRows, extractGroup, fillGap } from "./group-extract";
import {
  reconcile,
  computeProvenanceStrength,
  computeFieldConfidence,
  scoreLabel,
  snapToSource,
} from "./reconcile";
import { classifyChunksToSections, type Section } from "./packet-splitter";
import {
  parseFitConfig,
  hasPreGate,
  checkKeywords,
  checkAssertion,
  checkDerived,
  assembleFit,
  type FitConfig,
  type FitCheck,
} from "./fit";
import type { ModelProvider } from "./providers";
import type { ExtractionResult } from "./pipeline";
import type { TextMap } from "./provenance";
import { resolveProvenance } from "./provenance";
import type { ParseChunk } from "../parse/chunk";
import { applyKeepRaw, schemaHasKeepRaw } from "./keep-raw";
import { stripHintLeaks } from "./hint-leak";

export type { Chunk };

// ── Section-level extraction ────────────────────────────────────────

/**
 * Per-field routing record for debug/diagnosis. `chunks` is the ordered set of
 * chunks the field was routed to (index + heading for display); `text` is those
 * chunks' concatenated content, used downstream (e.g. validate) to check whether
 * a field's expected answer was even present in what the model saw — a routing
 * miss no model upgrade can fix. Generic — no document-type logic.
 */
export interface RoutingPlanEntry {
  source: string;
  chunks: Array<{ index: number; title: string }>;
  text: string;
}

interface SectionResult {
  extracted: Record<string, unknown>;
  confidence: Record<string, string>;
  confidence_scores: Record<string, number>;
  gap_filled: string[];
  hint_leaks: string[];
  groups: Array<{ fields: string[]; chunkCount: number }>;
  source_texts: Record<string, string[]>;
  scalar_source_texts: Record<string, string>;
  source_contexts: Record<string, string>;
  routing_plan: Record<string, RoutingPlanEntry>;
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
  routeAll: boolean = false,
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
  // Per-field routing record, accumulated across waves and gap-fill so it
  // reflects every chunk the field was ever shown. Keyed by field; chunks are
  // de-duped by index. Feeds `routing_plan` for debug/diagnosis.
  const routePlan = new Map<string, { source: string; chunks: Map<number, Chunk> }>();
  const allSourceTexts: Record<string, string[]> = {};
  const allScalarSourceTexts: Record<string, string> = {};
  const allSourceContexts: Record<string, string> = {};

  // ── Wave loop ─────────────────────────────────────────────────

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex]!;
    const waveSchema = resolveWaveFields(schemaDef, wave, accumulated.extracted);

    // Record skip_unless-gated fields as null/"skipped" before extraction
    // — they're dropped from waveSchema, so the LLM never sees them.
    const skippedFields = getSkippedFields(schemaDef, wave, accumulated.extracted);
    for (const name of skippedFields) {
      accumulated.extracted[name] = null;
      accumulated.confidence[name] = "skipped";
      accumulated.confidence_scores[name] = 0;
    }
    if (skippedFields.length > 0) {
      console.log(`[koji-extract] Wave ${waveIndex}: skipped ${skippedFields.length} fields via skip_unless`);
    }

    const waveRoutes = routeAll
      ? routeAllChunks(waveSchema, sectionChunks)
      : routeFields(waveSchema, sectionChunks);
    for (const r of waveRoutes) {
      allRoutes.push({ fieldName: r.fieldName, chunks: r.chunks });
      // Record the initial route (source + chunks) for the debug plan. Fields
      // are partitioned across waves, so first-seen is the field's own route.
      if (!routePlan.has(r.fieldName)) {
        routePlan.set(r.fieldName, {
          source: r.source,
          chunks: new Map(r.chunks.map((c) => [c.index, c])),
        });
      }
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

    // Collect all LLM-provided source annotations from group results
    for (const result of groupResults) {
      const st = result.__source_texts as Record<string, string[]> | undefined;
      if (st) {
        Object.assign(allSourceTexts, st);
        delete result.__source_texts;
      }
      const sst = result.__scalar_source_texts as Record<string, string> | undefined;
      if (sst) {
        Object.assign(allScalarSourceTexts, sst);
        delete result.__scalar_source_texts;
      }
      const sc = result.__source_contexts as Record<string, string> | undefined;
      if (sc) {
        Object.assign(allSourceContexts, sc);
        delete result.__source_contexts;
      }
    }

    const waveResult = reconcile(groupResults, waveSchema);

    // Re-score confidence against all section chunks (not just routed chunks).
    // The LLM sees the group's full chunk set (union of all fields' routes +
    // context chunks), so a value found anywhere in the section is legitimate.
    // Scoring against only the routed chunks penalizes fields that were
    // extracted from context or from a co-grouped field's chunks.
    const waveFields = (waveSchema.fields ?? {}) as Record<string, Record<string, unknown>>;
    for (const [fieldName, value] of Object.entries(waveResult.extracted)) {
      const fieldType = (waveFields[fieldName]?.type as string) ?? "string";
      if (value != null) {
        const prov = computeProvenanceStrength(value, sectionChunks, fieldType, allScalarSourceTexts[fieldName]);
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
      // Fold the broadened chunk set into the routing record — for a field that
      // still fails, the plan should reflect everything the model was shown, so
      // "answer never reached the model" can be distinguished from "model missed
      // it." Keep the original `source` (the initial routing decision).
      const entry = routePlan.get(fieldName);
      if (entry) {
        for (const c of broadenedChunks) entry.chunks.set(c.index, c);
      }
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

  // ── enumerate_rows completion pass ────────────────────────────
  // For an opted-in array field, re-prompt over its chunks to list EVERY row —
  // catching the model's first-pass under-count of a co-located table (which no
  // amount of routing fixes, since all rows are already in the chunk). The
  // returned rows are unioned+deduped with what we have.
  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    const hints = fieldSpec.hints as Record<string, unknown> | undefined;
    if (hints?.enumerate_rows !== true || (fieldSpec.type as string) !== "array") continue;
    const current = accumulated.extracted[fieldName];
    if (!Array.isArray(current) || current.length === 0) continue;
    const enumChunks = routeByField.get(fieldName) ?? [];
    if (enumChunks.length === 0) continue;

    const resolved = resolveConditionalHints(fields[fieldName]!, accumulated.extracted);
    const more = await enumerateRows(fieldName, resolved, enumChunks, current, provider, contextChunks);
    const merged = unionArrayItems(current, more);
    if (merged.length > current.length) {
      console.log(`[koji-extract] enumerate_rows: ${fieldName} ${current.length} -> ${merged.length} rows`);
      // Extend the field's index-aligned source_texts to cover the appended
      // rows. Enumerated items carry inline `__source_text` (the enumeration
      // prompt requests it); harvest and strip it here so appended rows keep
      // provenance and stay eligible for the source-text row gate
      // (`skip_row_when`) downstream — both need the alignment to hold for
      // the whole merged array. Union preserves order: `current` first (their
      // texts were harvested in the main pass), appended extras after.
      const existing = allSourceTexts[fieldName] ?? [];
      const texts = merged.map((item, i) => {
        if (i < current.length) return existing[i] ?? "";
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>;
          const src = obj.__source_text;
          delete obj.__source_text;
          return typeof src === "string" ? src : "";
        }
        return "";
      });
      if (texts.some((t) => t.length > 0)) {
        allSourceTexts[fieldName] = texts;
      }
      accumulated.extracted[fieldName] = merged;
      const prov = computeProvenanceStrength(merged, enumChunks, "array");
      const score = computeFieldConfidence({ provenanceStrength: prov, validationPassed: true });
      accumulated.confidence_scores[fieldName] = score;
      accumulated.confidence[fieldName] = scoreLabel(score);
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

  // ── Hint-example leak guard ───────────────────────────────────
  // A value the model copied verbatim from its field's own extraction_hint
  // (and that provenance can't locate anywhere in the section) is a prompt
  // echo, not an extraction — null it and rescore. See ./hint-leak.ts.

  const hintLeaks = stripHintLeaks(
    accumulated.extracted, fields, sectionChunks, allScalarSourceTexts,
  );
  for (const fieldName of hintLeaks) {
    const remaining = accumulated.extracted[fieldName];
    if (remaining == null || (Array.isArray(remaining) && remaining.length === 0)) {
      accumulated.confidence[fieldName] = "not_found";
      accumulated.confidence_scores[fieldName] = 0;
    } else {
      const fieldType = (fields[fieldName]?.type as string) ?? "string";
      const prov = computeProvenanceStrength(remaining, sectionChunks, fieldType);
      const score = computeFieldConfidence({ provenanceStrength: prov, validationPassed: true });
      accumulated.confidence_scores[fieldName] = score;
      accumulated.confidence[fieldName] = scoreLabel(score);
    }
    console.log(
      `[koji-extract] Hint-leak guard: ${fieldName} matched its extraction hint with no source in section — nulled`,
    );
  }

  // Materialize the per-field routing plan: chunks ordered by document position,
  // with their concatenated content for downstream answer-presence checks.
  const routing_plan: Record<string, RoutingPlanEntry> = {};
  for (const [fieldName, entry] of routePlan) {
    const chunks = [...entry.chunks.values()].sort((a, b) => a.index - b.index);
    routing_plan[fieldName] = {
      source: entry.source,
      chunks: chunks.map((c) => ({ index: c.index, title: c.title })),
      text: chunks.map((c) => c.content).join("\n\n"),
    };
  }

  return {
    extracted: accumulated.extracted,
    confidence: accumulated.confidence,
    confidence_scores: accumulated.confidence_scores,
    gap_filled: gapFilled,
    hint_leaks: hintLeaks,
    groups: allGroups,
    source_texts: allSourceTexts,
    scalar_source_texts: allScalarSourceTexts,
    source_contexts: allSourceContexts,
    routing_plan,
  };
}

// ── Main entry point ────────────────────────────────────────────────

export async function intelligentExtract(
  markdown: string,
  schemaDef: Record<string, unknown>,
  provider: ModelProvider,
  model: string,
  textMap?: TextMap,
  parseChunks?: readonly ParseChunk[],
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

  // Phase 1b: Document-fit pre-extraction gate. The schema's `fit` block can
  // declare a keyword check (free) and a `requires` assertion (one yes/no LLM
  // call) that run before extraction. Under `on_misfit: reject`, a failed
  // pre-extraction check skips extraction entirely. The derived grounding signal
  // is computed after extraction. See ./fit.ts and docs/schema-guide.md.
  const fitCfg = parseFitConfig(schemaDef);
  const fitPreChecks: Array<FitCheck | null> = [];
  if (fitCfg && hasPreGate(fitCfg)) {
    const excerpt = chunks.slice(0, 4).map((c) => c.content).join("\n");
    fitPreChecks.push(checkKeywords(markdown, fitCfg));
    if (fitCfg.requires) {
      fitPreChecks.push(await checkAssertion(excerpt, fitCfg, provider));
    }
    const preReport = assembleFit(fitPreChecks, fitCfg, schemaName);
    if (!preReport.ok && fitCfg.onMisfit === "reject") {
      const rejected = assembleFit(fitPreChecks, fitCfg, schemaName, true);
      console.log(`[koji-extract] Fit gate rejected document (${rejected.reason}); skipping extraction`);
      return {
        ...emptyResult(model, schemaName, fieldNames, start),
        document_map_summary: { total_chunks: chunks.length },
        fit: rejected,
      };
    }
  }

  // Phase 2: Classifier (optional — splits multi-doc packets into sections)
  const classifyConfig = schemaDef.classify as Record<string, unknown> | undefined;

  if (classifyConfig) {
    return classifierPath(
      chunks, classifyConfig, schemaDef, schemaName, fields,
      fieldNames, provider, model, markdown, textMap, start,
      fitCfg, fitPreChecks,
    );
  }

  // ── Classifier OFF: single-section extraction ───────────────────

  // Adaptive routing: when a document is small enough that per-field chunk
  // selection only drops useful context, route the whole document in one pass.
  // Empirically, full-document extraction ties-or-beats routed extraction below
  // ~10 chunks (and is cheaper); routing wins decisively above. Purely chunk-count
  // driven — no document-type logic. Configurable / disable-able per schema.
  const fullDocThreshold = resolveFullDocThreshold(schemaDef);
  const routeAll = fullDocThreshold > 0 && chunks.length < fullDocThreshold;
  if (routeAll) {
    console.log(
      `[koji-extract] Adaptive routing: ${chunks.length} < ${fullDocThreshold} chunks → full-document single pass`,
    );
  }

  const sectionResult = await extractOneSection(chunks, chunks, schemaDef, schemaName, provider, fields, routeAll);

  // Resolve provenance when a textMap is present (for bbox highlighting), when
  // structured chunks carry geometry (PB-11 bbox + column-mismatch flag), OR
  // when any field opts into keep_raw (the verbatim `chunk` doesn't need a
  // textMap).
  const needsRaw = schemaHasKeepRaw(fields);
  const hasChunkGeometry = !!parseChunks?.some((c) => c.bbox);
  const resolvedProvenance = (textMap || hasChunkGeometry || needsRaw)
    ? resolveProvenance(
        sectionResult.extracted, markdown, textMap,
        sectionResult.source_texts,
        fields,
        sectionResult.scalar_source_texts,
        sectionResult.source_contexts,
        parseChunks,
      )
    : undefined;
  if (needsRaw) {
    applyKeepRaw(sectionResult.extracted, fields, resolvedProvenance);
  }
  // Expose provenance to the caller when a textMap or chunk geometry backed it.
  const provenance = (textMap || hasChunkGeometry) ? resolvedProvenance : undefined;

  const elapsedMs = Date.now() - start;
  console.log(
    `[koji-extract] Extracted ${Object.keys(sectionResult.extracted).length} fields in ${elapsedMs}ms ` +
    `(${chunks.length} chunks, ${sectionResult.groups.length} groups, ${sectionResult.gap_filled.length} gap-filled)`,
  );

  // Combine the pre-extraction gate with the derived grounding signal into a
  // single `fit` verdict the caller can act on.
  const fit = fitCfg
    ? assembleFit(
        [...fitPreChecks, checkDerived(sectionResult.confidence_scores, fitCfg, schemaDef)],
        fitCfg,
        schemaName,
      )
    : undefined;

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
    ...(sectionResult.hint_leaks.length > 0 ? { hint_leaks: sectionResult.hint_leaks } : {}),
    document_map_summary: { total_chunks: chunks.length },
    routing_plan: sectionResult.routing_plan,
    groups: sectionResult.groups,
    ...(fit ? { fit } : {}),
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
  fitCfg: FitConfig | null,
  fitPreChecks: Array<FitCheck | null>,
): Promise<ExtractionResult> {
  const types = (classifyConfig.types ?? []) as Array<{ id?: string; description?: string }>;
  const applyTo = schemaDef.apply_to as string[] | undefined;

  // When the classifier is on, per-section relevance is `apply_to`'s job, so
  // the derived grounding signal is a classifier-off feature. The document-level
  // pre-extraction gate (keywords / requires) still applies and rides at the top.
  const fit =
    fitCfg && hasPreGate(fitCfg) ? assembleFit(fitPreChecks, fitCfg, schemaName) : undefined;

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
  const sectionResults: Array<SectionResult & { section_type: string; section_confidence: number }> = [];
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
      ...(fit ? { fit } : {}),
    };
  }

  // For now, return the first matching section's results.
  // The Python pipeline returns a sections list; callers that need
  // multi-section support can read the sections array.
  const first = sectionResults[0]!;
  return {
    model,
    strategy: "intelligent",
    schema: schemaName,
    elapsed_ms: elapsedMs,
    extracted: first.extracted,
    confidence: first.confidence,
    confidence_scores: first.confidence_scores,
    gap_filled: first.gap_filled,
    ...(first.hint_leaks.length > 0 ? { hint_leaks: first.hint_leaks } : {}),
    document_map_summary: { total_chunks: chunks.length },
    routing_plan: first.routing_plan,
    groups: first.groups,
    ...(fit ? { fit } : {}),
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

/** Default adaptive-routing threshold: route the whole document in one pass
 * below this many chunks. Empirically the routed/full-document crossover. */
const DEFAULT_FULL_DOCUMENT_BELOW = 10;

/**
 * Resolve the adaptive-routing threshold from schema config
 * (`routing.full_document_below`). Documents with fewer than this many chunks
 * are extracted as a single full-document pass. Defaults to 10; set to 0 to
 * disable (always route per-field). Generic — keyed only on chunk count.
 */
function resolveFullDocThreshold(schemaDef: Record<string, unknown>): number {
  const routing = schemaDef.routing as Record<string, unknown> | undefined;
  const v = routing?.full_document_below;
  if (v === undefined || v === null) return DEFAULT_FULL_DOCUMENT_BELOW;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FULL_DOCUMENT_BELOW;
}

function getMissingRequired(
  accumulated: { confidence: Record<string, string> },
  fields: Record<string, Record<string, unknown>>,
): string[] {
  return Object.entries(accumulated.confidence)
    .filter(([name, conf]) => conf === "not_found" && fields[name]?.required)
    .map(([name]) => name);
}

/**
 * Union two arrays of items, deduping by content. Mirrors reconcile's array
 * dedup (canonical JSON of the item), but ignores `__`-prefixed provenance keys
 * so a re-enumerated row that only differs by its `__source_text` doesn't
 * duplicate an existing one. Keeps the first occurrence (existing items win).
 */
function unionArrayItems(current: unknown[], extra: unknown[]): unknown[] {
  const canonical = (item: unknown): string => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const stripped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (!k.startsWith("__")) stripped[k] = v;
      }
      return JSON.stringify(stripped, Object.keys(stripped).sort());
    }
    return String(item);
  };
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of [...current, ...extra]) {
    const key = canonical(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
