import { Hono } from "hono";
import { and, eq, desc, asc } from "drizzle-orm";
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
