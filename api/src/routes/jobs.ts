import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq, desc, asc, gte, lt, isNull, ilike, sql, type SQL } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, generatePreviewToken } from "../auth/middleware";

export const jobs = new Hono<Env>();

/**
 * Resolve a `since` query param to an absolute cutoff.
 *
 * Accepts either a shorthand (`today` | `7d` | `30d` | `all`) or an ISO 8601
 * timestamp. Returns:
 *   - `{ cutoff: Date }` to apply as `createdAt >= cutoff`
 *   - `{ cutoff: null }` when the caller passed nothing (or `all`) — no filter
 *   - `{ error }` for unrecognized shorthands or unparseable timestamps (→ 400)
 *
 * Shorthand semantics (all server-side so clients in different zones agree):
 *   today → start of the current UTC day
 *   7d    → now - 7 days
 *   30d   → now - 30 days
 */
function resolveSince(raw: string | undefined): { cutoff: Date | null } | { error: string } {
  if (!raw || raw === "all") return { cutoff: null };

  const now = Date.now();
  if (raw === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return { cutoff: d };
  }
  if (raw === "7d") return { cutoff: new Date(now - 7 * 24 * 60 * 60 * 1000) };
  if (raw === "30d") return { cutoff: new Date(now - 30 * 24 * 60 * 60 * 1000) };

  // Treat anything else as a timestamp. Reject if it doesn't parse OR if it
  // looks like a malformed shorthand (e.g. "5d", "90d") so typos don't pass
  // silently as NaN dates.
  if (/^\d+[a-zA-Z]+$/.test(raw)) {
    return { error: `Unknown 'since' shorthand: ${raw}. Use today, 7d, 30d, or all.` };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `Invalid 'since' value: ${raw}` };
  }
  return { cutoff: parsed };
}

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

  const search = c.req.query("search")?.trim();
  const cursor = c.req.query("cursor"); // ISO timestamp — fetch items older than this

  const since = resolveSince(c.req.query("since"));
  if ("error" in since) {
    return c.json({ error: since.error }, 400);
  }

  // Build filter predicates. "baseConditions" apply to both the count query
  // and the paginated query. The cursor is pagination-only (doesn't affect counts).
  const baseConditions: SQL[] = [];
  if (status) baseConditions.push(eq(schema.jobs.status, status));
  if (pipelineSlug) baseConditions.push(eq(schema.pipelines.slug, pipelineSlug));
  if (since.cutoff) baseConditions.push(gte(schema.jobs.createdAt, since.cutoff));

  if (search) {
    const pattern = `%${search}%`;
    baseConditions.push(
      sql`(${schema.jobs.slug} ILIKE ${pattern} OR ${schema.jobs.id} IN (
        SELECT ${schema.documents.jobId} FROM ${schema.documents}
        WHERE ${schema.documents.filename} ILIKE ${pattern}
        AND ${schema.documents.parentDocumentId} IS NULL
      ))`,
    );
  }

  const conditions = [...baseConditions];
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate.getTime())) {
      conditions.push(lt(schema.jobs.createdAt, cursorDate));
    }
  }

  const rows = await withRLS(db, tenantId, (tx) => {
    const base = tx
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
      );

    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    return filtered.orderBy(desc(schema.jobs.createdAt)).limit(limit);
  });

  // If we got a full page, there may be more — provide a cursor for the next page.
  const nextCursor = rows.length >= limit && rows.length > 0
    ? (rows[rows.length - 1]!.createdAt as Date).toISOString()
    : null;

  // Per-status counts — uses base filters (no cursor) so counts reflect
  // the full dataset, not just the current page.
  const counts = await withRLS(db, tenantId, (tx) => {
    const base = tx
      .select({
        status: schema.jobs.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.jobs)
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId));

    const filtered = baseConditions.length > 0 ? base.where(and(...baseConditions)) : base;
    return filtered.groupBy(schema.jobs.status);
  });

  const statusCounts: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    statusCounts[row.status] = row.count;
    total += row.count;
  }

  return c.json({ data: rows, nextCursor, counts: { total, byStatus: statusCounts } });
});

/**
 * GET /api/jobs/documents/search?q=filename — search documents by filename.
 * Powers the command palette document search. Returns up to 10 matches.
 * Must be registered before /:slug to avoid being caught by the wildcard.
 */
jobs.get("/documents/search", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const q = c.req.query("q")?.trim();

  if (!q || q.length < 2) {
    return c.json({ data: [] });
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        documentId: schema.documents.id,
        filename: schema.documents.filename,
        status: schema.documents.status,
        jobSlug: schema.jobs.slug,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(
        and(
          ilike(schema.documents.filename, `%${q}%`),
          isNull(schema.documents.parentDocumentId),
        ),
      )
      .orderBy(desc(schema.documents.createdAt))
      .limit(10),
  );

  return c.json({ data: rows });
});

/**
 * GET /api/jobs/traces/lookup?id=trc_... — resolve a trace external ID to
 * its job slug + document ID. Powers the command palette trace search.
 * Must be registered before /:slug to avoid being caught by the wildcard.
 */
jobs.get("/traces/lookup", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const externalId = c.req.query("id");

  if (!externalId) {
    return c.json({ error: "id query param is required" }, 400);
  }

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        traceExternalId: schema.traces.traceExternalId,
        documentId: schema.traces.documentId,
        jobSlug: schema.jobs.slug,
        filename: schema.documents.filename,
        status: schema.documents.status,
      })
      .from(schema.traces)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.traces.jobId))
      .innerJoin(schema.documents, eq(schema.documents.id, schema.traces.documentId))
      .where(eq(schema.traces.traceExternalId, externalId))
      .limit(1),
  );

  if (!row) {
    return c.json({ error: "Trace not found" }, 404);
  }

  return c.json(row);
});

/** Terminal document statuses — no more stages will appear. */
const TERMINAL_STATUSES = new Set(["delivered", "failed"]);

/**
 * GET /api/jobs/:slug/documents/:docId/stream — SSE stream of trace stage
 * updates. Polls every 1.5s and emits new stages as they appear. Closes when
 * the document reaches a terminal status or after 5 minutes (safety net).
 *
 * Dual-auth: works with session cookie (normal auth middleware → RLS) or
 * with an HMAC preview token (embed viewer — bypasses auth, uses raw db).
 */
jobs.get("/:slug/documents/:docId/stream", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  // Dual-auth: if auth middleware resolved a tenant, use RLS. Otherwise
  // (HMAC token path), use raw db — same pattern as preview/embed-data.
  const tenantId = c.get("tenantId") as string | undefined;

  async function query<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
    if (tenantId) return withRLS(db, tenantId, fn as any);
    return fn(db);
  }

  // Look up the document
  const [doc] = await query((tx) =>
    tx
      .select({ id: schema.documents.id, status: schema.documents.status })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
      .limit(1),
  ) as any[];

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }

  // If already terminal, return final state as JSON (not SSE)
  if (TERMINAL_STATUSES.has(doc.status)) {
    return c.json({ documentStatus: doc.status, terminal: true });
  }

  // Start SSE stream
  const POLL_INTERVAL_MS = 1500;
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  return streamSSE(c, async (stream) => {
    const sentStageIds = new Set<string>();
    const startedAt = Date.now();

    while (true) {
      // Safety timeout
      if (Date.now() - startedAt > TIMEOUT_MS) {
        await stream.writeSSE({ event: "done", data: JSON.stringify({ reason: "timeout" }) });
        break;
      }

      // Check current document status
      const [currentDoc] = await query((tx) =>
        tx
          .select({ status: schema.documents.status, completedAt: schema.documents.completedAt })
          .from(schema.documents)
          .where(eq(schema.documents.id, docId))
          .limit(1),
      ) as any[];

      if (!currentDoc) break;

      // Get the most recent trace
      const [trace] = await query((tx) =>
        tx
          .select({ id: schema.traces.id })
          .from(schema.traces)
          .where(eq(schema.traces.documentId, docId))
          .orderBy(desc(schema.traces.startedAt))
          .limit(1),
      ) as any[];

      if (trace) {
        // Get all stages for this trace
        const stages = await query((tx) =>
          tx
            .select({
              id: schema.traceStages.id,
              stageName: schema.traceStages.stageName,
              status: schema.traceStages.status,
              durationMs: schema.traceStages.durationMs,
              summaryJson: schema.traceStages.summaryJson,
            })
            .from(schema.traceStages)
            .where(eq(schema.traceStages.traceId, trace.id))
            .orderBy(asc(schema.traceStages.stageOrder)),
        ) as any[];

        // Emit new stages only
        for (const stage of stages) {
          if (!sentStageIds.has(stage.id)) {
            sentStageIds.add(stage.id);
            await stream.writeSSE({
              event: "stage",
              data: JSON.stringify({
                name: stage.stageName,
                status: stage.status,
                durationMs: stage.durationMs,
                summary: stage.summaryJson,
              }),
            });
          }
        }
      }

      // If document reached a terminal status, emit final event and close
      if (TERMINAL_STATUSES.has(currentDoc.status)) {
        await stream.writeSSE({
          event: "status",
          data: JSON.stringify({
            documentStatus: currentDoc.status,
            completedAt: currentDoc.completedAt,
          }),
        });
        await stream.writeSSE({ event: "done", data: JSON.stringify({}) });
        break;
      }

      // Wait before next poll
      await stream.sleep(POLL_INTERVAL_MS);
    }
  });
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
        confidenceScoresJson: schema.documents.confidenceScoresJson,
        provenanceJson: schema.documents.provenanceJson,
        validationJson: schema.documents.validationJson,
        startedAt: schema.documents.startedAt,
        completedAt: schema.documents.completedAt,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.jobId, job.id), isNull(schema.documents.parentDocumentId)))
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
        confidenceScoresJson: schema.documents.confidenceScoresJson,
        provenanceJson: schema.documents.provenanceJson,
        validationJson: schema.documents.validationJson,
        startedAt: schema.documents.startedAt,
        completedAt: schema.documents.completedAt,
        createdAt: schema.documents.createdAt,
        jobId: schema.jobs.id,
        jobSlug: schema.jobs.slug,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
        pipelineId: schema.jobs.pipelineId,
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

  // Query DAG step runs (for DAG pipelines)
  const stepRuns = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelineStepRuns.id,
        stepId: schema.pipelineStepRuns.stepId,
        stepType: schema.pipelineStepRuns.stepType,
        stepOrder: schema.pipelineStepRuns.stepOrder,
        status: schema.pipelineStepRuns.status,
        outputJson: schema.pipelineStepRuns.outputJson,
        errorMessage: schema.pipelineStepRuns.errorMessage,
        durationMs: schema.pipelineStepRuns.durationMs,
        costUsd: schema.pipelineStepRuns.costUsd,
        startedAt: schema.pipelineStepRuns.startedAt,
        completedAt: schema.pipelineStepRuns.completedAt,
      })
      .from(schema.pipelineStepRuns)
      .where(eq(schema.pipelineStepRuns.documentId, docId))
      .orderBy(asc(schema.pipelineStepRuns.stepOrder)),
  );

  // Generate a signed preview URL. The HMAC token grants time-limited access
  // without requiring the viewer to have a session cookie (e.g. react-pdf
  // fetches the PDF via JS, not through the middleware's auth chain).
  let documentPreviewUrl: string | null = null;
  let documentToken: string | null = null;
  if (row.storageKey) {
    const previewPath = `/api/jobs/${slug}/documents/${row.documentId}/preview`;
    const basePath = `/api/jobs/${slug}/documents/${row.documentId}`;
    const masterKey = c.get("masterKey") as string | null;
    if (masterKey) {
      documentToken = generatePreviewToken(basePath, masterKey);
      documentPreviewUrl = `${previewPath}?token=${documentToken}`;
    } else {
      documentPreviewUrl = previewPath;
    }
  }

  // For DAG pipelines, convert step runs into the trace stage shape
  // so the frontend renders them without changes.
  const dagStages = stepRuns.map((sr) => ({
    id: sr.id,
    stageName: `${sr.stepType}: ${sr.stepId}`,
    stageOrder: sr.stepOrder,
    status: sr.status === "completed" ? "ok" : sr.status,
    startedAt: sr.startedAt,
    completedAt: sr.completedAt,
    durationMs: sr.durationMs,
    summaryJson: sr.outputJson as Record<string, unknown> | null,
    errorMessage: sr.errorMessage,
  }));

  return c.json({
    ...row,
    trace: trace ?? null,
    stages: dagStages.length > 0 ? dagStages : stages,
    stepRuns: stepRuns.length > 0 ? stepRuns : undefined,
    documentPreviewUrl,
    documentToken,
    embedUrl: documentToken
      ? `/embed/viewer?job=${slug}&doc=${row.documentId}&token=${documentToken}`
      : null,
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
        jobId: schema.documents.jobId,
        status: schema.documents.status,
        pipelineId: schema.jobs.pipelineId,
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

  const now = new Date();

  // Reset document — clear stale extraction results so the UI shows a clean
  // "extracting" state instead of the previous run's data.
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.documents)
      .set({
        status: "extracting",
        extractionJson: null,
        confidence: null,
        validationJson: null,
        durationMs: null,
        completedAt: null,
        emittedAt: null,
        startedAt: now,
      })
      .where(eq(schema.documents.id, doc.documentId)),
  );

  // Reset job back to running so the dashboard reflects the rerun.
  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.jobs)
      .set({
        status: "running",
        completedAt: null,
      })
      .where(eq(schema.jobs.id, doc.jobId)),
  );

  // Clear old step runs so the DAG runner starts fresh
  await withRLS(db, tenantId, (tx) =>
    tx.delete(schema.pipelineStepRuns)
      .where(eq(schema.pipelineStepRuns.documentId, doc.documentId)),
  );

  // Route to DAG runner if the pipeline has DAG steps, otherwise legacy
  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({ pipelineType: schema.pipelines.pipelineType })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, doc.pipelineId))
      .limit(1),
  );

  if (pipeline?.pipelineType === "dag") {
    await queue.enqueue(
      "pipeline.dag.run",
      { documentId: doc.documentId, pipelineId: doc.pipelineId },
      { tenantId },
    );
  } else {
    await queue.enqueue(
      "ingestion.process",
      { documentId: doc.documentId },
      { tenantId },
    );
  }

  return c.json({ ok: true }, 202);
});

/**
 * GET /api/jobs/:slug/documents/:docId/preview — stream document file.
 *
 * Auth is handled by the middleware via HMAC-signed time-limited tokens.
 * The token is generated by the trace-detail endpoint and appended as
 * ?token=<expiry_hex>.<hmac_hex>. Tokens expire after 1 hour.
 */
jobs.get("/:slug/documents/:docId/preview", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const docId = c.req.param("docId")!;

  // Direct query without RLS — this endpoint has no auth context.
  // Security: document IDs are unguessable UUIDs, and this URL is
  // only exposed via authenticated API responses.
  const [doc] = await db
    .select({ storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(eq(schema.documents.id, docId))
    .limit(1);

  if (!doc?.storageKey) {
    return c.json({ error: "Document not found" }, 404);
  }

  try {
    // Prefer the searchable PDF (OCR text layer) when available
    const searchableKey = `${doc.storageKey}.searchable.pdf`;
    let file = await storage.getBuffer(searchableKey).catch(() => null);
    let isSearchable = Boolean(file);
    if (!file) {
      file = await storage.getBuffer(doc.storageKey);
    }
    if (!file) return c.json({ error: "File not available" }, 404);

    let contentType: string;
    if (isSearchable) {
      contentType = "application/pdf";
    } else {
      const ext = doc.storageKey.split(".").pop()?.toLowerCase();
      contentType = ext === "pdf" ? "application/pdf"
        : ext === "png" ? "image/png"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : file.contentType;
    }

    c.header("Content-Type", contentType);
    c.header("Content-Disposition", "inline");
    c.header("Cache-Control", "private, max-age=3600");
    return new Response(file.data, { headers: c.res.headers });
  } catch {
    return c.json({ error: "File not available in storage" }, 404);
  }
});

/**
 * GET /api/jobs/:slug/documents/:docId/embed-data — everything the embeddable
 * viewer needs in one call: preview URL + provenance highlights.
 *
 * Auth via HMAC token (same as preview endpoint). External clients iframe
 * the embed viewer page, which calls this endpoint to get the data.
 */
jobs.get("/:slug/documents/:docId/embed-data", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;
  const masterKey = c.get("masterKey") as string | null;

  const [doc] = await db
    .select({
      filename: schema.documents.filename,
      pageCount: schema.documents.pageCount,
      provenanceJson: schema.documents.provenanceJson,
      storageKey: schema.documents.storageKey,
    })
    .from(schema.documents)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
    .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
    .limit(1);

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }

  // Build the signed preview URL — sign the base path so the same token
  // works for /preview, /embed-data, and any future sub-endpoints.
  const basePath = `/api/jobs/${slug}/documents/${docId}`;
  const previewPath = `${basePath}/preview`;
  let previewUrl: string;
  if (masterKey) {
    const token = generatePreviewToken(basePath, masterKey);
    previewUrl = `${previewPath}?token=${token}`;
  } else {
    previewUrl = previewPath;
  }

  // Convert provenance to BBoxHighlight format
  const provenance = (doc.provenanceJson ?? {}) as Record<
    string,
    { offset?: number; length?: number; page?: number; bbox?: { x: number; y: number; w: number; h: number }; words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>; reasoning?: string } | null
  >;

  const highlights = Object.entries(provenance)
    .filter(([, v]) => v && (v.words?.length || (v.bbox && v.page)))
    .map(([field, v]) => ({
      field,
      page: v!.words?.[0]?.page ?? v!.page ?? 1,
      bbox: v!.bbox,
      words: v!.words,
      reasoning: v!.reasoning,
    }));

  return c.json({
    previewUrl,
    highlights,
    filename: doc.filename,
    pageCount: doc.pageCount,
  });
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

/**
 * GET /api/jobs/:slug/documents/:docId/steps — pipeline step runs for a document.
 *
 * Returns the per-step execution trace for DAG pipelines. Each row represents
 * one step in the compiled pipeline that was (or will be) executed for this
 * document. Used by the trace-view UI to render the step-by-step waterfall.
 */
jobs.get("/:slug/documents/:docId/steps", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  // Verify the document exists and belongs to this job
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
        id: schema.pipelineStepRuns.id,
        stepId: schema.pipelineStepRuns.stepId,
        stepType: schema.pipelineStepRuns.stepType,
        stepOrder: schema.pipelineStepRuns.stepOrder,
        status: schema.pipelineStepRuns.status,
        outputJson: schema.pipelineStepRuns.outputJson,
        errorMessage: schema.pipelineStepRuns.errorMessage,
        durationMs: schema.pipelineStepRuns.durationMs,
        costUsd: schema.pipelineStepRuns.costUsd,
        startedAt: schema.pipelineStepRuns.startedAt,
        completedAt: schema.pipelineStepRuns.completedAt,
      })
      .from(schema.pipelineStepRuns)
      .where(eq(schema.pipelineStepRuns.documentId, docId))
      .orderBy(asc(schema.pipelineStepRuns.stepOrder)),
  );

  return c.json({ data: rows });
});

