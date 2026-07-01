/**
 * `ingestion.process` worker — turns a `documents` row that's ready to
 * extract into either a delivered result or a queued review item.
 *
 * Two upstream entry points create work for this handler. Both create the
 * job + document rows synchronously and enqueue {kind: "ingestion.process",
 * payload: {documentId}}:
 *
 *   1. POST /api/sources/:id/webhook — also writes an ingestions row, links
 *      it to the document, and runs whatever filter rules the source has.
 *   2. POST /api/pipelines/:idOrSlug/run — manual upload from the dashboard.
 *      No ingestion row; the document is created directly under the pipeline.
 *
 * Keeping the handler payload uniform means the same retry/idempotency logic
 * and error reporting works for both paths. See document-state-machine.md §6
 * for the confidence-gate rules implemented here.
 */

import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseChunk } from "../parse/chunk";
import {
  createParseProvider,
  type ParseConfig,
  type ParseProviderOptions,
} from "../parse/factory";
import { type ResolvedTenantParse } from "../parse/resolve-tenant-parse";
import {
  parseCacheStorageKey,
  DEFAULT_PARSE_FINGERPRINT,
} from "../parse/cache-fingerprint";
import { resolveParse, parseDocument } from "./seam";
import { PARSE_VERSION, isParseCacheFresh } from "./parse-version";
import { mimeTypeFor, normalizeMimeType } from "./mime";

// Re-exported so existing import sites (routes/*, tests) that pull these from
// `./process` keep working. The implementations live in the dependency-free
// `./mime` module so the parse path can use them without importing this file.
export {
  mimeTypeFor,
  normalizeMimeType,
  normalizeMimeTypeWithWarning,
  resolveMimeType,
  sniffMimeFromBytes,
  type MimeNormalizationResult,
} from "./mime";
import type { QueuedJob } from "../queue/provider";
import { TerminalError } from "../queue/worker";
import {
  emitWebhookEvent,
  enqueueWebhookDeliveries,
  prepareWebhookEvent,
  type PreparedWebhookEvent,
} from "../webhooks/emit";
import { createNotification } from "../notifications/emit";
import {
  resolveExtractEndpoint,
  type ExtractEndpointPayload,
} from "../extract/resolve-endpoint";
import { createProvider, extractFields } from "../extract";
import { formExtractToResult } from "../extract/form-extract";
import { matchFormMapping } from "../extract/form-match";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { checkLegibility, isBadScan, DEFAULT_LEGIBILITY_THRESHOLD } from "../parse/legibility";
import { visionOcrPages } from "../parse/vision-ocr";
import {
  computeFieldConfidences,
  aggregateDocConfidence,
  findLowestField,
} from "../extract/field-confidence";
import { isTransientError } from "./errors";
import type { BillingAdapter } from "../billing/adapter";
import { NoOpBillingAdapter } from "../billing/noop";

export interface IngestionHandlerConfig {
  // No config needed — extraction runs in-process via extractFields().
}

let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;
// The ParseConfig the default provider was built from. Captured at init so the
// ingestion path can rebuild a per-tenant provider at call time (BYO parse).
// When absent (e.g. an edge entry point that only hands us a pre-built
// provider), per-call resolution is disabled and the default singleton is used
// — identical to today.
let _parseConfig: ParseConfig | null = null;
let _billing: BillingAdapter = new NoOpBillingAdapter();

export function initIngestionHandler(
  db: Db,
  storage: StorageProvider,
  _config?: IngestionHandlerConfig,
) {
  _db = db;
  _storage = storage;
}

export function initBilling(adapter: BillingAdapter) {
  _billing = adapter;
}

/**
 * Install the ParseProvider the motor should use for live parses.
 * Must be called before the first `handleIngestionProcess` invocation —
 * there's no longer a fallback since the factory requires explicit config.
 *
 * `config` is the {@link ParseConfig} the default provider was built from. When
 * supplied, the ingestion path can rebuild a per-tenant provider at call time
 * (BYO parse — `tenantHeavy` / `tenantStructured`). When omitted, per-call
 * resolution is disabled and `provider` is used for every tenant, unchanged.
 */
export function initParseProvider(provider: ParseProvider, config?: ParseConfig) {
  _parseProvider = provider;
  _parseConfig = config ?? null;
}

/** Get the current parse provider (for step-based flows that need direct access). */
export function getParseProvider(): ParseProvider | null {
  return _parseProvider;
}

/**
 * Read a pipeline's pinned parse endpoint id from its `config_json`, if any.
 * Mirrors how the legibility config is read from `config_json` — opt-in,
 * defaults to null (no pin → resolve the tenant's active parse endpoint).
 *
 * Stored under `config_json.parse_provider_id` (the Parse Catalog UI's pipeline
 * "Override parse engine" writes here; PB-9). Kept in config_json rather than a
 * dedicated column so this lands without a migration and without colliding with
 * the in-flight Parse Catalog work.
 */
export function readParseProviderPin(configJson: unknown): string | null {
  const root =
    configJson && typeof configJson === "object" ? (configJson as Record<string, unknown>) : null;
  const pin = root?.parse_provider_id;
  return typeof pin === "string" && pin.length > 0 ? pin : null;
}

/**
 * Build the ParseProvider to use for one document, given the tenant's resolved
 * parse provider (or null when none is configured / no driver exists).
 *
 * Dormant-until-configured: when `resolved` is null — every tenant today, since
 * the driver registry is empty — this returns the **exact same** default
 * provider instance, so behaviour is byte-for-byte identical to pre-BYO-parse.
 * It also returns the default when `parseConfig` is absent (no way to rebuild
 * the SmartParse/Chunked wrapper around a tenant provider).
 *
 * When a provider resolves, it fills the matching factory slot: `markdown`
 * providers replace the default heavy (text path); `structured` providers
 * enable PB-10 doc-type routing for table-heavy docs while the default heavy
 * still serves text-heavy docs.
 *
 * Exported for unit testing the dormant guarantee + slot selection without a DB.
 */
export async function buildEffectiveParseProvider(
  parseConfig: ParseConfig | null,
  defaultProvider: ParseProvider,
  resolved: ResolvedTenantParse | null,
): Promise<ParseProvider> {
  if (!resolved || !parseConfig) return defaultProvider;
  const opts: ParseProviderOptions =
    resolved.kind === "structured"
      ? { tenantStructured: resolved.provider }
      : { tenantHeavy: resolved.provider };
  return createParseProvider(parseConfig, opts);
}

interface IngestionProcessPayload {
  documentId: string;
  /** Force a fresh parse, bypassing + refreshing the parse cache (rerun --no-cache). */
  skipCache?: boolean;
}

export async function handleIngestionProcess(job: QueuedJob): Promise<void> {
  if (!_db || !_storage) {
    throw new Error("Ingestion handler not initialized");
  }
  if (!_parseProvider) {
    throw new Error("Parse provider not initialized — call initParseProvider()");
  }
  const db = _db;
  const storage = _storage;
  const defaultParseProvider = _parseProvider;
  // The effective parse provider is resolved per-tenant below, once we know the
  // pipeline (its optional pinned parse endpoint lives in config_json).
  // extractFields() runs in-process — no external URL needed

  const { documentId, skipCache } = job.payload as unknown as IngestionProcessPayload;
  const tenantId = job.tenantId;

  // ── Resolve document → job → pipeline → schema version in one query ───────
  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        document: {
          id: schema.documents.id,
          status: schema.documents.status,
          storageKey: schema.documents.storageKey,
          filename: schema.documents.filename,
          mimeType: schema.documents.mimeType,
          contentHash: schema.documents.contentHash,
          ingestionId: schema.documents.ingestionId,
        },
        job: {
          id: schema.jobs.id,
          slug: schema.jobs.slug,
        },
        pipeline: {
          id: schema.pipelines.id,
          slug: schema.pipelines.slug,
          reviewThreshold: schema.pipelines.reviewThreshold,
          schemaId: schema.pipelines.schemaId,
          activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
          modelProviderId: schema.pipelines.modelProviderId,
          configJson: schema.pipelines.configJson,
        },
        schemaVersion: {
          id: schema.schemaVersions.id,
          versionNumber: schema.schemaVersions.versionNumber,
          yamlSource: schema.schemaVersions.yamlSource,
        },
      })
      .from(schema.documents)
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.pipelines.activeSchemaVersionId),
      )
      .where(eq(schema.documents.id, documentId))
      .limit(1),
  );

  if (!row) {
    throw new TerminalError(`Document ${documentId} not found`);
  }

  const { document, job: docJob, pipeline, schemaVersion } = row;

  // Idempotency: if we've already processed it, don't double-process.
  //
  // This guard doubles as the safety net for transient-error retries: the
  // catch block below throws raw (no markDocFailed) on transient failures
  // so the doc stays in `extracting` and the queue re-invokes this handler
  // from the top. We re-run from a clean slate. If an earlier attempt
  // happened to succeed (e.g. the worker died *after* we moved the doc to
  // `delivered` but before acking the job), this guard sees the post-
  // processing status and short-circuits.
  if (document.status !== "extracting") {
    console.log(
      `[ingestion.process] document ${documentId} status=${document.status}, skipping`,
    );
    return;
  }

  if (!docJob) {
    throw new TerminalError("Document is not attached to a job");
  }
  const jobId = docJob.id;
  const jobSlug = docJob.slug;

  if (!pipeline) {
    await markDocFailed(db, tenantId, documentId, jobId, "Job's pipeline was deleted");
    if (document.ingestionId) {
      await failIngestion(db, tenantId, document.ingestionId, "Pipeline deleted");
    }
    throw new TerminalError("Pipeline not found for job");
  }

  if (!schemaVersion || !pipeline.schemaId || !pipeline.activeSchemaVersionId) {
    const reason = "Pipeline has no deployed schema version — deploy one first";
    await markDocFailed(db, tenantId, documentId, jobId, reason);
    if (document.ingestionId) {
      await failIngestion(db, tenantId, document.ingestionId, reason);
    }
    throw new TerminalError(reason);
  }

  // ── Resolve the tenant's parse provider (BYO parse) via the shared seam ──
  // Honors a pipeline-pinned parse endpoint (config_json.parse_provider_id),
  // else the tenant's active parse endpoint; hands back the default provider
  // unchanged when none is configured (dormant-until-configured). One resolver
  // for every surface (oss-310) — no per-entrypoint copy to drift. The provider-
  // aware fingerprint keys the parse cache so a provider switch re-parses (oss-298).
  const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
    db,
    tenantId,
    {
      parseProviderId: readParseProviderPin(pipeline.configJson),
      defaultProvider: defaultParseProvider,
      parseConfig: _parseConfig,
    },
  );

  // ── Resolve markdown via parse_cache, falling back to live parse ─────────
  //
  // Each step below records a trace_stages row so the trace view can show
  // the real timeline instead of "No trace stages recorded". On failure we
  // still flush the stages we got to — the trace is more useful with a
  // partial-but-honest timeline than with nothing.
  const recorder = new TraceRecorder();
  const extractStart = Date.now();
  await recorder.init(db, tenantId, documentId, jobId, extractStart);

  let extractResult: ExtractResult;
  try {
    const parseOutput = await recorder.run(
      "parse",
      async () => {
        const result = await parseDocument({
          db,
          storage,
          tenantId,
          document,
          provider: parseProvider,
          fingerprint: parseFingerprint,
          skipCache,
        });
        const summary: Record<string, unknown> = {
          markdown_chars: result.markdown.length,
        };
        if (result.engine) summary.engine = result.engine;
        return { value: result, summary };
      },
    );
    let markdown = parseOutput.markdown;
    // Nested provenance text_map (bbox highlights), shaped once by the seam so
    // ingestion matches build/validate. Passing the raw flat map here previously
    // yielded NO text_map highlights — provenance reads seg.bbox, which the flat
    // shape lacks (oss-310). Mutable: cleared on a vision-OCR re-parse below.
    let textMap = parseOutput.textMap;
    // Provenance-carrying chunks from a structured/positional parse (PB-11).
    // Mutable: a vision-OCR escalation replaces the markdown with a
    // markdown-native re-parse, so any positional chunks become stale.
    let chunks = parseOutput.chunks;

    // ── Legibility check + bad-scan escalation (opt-in) ──────────────────
    // When enabled on the pipeline, judge whether the parsed text is coherent
    // or garbled by a bad scan (low-res / skewed / noisy). When it's a bad scan
    // AND a vision-capable fallback model is configured, re-parse the pages with
    // that model — a vision LLM reads faded/skewed scans far better than OCR.
    const legibilityCfg = readLegibilityConfig(pipeline.configJson);
    if (legibilityCfg.enabled) {
      const verdict = await recorder.run("legibility", async () => {
        const { provider } = await resolveTenantProvider(db, tenantId);
        const v = await checkLegibility(markdown, provider);
        const badScan = isBadScan(v, legibilityCfg.threshold);
        if (badScan) {
          console.warn(
            `[ingestion] bad scan detected for ${documentId} ` +
            `(legible=${v.legible}, confidence=${v.confidence})`,
          );
        }
        return {
          value: v,
          summary: {
            legible: v.legible,
            confidence: v.confidence,
            bad_scan: badScan,
            threshold: legibilityCfg.threshold,
            ...(v.reason ? { reason: v.reason } : {}),
          },
        };
      });

      // Escalate a bad scan to the configured vision parse model.
      if (isBadScan(verdict, legibilityCfg.threshold) && legibilityCfg.fallbackModelId) {
        try {
          const escalated = await recorder.run("parse_escalation", async () => {
            if (!parseProvider.pageImages) {
              throw new Error("parse provider does not support page images");
            }
            const { provider: visionProvider, model: visionModel } = await resolveTenantProvider(
              db,
              tenantId,
              { modelProviderId: legibilityCfg.fallbackModelId },
            );
            const blob = await storage.getBuffer(document.storageKey);
            if (!blob) throw new Error("file not found in storage for escalation");
            const mimeType = document.mimeType || mimeTypeFor(document.filename);
            const { images } = await parseProvider.pageImages({
              fileBuffer: blob.data,
              filename: document.filename,
              mimeType,
              maxPages: 50,
            });
            const result = await visionOcrPages(images, visionProvider);
            console.log(`[ingestion] vision-OCR escalation: ${documentId} re-parsed ${result.pages} pages via ${visionModel}`);
            return {
              value: result,
              summary: {
                engine: "vision-ocr",
                model: visionModel,
                pages: result.pages,
                markdown_chars: result.markdown.length,
              },
            };
          });

          if (escalated.markdown.trim().length > 0) {
            markdown = escalated.markdown;
            // Vision-OCR is markdown-native and re-flows the text: drop the
            // stale positional chunks AND text_map (their offsets/boxes no
            // longer match the re-parsed markdown).
            chunks = undefined;
            textMap = undefined;
            // Re-cache the vision text so a reprocess of this file doesn't
            // re-escalate (and re-pay the per-page vision cost).
            await overwriteParseCache(storage, tenantId, document.contentHash, markdown, escalated.pages);
          }
        } catch (err) {
          console.warn(
            `[ingestion] parse escalation failed for ${documentId}, keeping original parse:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // ── Form-mapping early exit ──────────────────────────────────────────
    // Check if this document matches an active form mapping. If so, use
    // coordinate extraction (+ optional LLM interpret) instead of the
    // full parse → LLM pipeline. Sub-second, zero LLM cost for mapped fields.
    const formMatch = pipeline.schemaId
      ? await matchFormMapping(db, tenantId, markdown.slice(0, 3000), pipeline.schemaId)
      : null;

    if (formMatch && parseProvider.extractCoordinates) {
      extractResult = await recorder.run(
        "extract",
        async () => {
          console.log(
            `[ingestion] form match: ${formMatch.slug} (score=${formMatch.score.toFixed(2)}) — using coordinate extraction`,
          );
          const blob = await storage.getBuffer(document.storageKey);
          if (!blob) throw new Error("File not found in storage for coordinate extraction");

          const coordResult = await parseProvider.extractCoordinates!({
            fileBuffer: blob.data,
            mappings: formMatch.mappingsJson as Record<string, { page: number; x: number; y: number; w: number; h: number }>,
          });

          // Handle LLM interpret regions
          const llmRegions = Object.entries(formMatch.mappingsJson).filter(
            ([, m]: [string, any]) => m.mapping_type === "llm_interpret",
          );
          if (llmRegions.length > 0) {
            const { provider } = await resolveTenantProvider(db, tenantId);
            const schemaDef = parseYaml(schemaVersion.yamlSource) as Record<string, unknown>;
            const schemaFields = ((schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>);

            for (const [regionKey, mapping] of llmRegions as [string, any][]) {
              const rawText = coordResult.extracted[regionKey]?.value;
              if (!rawText) continue;
              const targetFields: string[] = mapping.target_fields ?? [];
              if (targetFields.length === 0) continue;

              const fieldDescriptions = targetFields.map((f: string) => {
                const spec = schemaFields[f];
                const parts = [`  "${f}"`];
                if (spec?.type) parts.push(`(type: ${spec.type})`);
                if (spec?.extraction_guidance) parts.push(`— ${spec.extraction_guidance}`);
                if (spec?.required) parts.push("[required]");
                return parts.join(" ");
              }).join("\n");

              const prompt = `You are extracting structured data from a region of a PDF form.\n\nThe raw text from this region:\n"""\n${rawText}\n"""\n\nExtract values for these fields:\n${fieldDescriptions}\n\n${mapping.llm_prompt ? `Additional instructions: ${mapping.llm_prompt}\n` : ""}Return a JSON object with exactly these keys: ${JSON.stringify(targetFields)}\nEach value should be a string, number, or null if not found. Return ONLY valid JSON, no explanation.`;

              try {
                const llmResponse = await provider.generate(prompt, true);
                const parsed = JSON.parse(llmResponse);
                for (const tf of targetFields) {
                  if (parsed[tf] !== undefined) {
                    coordResult.extracted[tf] = { value: parsed[tf], page: coordResult.extracted[regionKey]?.page };
                  }
                }
              } catch {
                for (const tf of targetFields) {
                  coordResult.extracted[tf] = { value: null, error: "LLM interpretation failed" };
                }
              }
              delete coordResult.extracted[regionKey];
            }
          }

          let schemaDef: Record<string, unknown>;
          try {
            schemaDef = parseYaml(schemaVersion.yamlSource) as Record<string, unknown>;
          } catch (err) {
            throw new TerminalError(`Invalid schema YAML: ${err instanceof Error ? err.message : "yaml parse"}`);
          }
          const formResult = formExtractToResult(coordResult.extracted, schemaDef);

          // Check for unmapped fields — run LLM extraction to backfill them
          const schemaFields = Object.keys((schemaDef.fields ?? {}) as Record<string, unknown>);
          const nullFields = schemaFields.filter((f) => formResult.extracted[f] == null);

          if (nullFields.length > 0 && markdown) {
            console.log(
              `[ingestion] form-mapping: ${nullFields.length} unmapped fields, backfilling with LLM`,
            );
            try {
              const { provider, model: modelStr } = await resolveTenantProvider(db, tenantId, {
                modelProviderId: pipeline.modelProviderId,
              });
              const llmResult = await extractFields(markdown, schemaDef, provider, modelStr, textMap, chunks);

              // Merge: form extraction wins for mapped fields, LLM fills the rest
              for (const field of nullFields) {
                const llmValue = (llmResult.extracted as Record<string, unknown>)?.[field];
                if (llmValue != null) {
                  formResult.extracted[field] = llmValue;
                  formResult.confidence_scores[field] = llmResult.confidence_scores?.[field] ?? 0.8;
                  formResult.confidence[field] = llmResult.confidence?.[field] ?? "medium";
                  if (formResult.provenance && llmResult.provenance?.[field]) {
                    formResult.provenance[field] = llmResult.provenance[field];
                  }
                }
              }
              formResult.strategy = "form-mapping+llm";
              formResult.model = `coordinates+${modelStr}`;
            } catch (err) {
              console.warn("[ingestion] LLM backfill failed, returning form-only results:", err);
            }
          }

          return {
            value: formResult as unknown as ExtractResult,
            summary: {
              model: formResult.model ?? "coordinates",
              strategy: formResult.strategy ?? "form-mapping",
              form: formMatch.slug,
              fields: Object.keys(formResult.extracted).length,
            },
          };
        },
      );
    } else {
      // ── Standard LLM extraction ───────────────────────────────────────
      const endpointPayload = await resolveExtractEndpoint(
        db,
        tenantId,
        pipeline.modelProviderId,
      );
      extractResult = await recorder.run(
        "extract",
        async () => {
          let schemaDef: Record<string, unknown>;
          try {
            schemaDef = parseYaml(schemaVersion.yamlSource) as Record<string, unknown>;
          } catch (err) {
            throw new TerminalError(`Invalid schema YAML: ${err instanceof Error ? err.message : "yaml parse"}`);
          }
          const modelStr = endpointPayload?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
          const provider = createProvider(modelStr, endpointPayload);
          const res = await extractFields(markdown, schemaDef, provider, modelStr, textMap, chunks);
          return {
            value: res as unknown as ExtractResult,
            summary: {
              model: res.model ?? "unknown",
              fields: Object.keys(
                (res.extracted ?? {}) as Record<string, unknown>,
              ).length,
              tokens: res.elapsed_ms ?? null,
            },
          };
        },
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Transient failures (5xx from parse/extract, connection errors, timeouts,
    // model-provider 429s) get handed back to the queue worker for retry.
    // The queue supports up to `maxRetries` (default 12) attempts with
    // exponential backoff + jitter — we don't need to re-implement that here.
    //
    // Invariant: we deliberately do NOT markDocFailed / failIngestion / flush
    // a failed trace on the transient path. That keeps `documents.status`
    // in `extracting`, which is exactly what the idempotency guard at the top
    // of this handler expects on re-invocation: if status is still
    // `extracting` we re-run cleanly; if a prior attempt succeeded and moved
    // the doc to `delivered`/`review`, we short-circuit and ack. Either way
    // the retry is safe.
    //
    // Terminal failures exhaust retries the slow way (via the queue's
    // max-retry counter) but we also reach this branch directly for known-
    // terminal conditions: malformed schema YAML, 4xx errors from the
    // internal services, anything `isTransientError` doesn't recognise.
    if (isTransientError(err) && job.attempt < job.maxAttempts) {
      console.warn(
        `[ingestion.process] transient failure for ${documentId} (attempt ${job.attempt}/${job.maxAttempts}), will retry: ${msg}`,
      );
      throw err;
    }

    // Terminal failure: log the full error + stack server-side so parse/extract
    // crashes are diagnosable (the doc only ends up with a short `msg`).
    const te = err as { stack?: string; status?: number; detail?: string };
    console.error(
      `[ingestion.process] terminal failure for ${documentId}:`,
      msg,
      "| status:", te?.status ?? "n/a",
      "| detail:", te?.detail ?? "n/a",
      "\n", te?.stack ?? "(no stack)",
    );
    await markDocFailed(db, tenantId, documentId, jobId, `Extraction failed: ${msg}`);
    // Best-effort: persist the partial trace so users can see exactly where
    // the run died. Swallow errors here — extraction failure is the thing
    // that matters.
    await recorder.flush(db, tenantId, documentId, jobId, extractStart, "failed").catch(() => {});
    // Mark the ingestion failed too so re-posts the same file surface an
    // actionable error instead of silently short-circuiting on the idempotency
    // check. Re-ingestion (a fresh POST) is the intended retry path.
    if (document.ingestionId) {
      await failIngestion(db, tenantId, document.ingestionId, msg);
    }
    throw new TerminalError(`Extraction failed: ${msg}`);
  }
  const extractDurationMs = Date.now() - extractStart;

  // ── Confidence gate (recorded as the 'validate' stage) ──────────────────
  //
  // Per-field confidence is computed deterministically from the schema +
  // extracted value (and provenance, for free-text strings). We do NOT use
  // the LLM's self-emitted __confidence — it's conservatively calibrated
  // noise that flagged unambiguous correct extractions against the default
  // 0.85 review threshold. See extract/field-confidence.ts for the per-
  // type scoring matrix.
  //
  // Doc-level confidence = min(per-field scores). Strict aggregation: the
  // document is only as confident as its weakest field. Routing logic
  // collapses to "any field below threshold => review".
  const validateStart = Date.now();
  const extractedValues = (extractResult.extracted ?? {}) as Record<string, unknown>;
  let validateSchemaDef: Record<string, unknown> | undefined;
  try {
    validateSchemaDef = parseYaml(schemaVersion.yamlSource) as Record<string, unknown>;
  } catch {
    // Schema YAML already validated upstream during extraction. If it
    // somehow fails to parse here, fall through with no schema — the
    // confidence map will be empty and routing skips automatically.
    validateSchemaDef = undefined;
  }
  const provenanceByField = (extractResult.provenance ?? undefined) as
    | Record<string, import("../extract/provenance").ProvenanceSpan | null>
    | undefined;
  const fieldScores = computeFieldConfidences(
    validateSchemaDef,
    extractedValues,
    provenanceByField,
  );
  const confidence = aggregateDocConfidence(fieldScores);
  const threshold = Number(pipeline.reviewThreshold);
  const lowField = Number.isFinite(threshold)
    ? findLowestField(fieldScores, threshold)
    : null;

  const routeToReview = lowField !== null;

  recorder.record("validate", Date.now() - validateStart, routeToReview ? "warn" : "ok", {
    threshold,
    doc_confidence: confidence,
    route_to_review: routeToReview,
    ...(lowField ? { low_field: lowField.name, low_confidence: lowField.confidence } : {}),
  });

  const now = new Date();
  const docConfidence = confidence === null ? null : confidence.toFixed(4);
  const docExtraction = extractResult.extracted ?? null;

  // Webhook event prepared (but not enqueued) below — we write the Deliver
  // trace stage first and only enqueue delivery jobs after the trace is
  // flushed, so the worker never races `advanceDeliverStage` against a
  // stage row that hasn't been written yet.
  let prepared: PreparedWebhookEvent | null = null;

  if (routeToReview) {
    // Insert review item. Prefer the worst-field details; fall back to doc-level.
    const reviewField = lowField?.name ?? firstFieldName(fieldScores) ?? "document";
    const reviewConfidence = (lowField?.confidence ?? confidence ?? 0).toFixed(4);
    const proposedValue = lowField?.name
      ? ((docExtraction as Record<string, unknown>)?.[lowField.name] ?? null)
      : docExtraction;

    await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.reviewItems).values({
        tenantId,
        documentId,
        schemaId: pipeline.schemaId!,
        fieldName: reviewField,
        reason: "low_confidence",
        proposedValue,
        confidence: reviewConfidence,
        status: "pending",
      }),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.documents)
        .set({
          status: "review",
          extractionJson: docExtraction,
          confidenceScoresJson: fieldScores,
          provenanceJson: extractResult.provenance ?? null,
          fitJson: extractResult.fit ?? null,
          confidence: docConfidence,
          durationMs: extractDurationMs,
          completedAt: now,
        })
        .where(eq(schema.documents.id, documentId)),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({
          docsProcessed: sql`${schema.jobs.docsProcessed} + 1`,
          docsReviewing: sql`${schema.jobs.docsReviewing} + 1`,
          completedAt: now, // single-doc jobs complete immediately
          status: "complete",
        })
        .where(eq(schema.jobs.id, jobId)),
    );

    prepared = await prepareWebhookEvent(tenantId, "document.review_requested", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipeline.id,
      field: reviewField,
      confidence: reviewConfidence,
      threshold,
    });
    recorder.recordDeliverStage(prepared);

    createNotification(tenantId, {
      type: "document.review_requested",
      title: "Document needs review",
      body: `Low confidence on ${reviewField} (${(reviewConfidence * 100).toFixed(0)}%)`,
      data: { documentId, jobId, field: reviewField, confidence: reviewConfidence },
    });
  } else {
    // Delivered
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.documents)
        .set({
          status: "delivered",
          extractionJson: docExtraction,
          confidenceScoresJson: fieldScores,
          provenanceJson: extractResult.provenance ?? null,
          fitJson: extractResult.fit ?? null,
          confidence: docConfidence,
          durationMs: extractDurationMs,
          completedAt: now,
          emittedAt: now,
        })
        .where(eq(schema.documents.id, documentId)),
    );

    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({
          docsProcessed: sql`${schema.jobs.docsProcessed} + 1`,
          docsPassed: sql`${schema.jobs.docsPassed} + 1`,
          completedAt: now,
          status: "complete",
        })
        .where(eq(schema.jobs.id, jobId)),
    );

    prepared = await prepareWebhookEvent(tenantId, "document.delivered", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipeline.id,
      extraction: docExtraction,
      confidence: docConfidence,
    });
    recorder.recordDeliverStage(prepared);
  }

  // Close out the ingestion (if any) + pipeline last-run timestamp
  if (document.ingestionId) {
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.ingestions)
        .set({ status: "complete", completedAt: now })
        .where(eq(schema.ingestions.id, document.ingestionId!)),
    );
  }

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({ lastRunAt: now })
      .where(eq(schema.pipelines.id, pipeline.id)),
  );

  // Flush the trace + stages so the trace view has a real timeline. Best
  // effort — a trace-write failure shouldn't un-do the successful delivery.
  const flushed = await recorder
    .flush(db, tenantId, documentId, jobId, extractStart, routeToReview ? "review" : "ok")
    .catch((err) => {
      console.warn(
        "[ingestion.process] trace flush failed:",
        err instanceof Error ? err.message : err,
      );
      return false as const;
    });

  // Enqueue webhook deliveries AFTER the trace (and its Deliver stage row)
  // is in place. If the flush failed we still emit — the webhook contract
  // trumps the trace visibility nicety; the worker's advanceDeliverStage
  // tolerates a missing row.
  if (prepared) {
    if (flushed === false) {
      console.warn(
        "[ingestion.process] emitting webhook without Deliver trace stage —",
        "advanceDeliverStage will no-op for event",
        prepared.eventId,
      );
    }
    await enqueueWebhookDeliveries(tenantId, prepared, { documentId });
  }

  // Record billable event for the terminal transition (best-effort —
  // a billing write failure shouldn't un-do the successful delivery).
  await _billing
    .recordBillableEvent(tenantId, {
      kind: "document_processed",
      documentId,
      jobId,
      pipelineId: pipeline.id,
      schemaVersionId: schemaVersion?.id,
      disposition: "billable",
      terminalState: routeToReview ? "review" : "delivered",
    })
    .catch((err) => {
      console.warn(
        "[ingestion.process] billing event write failed:",
        err instanceof Error ? err.message : err,
      );
    });
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers used by routes too: create the job + document up front, enqueue work

export interface CreateExtractionJobArgs {
  db: Db;
  tenantId: string;
  pipelineId: string;
  schemaId: string;
  schemaVersionId: string;
  triggerType: string;
  storageKey: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  contentHash: string;
  ingestionId?: string;
  groupKey?: string | null;
}

export interface CreatedExtractionJob {
  jobId: string;
  jobSlug: string;
  documentId: string;
}

/**
 * Synchronously create the jobs + documents row pair for a single-document
 * extraction. Both the webhook route and the manual-run route call this so
 * the worker handler only has to load + execute, not construct.
 */
export async function createExtractionJob(
  args: CreateExtractionJobArgs,
): Promise<CreatedExtractionJob> {
  const jobSlug = makeJobSlug();

  const [createdJob] = await withRLS(args.db, args.tenantId, (tx) =>
    tx
      .insert(schema.jobs)
      .values({
        tenantId: args.tenantId,
        slug: jobSlug,
        pipelineId: args.pipelineId,
        triggerType: args.triggerType,
        status: "running",
        docsTotal: 1,
        docsProcessed: 0,
        docsPassed: 0,
        docsFailed: 0,
        docsReviewing: 0,
        startedAt: new Date(),
      })
      .returning({ id: schema.jobs.id, slug: schema.jobs.slug }),
  );

  const jobId = createdJob!.id;

  const [createdDoc] = await withRLS(args.db, args.tenantId, (tx) =>
    tx
      .insert(schema.documents)
      .values({
        tenantId: args.tenantId,
        jobId,
        ingestionId: args.ingestionId ?? null,
        filename: args.filename,
        storageKey: args.storageKey,
        fileSize: args.fileSize,
        mimeType: args.mimeType,
        contentHash: args.contentHash,
        schemaId: args.schemaId,
        schemaVersionId: args.schemaVersionId,
        groupKey: args.groupKey ?? null,
        status: "extracting",
        startedAt: new Date(),
      })
      .returning({ id: schema.documents.id }),
  );

  return { jobId, jobSlug, documentId: createdDoc!.id };
}

/**
 * Add a document to an existing job. Used for batch uploads where
 * multiple files should be grouped under a single job.
 */
export async function addDocumentToJob(
  args: Omit<CreateExtractionJobArgs, "triggerType"> & { jobId: string },
): Promise<{ documentId: string }> {
  const [createdDoc] = await withRLS(args.db, args.tenantId, (tx) =>
    tx
      .insert(schema.documents)
      .values({
        tenantId: args.tenantId,
        jobId: args.jobId,
        ingestionId: args.ingestionId ?? null,
        filename: args.filename,
        storageKey: args.storageKey,
        fileSize: args.fileSize,
        mimeType: args.mimeType,
        contentHash: args.contentHash,
        schemaId: args.schemaId,
        schemaVersionId: args.schemaVersionId,
        status: "extracting",
        startedAt: new Date(),
      })
      .returning({ id: schema.documents.id }),
  );

  // Increment docsTotal on the job
  await withRLS(args.db, args.tenantId, (tx) =>
    tx
      .update(schema.jobs)
      .set({ docsTotal: sql`docs_total + 1` })
      .where(eq(schema.jobs.id, args.jobId)),
  );

  return { documentId: createdDoc!.id };
}

// ───────────────────────────────────────────────────────────────────────────

interface ExtractResult {
  extracted: unknown;
  confidence: number | null | undefined;
  confidence_scores?: Record<string, number>;
  model?: string;
  elapsed_ms?: number;
  provenance?: Record<string, unknown> | null;
  /** Document-fit verdict (FitReport) when the schema declares a `fit` block. */
  fit?: unknown;
}

/**
 * Read the legibility-check config from a pipeline's `configJson.legibility`
 * block: `{ enabled?: boolean, threshold?: number, fallback_model_id?: string }`.
 * Opt-in (default off) so normal parses don't pay for the extra LLM call.
 * `fallback_model_id` points at a vision-capable model_endpoint; when a bad scan
 * is detected and it's set, ingestion re-parses with that model.
 */
function readLegibilityConfig(configJson: unknown): {
  enabled: boolean;
  threshold: number;
  fallbackModelId: string | null;
} {
  const root = configJson && typeof configJson === "object" ? (configJson as Record<string, unknown>) : null;
  const cfg = root && typeof root.legibility === "object" ? (root.legibility as Record<string, unknown>) : null;
  const enabled = cfg?.enabled === true;
  const threshold =
    typeof cfg?.threshold === "number" && cfg.threshold >= 0 && cfg.threshold <= 1
      ? cfg.threshold
      : DEFAULT_LEGIBILITY_THRESHOLD;
  const fallbackModelId =
    typeof cfg?.fallback_model_id === "string" && cfg.fallback_model_id.length > 0
      ? cfg.fallback_model_id
      : null;
  return { enabled, threshold, fallbackModelId };
}

/**
 * Overwrite the parse-cache S3 object for a file with new markdown (used after a
 * bad-scan vision-OCR escalation, so a reprocess reuses the better text instead
 * of re-escalating). Best-effort. The DB cache row already exists from the
 * original parse; only the S3 payload changes. No text_map — vision-OCR doesn't
 * produce per-word bboxes — so escalated docs lose provenance highlighting,
 * which is an acceptable trade for legible text.
 */
async function overwriteParseCache(
  storage: StorageProvider,
  tenantId: string,
  fileHash: string,
  markdown: string,
  pages: number,
): Promise<void> {
  if (!fileHash) return;
  try {
    const cacheKey = `cache/${tenantId}/${fileHash}.json`;
    const payload = Buffer.from(
      JSON.stringify({
        markdown,
        pages,
        ocr_skipped: false,
        engine: "vision-ocr",
        text_map: [],
        parser_version: PARSE_VERSION,
      }),
    );
    await storage.put(cacheKey, payload, { contentType: "application/json" });
  } catch (err) {
    console.warn("[ingestion] failed to re-cache escalated parse:", err instanceof Error ? err.message : err);
  }
}

/**
 * Look up the markdown for this document, hitting parse_cache first and
 * falling back to a live parse on miss. The cache write happens
 * best-effort — a write failure shouldn't fail the extraction. Mirrors the
 * pattern in routes/extract.ts (handleExtractRunJSON) so build mode and
 * the worker share the same cache entries by (tenantId, fileHash,
 * providerFingerprint).
 *
 * The `parseFingerprint` identifies the resolved parse provider — switching or
 * editing a parse provider yields a new fingerprint, so the lookup misses and
 * re-parses instead of returning the previous provider's stale markdown
 * (oss-298). `opts.skipCache` forces a fresh parse (bypass lookup, overwrite
 * the cache) for iterative testing.
 *
 * For large digital PDFs this turns repeat runs from minutes into milliseconds.
 */
export async function getOrParse(
  db: Db,
  storage: StorageProvider,
  parseProvider: ParseProvider,
  tenantId: string,
  document: {
    id: string;
    storageKey: string;
    filename: string;
    mimeType: string | null;
    contentHash: string;
  },
  parseFingerprint: string = DEFAULT_PARSE_FINGERPRINT,
  opts?: { skipCache?: boolean },
): Promise<{ markdown: string; textMap?: any[]; engine?: string; chunks?: ParseChunk[]; pages?: number; ocr_skipped?: boolean; cached?: boolean }> {
  const fileHash = document.contentHash;
  const skipCache = opts?.skipCache ?? false;

  // 1. Cache lookup (provider-aware; skipped on force re-parse)
  if (fileHash && !skipCache) {
    const [cached] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ storageKey: schema.parseCache.storageKey })
        .from(schema.parseCache)
        .where(
          and(
            eq(schema.parseCache.tenantId, tenantId),
            eq(schema.parseCache.fileHash, fileHash),
            eq(schema.parseCache.providerFingerprint, parseFingerprint),
          ),
        )
        .limit(1),
    );

    if (cached) {
      const cacheBlob = await storage.getBuffer(cached.storageKey);
      if (cacheBlob) {
        try {
          const payload = JSON.parse(cacheBlob.data.toString()) as {
            markdown?: string;
            text_map?: any[];
            engine?: string;
            chunks?: ParseChunk[];
            pages?: number;
            ocr_skipped?: boolean;
            parser_version?: number;
          };
          // Stale parser version → treat as a miss and re-parse (the live-parse
          // path below overwrites the cache with the current version). Lets a
          // parse-code change (PARSE_VERSION bump) apply to already-cached docs.
          if (payload.markdown && isParseCacheFresh(payload)) {
            console.log(`[ingestion.process] parse cache hit for ${fileHash.slice(0, 12)}…`);
            // Note: searchable-PDF cache copy is owned by the platform's
            // OCR overlay Inngest function — it checks the cache and copies
            // to the per-doc storage key as its first step. Doing it again
            // here would race for no benefit.
            return { markdown: payload.markdown, textMap: payload.text_map, engine: payload.engine, chunks: payload.chunks, pages: payload.pages, ocr_skipped: payload.ocr_skipped, cached: true };
          }
        } catch {
          // Corrupt cache entry — fall through to live parse and overwrite.
        }
      }
    }
  }

  // 2. Live parse
  const blob = await storage.getBuffer(document.storageKey);
  if (!blob) throw new Error("File not found in storage");

  const mimeType = document.mimeType || mimeTypeFor(document.filename);
  const liveStart = Date.now();
  const parseResult = await parseProvider.parse({
    filename: document.filename,
    mimeType,
    fileBuffer: blob.data,
  });
  const parseElapsedMs = Date.now() - liveStart;

  // Searchable-PDF generation is no longer done inline by the parse service.
  // Hosted deployments produce searchable PDFs asynchronously via the
  // OCRmyPDF Modal job (see platform/services/ocr-overlay-modal/) which writes
  // directly to `{storageKey}.searchable.pdf`. OSS deployments no longer
  // generate them at all — the previous rough pytesseract overlay was deleted
  // along with its consumers in oss-224.

  // 3. Cache write (best-effort, provider-aware key). Upsert so a forced
  //    re-parse refreshes an existing entry rather than no-op'ing.
  if (fileHash) {
    const cacheKey = parseCacheStorageKey(tenantId, fileHash, parseFingerprint);
    const cachePayload = Buffer.from(
      JSON.stringify({
        markdown: parseResult.markdown,
        pages: parseResult.pages,
        ocr_skipped: parseResult.ocr_skipped,
        engine: parseResult.engine,
        text_map: parseResult.text_map ?? [],
        ...(parseResult.chunks ? { chunks: parseResult.chunks } : {}),
        parser_version: PARSE_VERSION,
      }),
    );
    try {
      await storage.put(cacheKey, cachePayload, { contentType: "application/json" });
      await withRLS(db, tenantId, (tx) =>
        tx
          .insert(schema.parseCache)
          .values({
            tenantId,
            fileHash,
            providerFingerprint: parseFingerprint,
            storageKey: cacheKey,
            pages: parseResult.pages ?? 0,
            ocrSkipped: parseResult.ocr_skipped ? "true" : "false",
            parseDurationMs: parseElapsedMs,
          })
          .onConflictDoUpdate({
            target: [
              schema.parseCache.tenantId,
              schema.parseCache.fileHash,
              schema.parseCache.providerFingerprint,
            ],
            set: {
              storageKey: cacheKey,
              pages: parseResult.pages ?? 0,
              ocrSkipped: parseResult.ocr_skipped ? "true" : "false",
              parseDurationMs: parseElapsedMs,
            },
          }),
      );
    } catch (err) {
      console.warn(
        `[ingestion.process] parse cache write failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    markdown: parseResult.markdown,
    textMap: (parseResult.text_map as any[]) ?? undefined,
    engine: parseResult.engine,
    chunks: parseResult.chunks,
    pages: parseResult.pages ?? undefined,
    ocr_skipped: parseResult.ocr_skipped,
    cached: false,
  };
}

/**
 * Captures each stage's timing + summary and writes them to the DB
 * incrementally so the trace view shows live progress. The trace row is
 * created upfront; stages are inserted as they start/complete.
 */
interface StageRecord {
  name: string;
  status: "ok" | "warn" | "fail" | "in_flight";
  durationMs: number | null;
  summaryJson: Record<string, unknown>;
  errorMessage?: string;
}

class TraceRecorder {
  private stages: StageRecord[] = [];
  private traceId: string | null = null;
  private db: Db | null = null;
  private tenantId: string | null = null;

  /**
   * Create the trace row upfront so stages can be written incrementally.
   */
  async init(db: Db, tenantId: string, documentId: string, jobId: string, originMs: number): Promise<void> {
    this.db = db;
    this.tenantId = tenantId;
    try {
      const [trace] = await withRLS(db, tenantId, (tx) =>
        tx.insert(schema.traces).values({
          tenantId,
          documentId,
          jobId,
          traceExternalId: `trc_${randomBytes(8).toString("hex")}`,
          status: "ok", // will be updated on terminal
          totalDurationMs: 0,
          startedAt: new Date(originMs),
          completedAt: new Date(originMs),
        }).returning({ id: schema.traces.id }),
      );
      this.traceId = trace?.id ?? null;
    } catch (err) {
      console.warn("[TraceRecorder] failed to create trace:", err instanceof Error ? err.message : err);
    }
  }

  /** Write a single stage row to the DB immediately. */
  private async writeStage(stage: StageRecord, stageOrder: number, startedAt: Date): Promise<void> {
    if (!this.traceId || !this.db || !this.tenantId) return;
    try {
      const completedAt = stage.durationMs != null ? new Date(startedAt.getTime() + stage.durationMs) : null;
      await withRLS(this.db, this.tenantId, (tx) =>
        tx.insert(schema.traceStages).values({
          tenantId: this.tenantId!,
          traceId: this.traceId!,
          stageName: stage.name,
          stageOrder,
          status: stage.status,
          durationMs: stage.durationMs,
          summaryJson: stage.summaryJson,
          errorMessage: stage.errorMessage ?? null,
          startedAt,
          completedAt,
        }),
      );
    } catch (err) {
      console.warn(`[TraceRecorder] failed to write stage ${stage.name}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Run an async step, time it, and write the stage to DB immediately.
   */
  async run<T>(
    name: string,
    fn: () => Promise<{ value: T; summary: Record<string, unknown> }>,
  ): Promise<T> {
    const start = Date.now();
    const stageOrder = this.stages.length;
    try {
      const { value, summary } = await fn();
      const stage: StageRecord = {
        name,
        status: "ok",
        durationMs: Date.now() - start,
        summaryJson: summary,
      };
      this.stages.push(stage);
      await this.writeStage(stage, stageOrder, new Date(start));
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stage: StageRecord = {
        name,
        status: "fail",
        durationMs: Date.now() - start,
        summaryJson: {},
        errorMessage: msg,
      };
      this.stages.push(stage);
      await this.writeStage(stage, stageOrder, new Date(start));
      throw err;
    }
  }

  /** Record a stage whose work was already done inline — e.g. the confidence gate. */
  record(
    name: string,
    durationMs: number,
    status: "ok" | "warn" | "fail",
    summaryJson: Record<string, unknown>,
    errorMessage?: string,
  ): void {
    const stage: StageRecord = { name, status, durationMs, summaryJson, errorMessage };
    this.stages.push(stage);
    // Fire-and-forget write
    this.writeStage(stage, this.stages.length - 1, new Date(Date.now() - durationMs)).catch(() => {});
  }

  /**
   * Record an in-flight Deliver stage. Its duration + terminal status are
   * unknown at flush time — the webhook worker's `advanceDeliverStage`
   * takes over once each delivery job resolves. Writing the stage here
   * (rather than having the worker CREATE it) guarantees the row exists
   * before any `webhook.deliver` job becomes visible to the worker.
   *
   * The counter is maintained per-target in `summary_json.targets`: a
   * target only contributes to `targets_delivered` / `targets_failed`
   * on its terminal outcome (success, or final retry failure), not on
   * every attempt. See the motor's webhook-deliver handler.
   */
  recordDeliverStage(prepared: PreparedWebhookEvent): void {
    const total = prepared.targets.length;
    // No subscribers? The stage has no work to do — record it as a
    // zero-duration "ok" stage so the timeline shows a clean completion.
    if (total === 0) {
      this.stages.push({
        name: "deliver",
        status: "ok",
        durationMs: 0,
        summaryJson: {
          event_id: prepared.eventId,
          event_type: prepared.payload.type,
          targets_total: 0,
          targets: {},
          targets_delivered: 0,
          targets_failed: 0,
        },
      });
      return;
    }
    this.stages.push({
      name: "deliver",
      status: "in_flight",
      durationMs: null,
      summaryJson: {
        event_id: prepared.eventId,
        event_type: prepared.payload.type,
        targets_total: total,
        targets: {},
        targets_delivered: 0,
        targets_failed: 0,
      },
    });
  }

  /**
   * Finalize the trace: update status and total duration. Stages are already
   * written incrementally via writeStage(). The Deliver stage is written here
   * if present (it's the last stage and needs the trace to exist first).
   *
   * Returns `true` on success.
   */
  async flush(
    db: Db,
    tenantId: string,
    documentId: string,
    jobId: string,
    originMs: number,
    traceStatus: "ok" | "review" | "failed",
  ): Promise<boolean> {
    if (!this.traceId) {
      // Trace wasn't created (init failed) — try creating it now with all stages
      await this.init(db, tenantId, documentId, jobId, originMs);
      if (!this.traceId) return false;
      // Write any stages that weren't written yet
      let cursor = originMs;
      for (let i = 0; i < this.stages.length; i++) {
        await this.writeStage(this.stages[i]!, i, new Date(cursor));
        if (this.stages[i]!.durationMs != null) cursor += this.stages[i]!.durationMs!;
      }
    }

    const totalMs = this.stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

    // Update the trace with final status and duration
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.traces)
        .set({
          status: traceStatus,
          totalDurationMs: totalMs,
          completedAt: new Date(originMs + totalMs),
        })
        .where(eq(schema.traces.id, this.traceId!)),
    );

    return true;
  }
}

// callExtract removed — extraction now runs in-process via extractFields()
// findLowestConfidenceField removed — replaced by deterministic
// `findLowestField` in extract/field-confidence.ts (no extractedValues
// filter needed since null fields now score based on schema's required flag).

function firstFieldName(scores: Record<string, number>): string | null {
  const keys = Object.keys(scores);
  return keys.length > 0 ? (keys[0] ?? null) : null;
}

function numberOr<T>(v: unknown, fallback: T): number | T {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeJobSlug(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const rand = Math.random().toString(16).slice(2, 6);
  return `job-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${rand}`;
}

async function failIngestion(
  db: Db,
  tenantId: string,
  ingestionId: string,
  reason: string,
): Promise<void> {
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.ingestions)
      .set({ status: "failed", failureReason: reason, completedAt: new Date() })
      .where(eq(schema.ingestions.id, ingestionId)),
  );
}

export async function markDocFailed(
  db: Db,
  tenantId: string,
  documentId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.documents)
      .set({
        status: "failed",
        validationJson: { error_cause: "extraction_failed", message: reason },
        completedAt: now,
      })
      .where(eq(schema.documents.id, documentId)),
  );
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.jobs)
      .set({
        docsProcessed: sql`${schema.jobs.docsProcessed} + 1`,
        docsFailed: sql`${schema.jobs.docsFailed} + 1`,
        completedAt: now,
        status: "failed",
      })
      .where(eq(schema.jobs.id, jobId)),
  );

  // Record billable event for the failure (best-effort)
  await _billing
    .recordBillableEvent(tenantId, {
      kind: "document_processed",
      documentId,
      jobId,
      disposition: "billable",
      terminalState: "failed",
      errorCause: "extraction_failed",
    })
    .catch((err) => {
      console.warn(
        "[ingestion.process] billing event write failed:",
        err instanceof Error ? err.message : err,
      );
    });

  // In-app notification for document failure
  createNotification(tenantId, {
    type: "document.failed",
    title: "Document extraction failed",
    body: reason,
    data: { documentId, jobId },
  });

  // Webhook event for document failure
  emitWebhookEvent(tenantId, "document.failed", { documentId, jobId, reason });
}
