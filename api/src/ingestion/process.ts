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
import type { QueuedJob } from "../queue/provider";
import { TerminalError } from "../queue/worker";
import {
  enqueueWebhookDeliveries,
  prepareWebhookEvent,
  type PreparedWebhookEvent,
} from "../webhooks/emit";
import { isTransientError } from "./errors";

export interface IngestionHandlerConfig {
  /** Base URL for the extract HTTP service (self-hosted sidecar or hosted proxy). */
  extractUrl: string;
}

let _db: Db | null = null;
let _storage: StorageProvider | null = null;
let _parseProvider: ParseProvider | null = null;
let _extractUrl: string | null = null;

export function initIngestionHandler(
  db: Db,
  storage: StorageProvider,
  config: IngestionHandlerConfig,
) {
  _db = db;
  _storage = storage;
  _extractUrl = config.extractUrl;
}

/**
 * Install the ParseProvider the motor should use for live parses.
 * Must be called before the first `handleIngestionProcess` invocation —
 * there's no longer a fallback since the factory requires explicit config.
 */
export function initParseProvider(provider: ParseProvider) {
  _parseProvider = provider;
}

interface IngestionProcessPayload {
  documentId: string;
}

export async function handleIngestionProcess(job: QueuedJob): Promise<void> {
  if (!_db || !_storage || !_extractUrl) {
    throw new Error("Ingestion handler not initialized");
  }
  if (!_parseProvider) {
    throw new Error("Parse provider not initialized — call initParseProvider()");
  }
  const db = _db;
  const storage = _storage;
  const parseProvider = _parseProvider;
  const extractUrl = _extractUrl;

  const { documentId } = job.payload as unknown as IngestionProcessPayload;
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

  // ── Resolve markdown via parse_cache, falling back to live parse ─────────
  //
  // Each step below records a trace_stages row so the trace view can show
  // the real timeline instead of "No trace stages recorded". On failure we
  // still flush the stages we got to — the trace is more useful with a
  // partial-but-honest timeline than with nothing.
  const recorder = new TraceRecorder();

  let extractResult: ExtractResult;
  const extractStart = Date.now();
  try {
    const markdown = await recorder.run(
      "parse",
      async () => {
        const md = await getOrParse(db, storage, parseProvider, tenantId, document);
        return { value: md, summary: { markdown_chars: md.length } };
      },
    );
    extractResult = await recorder.run(
      "extract",
      async () => {
        const res = await callExtract(extractUrl, markdown, schemaVersion.yamlSource);
        return {
          value: res,
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
    if (isTransientError(err)) {
      console.warn(
        `[ingestion.process] transient failure for ${documentId}, will retry: ${msg}`,
      );
      throw err;
    }

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
  const validateStart = Date.now();
  const confidence = numberOr(extractResult.confidence, null);
  const fieldScores = extractResult.confidence_scores ?? {};
  const threshold = Number(pipeline.reviewThreshold);
  const lowField = findLowestConfidenceField(fieldScores, threshold);

  const routeToReview =
    lowField !== null ||
    (confidence !== null && Number.isFinite(threshold) && confidence < threshold);

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
  } else {
    // Delivered
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.documents)
        .set({
          status: "delivered",
          extractionJson: docExtraction,
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
        status: "extracting",
        startedAt: new Date(),
      })
      .returning({ id: schema.documents.id }),
  );

  return { jobId, jobSlug, documentId: createdDoc!.id };
}

// ───────────────────────────────────────────────────────────────────────────

interface ExtractResult {
  extracted: unknown;
  confidence: number | null | undefined;
  confidence_scores?: Record<string, number>;
  model?: string;
  elapsed_ms?: number;
}

/**
 * Look up the markdown for this document, hitting parse_cache first and
 * falling back to a live parse on miss. The cache write happens
 * best-effort — a write failure shouldn't fail the extraction. Mirrors the
 * pattern in routes/extract.ts (handleExtractRunJSON) so build mode and
 * the worker share the same cache entries by (tenantId, fileHash).
 *
 * For large digital PDFs this turns repeat runs from minutes into milliseconds.
 */
async function getOrParse(
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
): Promise<string> {
  const fileHash = document.contentHash;

  // 1. Cache lookup
  if (fileHash) {
    const [cached] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ storageKey: schema.parseCache.storageKey })
        .from(schema.parseCache)
        .where(
          and(
            eq(schema.parseCache.tenantId, tenantId),
            eq(schema.parseCache.fileHash, fileHash),
          ),
        )
        .limit(1),
    );

    if (cached) {
      const cacheBlob = await storage.getBuffer(cached.storageKey);
      if (cacheBlob) {
        try {
          const payload = JSON.parse(cacheBlob.data.toString()) as { markdown?: string };
          if (payload.markdown) {
            console.log(`[ingestion.process] parse cache hit for ${fileHash.slice(0, 12)}…`);
            return payload.markdown;
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

  // 3. Cache write (best-effort)
  if (fileHash) {
    const cacheKey = `cache/${tenantId}/${fileHash}.json`;
    const cachePayload = Buffer.from(
      JSON.stringify({
        markdown: parseResult.markdown,
        pages: parseResult.pages,
        ocr_skipped: parseResult.ocr_skipped,
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
            storageKey: cacheKey,
            pages: parseResult.pages ?? 0,
            ocrSkipped: parseResult.ocr_skipped ? "true" : "false",
            parseDurationMs: parseElapsedMs,
          })
          .onConflictDoNothing(),
      );
    } catch (err) {
      console.warn(
        `[ingestion.process] parse cache write failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return parseResult.markdown;
}

/**
 * Captures each motor stage's timing + summary so the trace view has a real
 * timeline. Stages are held in memory during processing, then flushed to the
 * `traces` + `trace_stages` tables on terminal transition (delivered / review
 * / failed). Writing only at the end means a single round trip and keeps the
 * hot path out of the DB during parse/extract.
 */
interface StageRecord {
  name: string;
  status: "ok" | "warn" | "fail" | "in_flight";
  /** When known (completed stages). The Deliver stage is written as
   *  `in_flight` with `durationMs=null` and is finalised by the webhook
   *  worker on the last target's terminal outcome. */
  durationMs: number | null;
  summaryJson: Record<string, unknown>;
  errorMessage?: string;
}

class TraceRecorder {
  private stages: StageRecord[] = [];

  /**
   * Run an async step, time it, and record a stage row. On success the
   * caller returns `{ value, summary }` — the summary ends up in
   * trace_stages.summary_json. On throw we record a fail stage and
   * re-raise so the caller's catch block can deal with the error.
   */
  async run<T>(
    name: string,
    fn: () => Promise<{ value: T; summary: Record<string, unknown> }>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const { value, summary } = await fn();
      this.stages.push({
        name,
        status: "ok",
        durationMs: Date.now() - start,
        summaryJson: summary,
      });
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.stages.push({
        name,
        status: "fail",
        durationMs: Date.now() - start,
        summaryJson: {},
        errorMessage: msg,
      });
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
    this.stages.push({ name, status, durationMs, summaryJson, errorMessage });
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
   * Flush to DB: insert a `traces` row, then all buffered `trace_stages`
   * with laid-out startedAt/completedAt timestamps anchored at `originMs`.
   *
   * Returns `true` on success so the caller knows it's safe to enqueue the
   * webhook deliveries now that the Deliver trace stage row is in place.
   * Returns `false` if the insert couldn't be completed — the caller may
   * choose to still emit (webhook contract beats trace visibility).
   */
  async flush(
    db: Db,
    tenantId: string,
    documentId: string,
    jobId: string,
    originMs: number,
    traceStatus: "ok" | "review" | "failed",
  ): Promise<boolean> {
    if (this.stages.length === 0) return false;

    const startedAt = new Date(originMs);
    // Only completed stages contribute to `total_duration_ms` — the Deliver
    // stage is in-flight and its duration is still unknown at flush time.
    const totalMs = this.stages.reduce(
      (sum, s) => sum + (s.durationMs ?? 0),
      0,
    );
    const completedAt = new Date(originMs + totalMs);

    const [trace] = await withRLS(db, tenantId, (tx) =>
      tx
        .insert(schema.traces)
        .values({
          tenantId,
          documentId,
          jobId,
          traceExternalId: `trc_${randomBytes(8).toString("hex")}`,
          status: traceStatus,
          totalDurationMs: totalMs,
          startedAt,
          completedAt,
        })
        .returning({ id: schema.traces.id }),
    );
    if (!trace) return false;

    let cursor = originMs;
    const rows = this.stages.map((s, i) => {
      const stageStart = new Date(cursor);
      // In-flight stages (Deliver) don't advance the cursor — they have no
      // known completion time yet. The worker fills these in.
      const stageEnd = s.durationMs === null ? null : new Date(cursor + s.durationMs);
      if (s.durationMs !== null) cursor += s.durationMs;
      return {
        tenantId,
        traceId: trace.id,
        stageName: s.name,
        stageOrder: i,
        status: s.status,
        startedAt: stageStart,
        completedAt: stageEnd,
        durationMs: s.durationMs,
        summaryJson: s.summaryJson,
        errorMessage: s.errorMessage ?? null,
      };
    });

    await withRLS(db, tenantId, (tx) => tx.insert(schema.traceStages).values(rows));
    return true;
  }
}

async function callExtract(extractUrl: string, markdown: string, schemaYaml: string): Promise<ExtractResult> {
  let schemaDef: unknown;
  try {
    schemaDef = parseYaml(schemaYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "yaml parse";
    throw new TerminalError(`Invalid schema YAML: ${msg}`);
  }
  const resp = await fetch(`${extractUrl}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, schema_def: schemaDef }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`extract ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as ExtractResult;
}

function findLowestConfidenceField(
  scores: Record<string, number>,
  threshold: number,
): { name: string; confidence: number } | null {
  let worst: { name: string; confidence: number } | null = null;
  for (const [name, raw] of Object.entries(scores)) {
    const c = Number(raw);
    if (!Number.isFinite(c)) continue;
    if (c < threshold && (worst === null || c < worst.confidence)) {
      worst = { name, confidence: c };
    }
  }
  return worst;
}

function firstFieldName(scores: Record<string, number>): string | null {
  const keys = Object.keys(scores);
  return keys.length > 0 ? (keys[0] ?? null) : null;
}

function numberOr<T>(v: unknown, fallback: T): number | T {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function mimeTypeFor(filename: string | null): string {
  if (!filename) return "application/octet-stream";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
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

async function markDocFailed(
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
}
