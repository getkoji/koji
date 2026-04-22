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
import type { QueuedJob } from "../queue/provider";
import { TerminalError } from "../queue/worker";
import { emitWebhookEvent, countMatchingTargets } from "../webhooks/emit";
import { isTransientError } from "./errors";

const PARSE_URL = process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410";
const EXTRACT_URL = process.env.KOJI_EXTRACT_URL ?? "http://koji-extract:9420";

let _db: Db | null = null;
let _storage: StorageProvider | null = null;

export function initIngestionHandler(db: Db, storage: StorageProvider) {
  _db = db;
  _storage = storage;
}

interface IngestionProcessPayload {
  documentId: string;
}

export async function handleIngestionProcess(job: QueuedJob): Promise<void> {
  if (!_db || !_storage) throw new Error("Ingestion handler not initialized");
  const db = _db;
  const storage = _storage;

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
        const md = await getOrParse(db, storage, tenantId, document);
        return { value: md, summary: { markdown_chars: md.length } };
      },
    );
    extractResult = await recorder.run(
      "extract",
      async () => {
        const res = await callExtract(markdown, schemaVersion.yamlSource);
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

  // Defer the actual webhook emit until after the trace + Deliver stage
  // rows exist — we want each enqueued delivery job to carry the
  // traceStageId so the handler can update the aggregate counter.
  let pendingEmit: { eventType: string; data: object };

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

    pendingEmit = {
      eventType: "document.review_requested",
      data: {
        document_id: documentId,
        job_id: jobId,
        job_slug: jobSlug,
        pipeline_id: pipeline.id,
        field: reviewField,
        confidence: reviewConfidence,
        threshold,
      },
    };
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

    pendingEmit = {
      eventType: "document.delivered",
      data: {
        document_id: documentId,
        job_id: jobId,
        job_slug: jobSlug,
        pipeline_id: pipeline.id,
        extraction: docExtraction,
        confidence: docConfidence,
      },
    };
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

  // Flush the trace + stages so the trace view has a real timeline, then
  // append the async Deliver stage and kick off the actual webhook emits.
  // Best-effort — a trace-write failure shouldn't un-do the successful
  // delivery, and a delivery failure shouldn't rewrite the trace.
  try {
    const flushResult = await recorder.flush(
      db,
      tenantId,
      documentId,
      jobId,
      extractStart,
      routeToReview ? "review" : "ok",
    );

    if (flushResult) {
      const targetCount = await countMatchingTargets(tenantId, pendingEmit.eventType);
      const deliverStartedAt = new Date();

      if (targetCount === 0) {
        // No subscribers — record a skipped row so the timeline tells the
        // full story ("Deliver · skipped · no targets configured") rather
        // than silently omitting the stage.
        await withRLS(db, tenantId, (tx) =>
          tx.insert(schema.traceStages).values({
            tenantId,
            traceId: flushResult.traceId,
            stageName: "deliver",
            stageOrder: flushResult.nextStageOrder,
            status: "skipped",
            startedAt: deliverStartedAt,
            completedAt: deliverStartedAt,
            durationMs: 0,
            summaryJson: {
              event_type: pendingEmit.eventType,
              targets_total: 0,
              reason: "no webhook targets configured",
            },
          }),
        );
      } else {
        // Pre-insert the Deliver stage in the in_flight state. The
        // webhook delivery handler updates this row as each attempt
        // completes, finalising status + durationMs when the last
        // attempt lands.
        const [deliverStage] = await withRLS(db, tenantId, (tx) =>
          tx
            .insert(schema.traceStages)
            .values({
              tenantId,
              traceId: flushResult.traceId,
              stageName: "deliver",
              stageOrder: flushResult.nextStageOrder,
              status: "in_flight",
              startedAt: deliverStartedAt,
              completedAt: null,
              durationMs: null,
              summaryJson: {
                event_type: pendingEmit.eventType,
                targets_total: targetCount,
                targets_delivered: 0,
                targets_failed: 0,
              },
            })
            .returning({ id: schema.traceStages.id }),
        );

        await emitWebhookEvent(tenantId, pendingEmit.eventType, pendingEmit.data, {
          traceStageId: deliverStage?.id,
        });
        return;
      }
    }
  } catch (err) {
    console.warn(
      "[ingestion.process] trace flush / deliver-stage failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback path: if flushResult was null or targetCount was 0, still
  // fire the webhook (without a trace stage to update).
  await emitWebhookEvent(tenantId, pendingEmit.eventType, pendingEmit.data);
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
  const parseResult = await callParse(document.filename, mimeType, blob.data);
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

interface ParseResponse {
  markdown: string;
  pages?: number;
  ocr_skipped?: boolean;
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
  status: "ok" | "warn" | "fail";
  durationMs: number;
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
   * Flush to DB: insert a `traces` row, then all buffered `trace_stages`
   * with laid-out startedAt/completedAt timestamps anchored at `originMs`.
   *
   * Returns { traceId, nextStageOrder, tailMs } so callers can append
   * additional stages (like the async deliver stage, which we don't know
   * the final shape of until the queue worker finishes).
   */
  async flush(
    db: Db,
    tenantId: string,
    documentId: string,
    jobId: string,
    originMs: number,
    traceStatus: "ok" | "review" | "failed",
  ): Promise<{ traceId: string; nextStageOrder: number; tailMs: number } | null> {
    if (this.stages.length === 0) return null;

    const startedAt = new Date(originMs);
    const totalMs = this.stages.reduce((sum, s) => sum + s.durationMs, 0);
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
    if (!trace) return null;

    let cursor = originMs;
    const rows = this.stages.map((s, i) => {
      const stageStart = new Date(cursor);
      cursor += s.durationMs;
      const stageEnd = new Date(cursor);
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

    return {
      traceId: trace.id,
      nextStageOrder: this.stages.length,
      tailMs: cursor,
    };
  }
}

async function callParse(
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): Promise<ParseResponse> {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);
  const resp = await fetch(`${PARSE_URL}/parse`, { method: "POST", body: form });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`parse ${resp.status}: ${body.slice(0, 300)}`);
  }
  const result = (await resp.json()) as ParseResponse;
  if (!result.markdown) throw new Error("parse returned no markdown");
  return result;
}

async function callExtract(markdown: string, schemaYaml: string): Promise<ExtractResult> {
  let schemaDef: unknown;
  try {
    schemaDef = parseYaml(schemaYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "yaml parse";
    throw new TerminalError(`Invalid schema YAML: ${msg}`);
  }
  const resp = await fetch(`${EXTRACT_URL}/extract`, {
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
