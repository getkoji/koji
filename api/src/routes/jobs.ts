import { Hono } from "hono";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const jobs = new Hono<Env>();

/**
 * GET /api/jobs — list jobs for the current tenant.
 * Joins pipelines + schemas + schema_versions so the dashboard row has
 * pipeline name, schema name, and deployed version number without extra fetches.
 */
jobs.get("/", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const status = c.req.query("status");
  const pipelineSlug = c.req.query("pipeline");

  const rows = await withRLS(db, tenantId, (tx) => {
    let q = tx
      .select({
        slug: schema.jobs.slug,
        status: schema.jobs.status,
        triggerType: schema.jobs.triggerType,
        docsTotal: schema.jobs.docsTotal,
        docsProcessed: schema.jobs.docsProcessed,
        docsPassed: schema.jobs.docsPassed,
        docsFailed: schema.jobs.docsFailed,
        docsReviewing: schema.jobs.docsReviewing,
        avgLatencyMs: schema.jobs.avgLatencyMs,
        totalCostUsd: schema.jobs.totalCostUsd,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        createdAt: schema.jobs.createdAt,
        pipelineSlug: schema.pipelines.slug,
        pipelineName: schema.pipelines.displayName,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
      })
      .from(schema.jobs)
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.pipelines.schemaId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.pipelines.activeSchemaVersionId),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(limit);

    if (status) {
      q = q.where(eq(schema.jobs.status, status)) as typeof q;
    }
    if (pipelineSlug) {
      q = q.where(eq(schema.pipelines.slug, pipelineSlug)) as typeof q;
    }
    return q;
  });

  return c.json({ data: rows });
});

/**
 * GET /api/jobs/:slug — single job with joined pipeline + schema info.
 */
jobs.get("/:slug", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.jobs.id,
        slug: schema.jobs.slug,
        status: schema.jobs.status,
        triggerType: schema.jobs.triggerType,
        docsTotal: schema.jobs.docsTotal,
        docsProcessed: schema.jobs.docsProcessed,
        docsPassed: schema.jobs.docsPassed,
        docsFailed: schema.jobs.docsFailed,
        docsReviewing: schema.jobs.docsReviewing,
        avgLatencyMs: schema.jobs.avgLatencyMs,
        totalCostUsd: schema.jobs.totalCostUsd,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        createdAt: schema.jobs.createdAt,
        pipelineSlug: schema.pipelines.slug,
        pipelineName: schema.pipelines.displayName,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
      })
      .from(schema.jobs)
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.pipelines.schemaId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.pipelines.activeSchemaVersionId),
      )
      .where(eq(schema.jobs.slug, slug))
      .limit(1),
  );

  if (!row) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(row);
});

/**
 * GET /api/jobs/:slug/documents — documents processed by this job.
 */
jobs.get("/:slug/documents", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [job] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.slug, slug))
      .limit(1),
  );
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const docs = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.documents.id,
        filename: schema.documents.filename,
        status: schema.documents.status,
        confidence: schema.documents.confidence,
        durationMs: schema.documents.durationMs,
        costUsd: schema.documents.costUsd,
        pageCount: schema.documents.pageCount,
        extractionJson: schema.documents.extractionJson,
        validationJson: schema.documents.validationJson,
        startedAt: schema.documents.startedAt,
        completedAt: schema.documents.completedAt,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(eq(schema.documents.jobId, job.id))
      .orderBy(asc(schema.documents.createdAt)),
  );

  return c.json({ data: docs });
});

/**
 * GET /api/jobs/:slug/documents/:docId — single document with trace + stages.
 *
 * Powers the trace-view page. Returns the document, its job, the pipeline's
 * active schema (for the "Invoice v13"-style badge in the header), the trace
 * summary row, and every trace_stages row ordered by stage_order. All in one
 * round trip so the page renders without chained fetches.
 */
jobs.get("/:slug/documents/:docId", requires("job:read"), async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        documentId: schema.documents.id,
        filename: schema.documents.filename,
        storageKey: schema.documents.storageKey,
        mimeType: schema.documents.mimeType,
        status: schema.documents.status,
        confidence: schema.documents.confidence,
        durationMs: schema.documents.durationMs,
        costUsd: schema.documents.costUsd,
        pageCount: schema.documents.pageCount,
        extractionJson: schema.documents.extractionJson,
        validationJson: schema.documents.validationJson,
        startedAt: schema.documents.startedAt,
        completedAt: schema.documents.completedAt,
        createdAt: schema.documents.createdAt,
        jobId: schema.jobs.id,
        jobSlug: schema.jobs.slug,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.documents.schemaId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.documents.schemaVersionId),
      )
      .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
      .limit(1),
  );

  if (!row) {
    return c.json({ error: "Document not found" }, 404);
  }

  const [trace] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.traces.id,
        traceExternalId: schema.traces.traceExternalId,
        status: schema.traces.status,
        totalDurationMs: schema.traces.totalDurationMs,
        startedAt: schema.traces.startedAt,
        completedAt: schema.traces.completedAt,
      })
      .from(schema.traces)
      .where(eq(schema.traces.documentId, docId))
      .orderBy(desc(schema.traces.startedAt))
      .limit(1),
  );

  const stages = trace
    ? await withRLS(db, tenantId, (tx) =>
        tx
          .select({
            id: schema.traceStages.id,
            stageName: schema.traceStages.stageName,
            stageOrder: schema.traceStages.stageOrder,
            status: schema.traceStages.status,
            startedAt: schema.traceStages.startedAt,
            completedAt: schema.traceStages.completedAt,
            durationMs: schema.traceStages.durationMs,
            summaryJson: schema.traceStages.summaryJson,
            errorMessage: schema.traceStages.errorMessage,
          })
          .from(schema.traceStages)
          .where(eq(schema.traceStages.traceId, trace.id))
          .orderBy(asc(schema.traceStages.stageOrder)),
      )
    : [];

  // Sign a short-lived URL for "Open doc" if we have the file in storage.
  // Best-effort — old rows (or seed rows pointing at keys that never got
  // uploaded) will return null and the UI will just disable the button.
  let documentPreviewUrl: string | null = null;
  if (row.storageKey) {
    try {
      documentPreviewUrl = await storage.getSignedUrl(row.storageKey, 3600);
    } catch {
      documentPreviewUrl = null;
    }
  }

  return c.json({
    ...row,
    trace: trace ?? null,
    stages,
    documentPreviewUrl,
  });
});

/**
 * POST /api/jobs/:slug/documents/:docId/rerun — re-queue a document.
 *
 * "Rerun" means: take an existing document and put it back on the extraction
 * queue, reusing the same document + job rows. No new rows are created.
 *
 * The only guard is against an in-flight race: if status is already
 * `extracting`, two workers could end up on the same document (and we'd
 * double-bill the LLM). Every other status — `failed`, `delivered`,
 * `review`, stuck intermediate states — is rerunnable. Operators need this
 * for schema iteration, for retrying after a fix, and for re-emitting
 * webhook events. The new extraction overwrites the existing row's result
 * on completion; any downstream consumer that needs a canonical history
 * should be listening to webhook events, not polling the document.
 *
 * Anything else (`failed`, `received`, or the occasional stuck intermediate
 * state) gets flipped back to `extracting`, the terminal timestamps are
 * cleared so the UI doesn't show stale "completed at" strings, and the
 * ingestion.process job is re-enqueued with the same documentId. Mirrors the
 * enqueue pattern used by the pipeline manual-run and source-ingest paths.
 */
jobs.post("/:slug/documents/:docId/rerun", requires("job:run"), async (c) => {
  const db = c.get("db");
  const queue = c.get("queue");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const [doc] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        documentId: schema.documents.id,
        status: schema.documents.status,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
      .limit(1),
  );

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }

  if (doc.status === "extracting") {
    return c.json({ error: "Document is currently processing" }, 409);
  }

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.documents)
      .set({
        status: "extracting",
        completedAt: null,
        emittedAt: null,
        durationMs: null,
      })
      .where(eq(schema.documents.id, doc.documentId)),
  );

  await queue.enqueue(
    "ingestion.process",
    { documentId: doc.documentId },
    { tenantId },
  );

  return c.json({ ok: true }, 202);
});

/**
 * GET /api/jobs/:slug/documents/:docId/markdown — the parsed markdown.
 *
 * Powers the "Parse" stage detail pane. Every parse result is written to
 * parse_cache keyed by (tenant, content_hash); this endpoint does the lookup
 * on the document's contentHash and streams the cached JSON blob back.
 * Returns 404 when the document predates parse_cache writes (some seeded rows)
 * or when parse never completed for this document.
 */
jobs.get("/:slug/documents/:docId/markdown", requires("job:read"), async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const [doc] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        contentHash: schema.documents.contentHash,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
      .limit(1),
  );

  if (!doc || !doc.contentHash) {
    return c.json({ error: "Document not found" }, 404);
  }

  const [cached] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        storageKey: schema.parseCache.storageKey,
        pages: schema.parseCache.pages,
        ocrSkipped: schema.parseCache.ocrSkipped,
        createdAt: schema.parseCache.createdAt,
      })
      .from(schema.parseCache)
      .where(
        and(
          eq(schema.parseCache.tenantId, tenantId),
          eq(schema.parseCache.fileHash, doc.contentHash),
        ),
      )
      .limit(1),
  );

  if (!cached) {
    return c.json({ error: "No cached markdown for this document" }, 404);
  }

  const blob = await storage.getBuffer(cached.storageKey);
  if (!blob) {
    return c.json({ error: "Cache blob missing from storage" }, 404);
  }

  let payload: { markdown?: string; pages?: number; ocr_skipped?: boolean };
  try {
    payload = JSON.parse(blob.data.toString());
  } catch {
    return c.json({ error: "Cached markdown is unreadable" }, 500);
  }

  // Markdown is immutable per (tenant, file_hash) — safe to cache on the
  // client for an hour. The session cookie keeps it private.
  c.header("Cache-Control", "private, max-age=3600");
  return c.json({
    markdown: payload.markdown ?? "",
    pages: payload.pages ?? cached.pages ?? null,
    ocrSkipped:
      typeof payload.ocr_skipped === "boolean"
        ? payload.ocr_skipped
        : cached.ocrSkipped === "true",
    cachedAt: cached.createdAt,
  });
});

/**
 * GET /api/jobs/:slug/documents/:docId/deliveries — webhook delivery
 * attempts for this document.
 *
 * Powers the Deliver stage detail pane. Filters webhook_deliveries by
 * the document_id embedded in the payload's data blob — the payload
 * shape is set by emitWebhookEvent in api/src/webhooks/emit.ts and
 * always carries the document_id for document.* events. Each row is
 * joined to webhook_targets so the UI can show the destination URL
 * next to the HTTP status.
 *
 * Returns the delivery attempts in order of oldest → newest per target.
 * A row with status="failed" and httpStatus=null means the HTTP call
 * never produced a response (timeout, DNS, connection refused).
 */
jobs.get("/:slug/documents/:docId/deliveries", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const [doc] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
      .limit(1),
  );

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.webhookDeliveries.id,
        eventType: schema.webhookDeliveries.eventType,
        status: schema.webhookDeliveries.status,
        httpStatus: schema.webhookDeliveries.httpStatus,
        responseBody: schema.webhookDeliveries.responseBody,
        attemptCount: schema.webhookDeliveries.attemptCount,
        deliveredAt: schema.webhookDeliveries.deliveredAt,
        createdAt: schema.webhookDeliveries.createdAt,
        targetId: schema.webhookDeliveries.targetId,
        targetUrl: schema.webhookTargets.url,
        targetDisplayName: schema.webhookTargets.displayName,
      })
      .from(schema.webhookDeliveries)
      .leftJoin(
        schema.webhookTargets,
        eq(schema.webhookTargets.id, schema.webhookDeliveries.targetId),
      )
      .where(
        sql`${schema.webhookDeliveries.payloadJson}->'data'->>'document_id' = ${docId}`,
      )
      .orderBy(asc(schema.webhookDeliveries.createdAt)),
  );

  return c.json({ data: rows });
});
