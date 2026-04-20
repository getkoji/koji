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

import { eq, sql } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { QueuedJob } from "../queue/provider";
import { TerminalError } from "../queue/worker";
import { emitWebhookEvent } from "../webhooks/emit";

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

  // ── Fetch bytes, parse, extract ───────────────────────────────────────────
  const blob = await storage.getBuffer(document.storageKey);
  if (!blob) {
    const reason = "File not found in storage";
    await markDocFailed(db, tenantId, documentId, jobId, reason);
    if (document.ingestionId) {
      await failIngestion(db, tenantId, document.ingestionId, reason);
    }
    throw new TerminalError(reason);
  }

  let extractResult: ExtractResult;
  const extractStart = Date.now();
  try {
    const markdown = await callParse(
      document.filename,
      document.mimeType || mimeTypeFor(document.filename),
      blob.data,
    );
    extractResult = await callExtract(markdown, schemaVersion.yamlSource);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markDocFailed(db, tenantId, documentId, jobId, `Extraction failed: ${msg}`);
    // Mark the ingestion failed too so re-posts the same file surface an
    // actionable error instead of silently short-circuiting on the idempotency
    // check. Re-ingestion (a fresh POST) is the intended retry path.
    if (document.ingestionId) {
      await failIngestion(db, tenantId, document.ingestionId, msg);
    }
    throw new TerminalError(`Extraction failed: ${msg}`);
  }
  const extractDurationMs = Date.now() - extractStart;

  // ── Confidence gate ───────────────────────────────────────────────────────
  const confidence = numberOr(extractResult.confidence, null);
  const fieldScores = extractResult.confidence_scores ?? {};
  const threshold = Number(pipeline.reviewThreshold);
  const lowField = findLowestConfidenceField(fieldScores, threshold);

  const routeToReview =
    lowField !== null ||
    (confidence !== null && Number.isFinite(threshold) && confidence < threshold);

  const now = new Date();
  const docConfidence = confidence === null ? null : confidence.toFixed(4);
  const docExtraction = extractResult.extracted ?? null;

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

    await emitWebhookEvent(tenantId, "document.review_requested", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipeline.id,
      field: reviewField,
      confidence: reviewConfidence,
      threshold,
    });
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

    await emitWebhookEvent(tenantId, "document.delivered", {
      document_id: documentId,
      job_id: jobId,
      job_slug: jobSlug,
      pipeline_id: pipeline.id,
      extraction: docExtraction,
      confidence: docConfidence,
    });
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

async function callParse(
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);
  const resp = await fetch(`${PARSE_URL}/parse`, { method: "POST", body: form });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`parse ${resp.status}: ${body.slice(0, 300)}`);
  }
  const result = (await resp.json()) as { markdown?: string };
  if (!result.markdown) throw new Error("parse returned no markdown");
  return result.markdown;
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
