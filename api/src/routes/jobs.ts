import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq, desc, asc, gte, lt, isNull, ilike, sql, type SQL } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getRlsScope, generatePreviewToken, getProjectId } from "../auth/middleware";
import { requireFeature } from "../billing/middleware";
import { emitWebhookEvent } from "../webhooks/emit";
import { formatSemverLabel } from "../schemas/semver";
import { locateWordsByRegion } from "../extract/region";
import { toProvenanceTextMap, type BBox, type FlatTextMapSegment } from "../extract/provenance";
import { parseOverrideProvenance, buildAnchoredSpan, type AnchoredProvenance } from "./review";

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
/**
 * Decide the next job status after a document transitions to a terminal
 * state. Used by the force-fail handler — and any other code path that
 * needs to finalize a job after-the-fact instead of at the same call
 * site as the doc-status change.
 *
 * Returns the new status string, or `null` if the job should stay where
 * it is. The caller writes the update (and sets `completedAt` to its
 * own clock, so this function stays pure and unit-testable).
 *
 * Semantics mirror `ingestion/process.ts`: any doc that passed or ended
 * up in review counts as job-level success; only jobs whose every
 * document failed get `failed`. Jobs not in `running` state are
 * untouched — re-running a finalize on an already-terminal job must
 * not flip it back.
 */
export function nextJobStatusAfterDocFinalize(
  job:
    | {
        status: string;
        docsTotal: number;
        docsProcessed: number;
        docsPassed: number;
        docsReviewing: number;
      }
    | undefined,
): "complete" | "failed" | null {
  if (!job) return null;
  if (job.status !== "running") return null;
  if (job.docsTotal <= 0) return null;
  if (job.docsProcessed < job.docsTotal) return null;
  const hadSuccess = job.docsPassed > 0 || job.docsReviewing > 0;
  return hadSuccess ? "complete" : "failed";
}

export function resolveSince(raw: string | undefined): { cutoff: Date | null } | { error: string } {
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) => {
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
        svMajor: schema.schemaVersions.major,
        svMinor: schema.schemaVersions.minor,
        svPatch: schema.schemaVersions.patch,
        svPrerelease: schema.schemaVersions.prerelease,
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
  const counts = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) => {
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

  const data = rows.map(({ svMajor, svMinor, svPatch, svPrerelease, ...rest }) => ({
    ...rest,
    schemaVersionLabel: formatSemverLabel({ major: svMajor, minor: svMinor, patch: svPatch, prerelease: svPrerelease }),
  }));
  return c.json({ data, nextCursor, counts: { total, byStatus: statusCounts } });
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [row] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    if (tenantId) return withRLS(db, { tenantId, projectId: getProjectId(c) }, fn as any);
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
        // Select the full TraceStageRow shape the dashboard expects —
        // see dashboard/src/lib/api.ts. Previously we omitted half the
        // fields AND emitted them under different keys
        // (`name` instead of `stageName`, `summary` instead of
        // `summaryJson`). When the dashboard merged an SSE-pushed stage
        // into its rows, every read of `stageName`, `stageOrder`, etc.
        // returned `undefined` — `prettyStageName(undefined).replaceAll`
        // then crashed the entire page mid-render. The mismatch was
        // invisible during steady-state polling because the initial
        // /documents/:id payload uses the correct shape; only the
        // SSE-push code path was broken.
        const stages = await query((tx) =>
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
        ) as any[];

        // Emit new stages only — payload is the verbatim TraceStageRow
        // shape from dashboard/src/lib/api.ts. Adding or renaming a
        // field on either side without the other will break this
        // contract silently; keep them aligned.
        for (const stage of stages) {
          if (!sentStageIds.has(stage.id)) {
            sentStageIds.add(stage.id);
            await stream.writeSSE({
              event: "stage",
              data: JSON.stringify({
                id: stage.id,
                stageName: stage.stageName,
                stageOrder: stage.stageOrder,
                status: stage.status,
                startedAt: stage.startedAt,
                completedAt: stage.completedAt,
                durationMs: stage.durationMs,
                summaryJson: stage.summaryJson,
                errorMessage: stage.errorMessage,
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

  const [row] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
        svMajor: schema.schemaVersions.major,
        svMinor: schema.schemaVersions.minor,
        svPatch: schema.schemaVersions.patch,
        svPrerelease: schema.schemaVersions.prerelease,
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
  const { svMajor, svMinor, svPatch, svPrerelease, ...job } = row;
  return c.json({
    ...job,
    schemaVersionLabel: formatSemverLabel({ major: svMajor, minor: svMinor, patch: svPatch, prerelease: svPrerelease }),
  });
});

/**
 * GET /api/jobs/:slug/documents — documents processed by this job.
 */
jobs.get("/:slug/documents", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [job] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.slug, slug))
      .limit(1),
  );
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const docs = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
        fitJson: schema.documents.fitJson,
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

  const [row] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
        fitJson: schema.documents.fitJson,
        startedAt: schema.documents.startedAt,
        completedAt: schema.documents.completedAt,
        createdAt: schema.documents.createdAt,
        jobId: schema.jobs.id,
        jobSlug: schema.jobs.slug,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
        svMajor: schema.schemaVersions.major,
        svMinor: schema.schemaVersions.minor,
        svPatch: schema.schemaVersions.patch,
        svPrerelease: schema.schemaVersions.prerelease,
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

  const [trace] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    ? await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  const stepRuns = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const { svMajor, svMinor, svPatch, svPrerelease, ...doc } = row;
  return c.json({
    ...doc,
    schemaVersionLabel: formatSemverLabel({ major: svMajor, minor: svMinor, patch: svPatch, prerelease: svPrerelease }),
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
  // `skip_cache` forces a fresh parse on the rerun (bypass + refresh the parse
  // cache) — e.g. to reprocess with the same provider, or belt-and-suspenders
  // after switching BYO parse providers.
  const body = await c.req.json<{ skip_cache?: boolean }>().catch(() => ({}) as { skip_cache?: boolean });
  const skipCache = body.skip_cache === true;

  const [doc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.jobs)
      .set({
        status: "running",
        completedAt: null,
      })
      .where(eq(schema.jobs.id, doc.jobId)),
  );

  // Clear old step runs so the DAG runner starts fresh
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.delete(schema.pipelineStepRuns)
      .where(eq(schema.pipelineStepRuns.documentId, doc.documentId)),
  );

  // Route to DAG runner if the pipeline has DAG steps, otherwise legacy
  const [pipeline] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ pipelineType: schema.pipelines.pipelineType })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, doc.pipelineId))
      .limit(1),
  );

  if (pipeline?.pipelineType === "dag") {
    await queue.enqueue(
      "pipeline.dag.run",
      { documentId: doc.documentId, pipelineId: doc.pipelineId, skipCache },
      { tenantId },
    );
  } else {
    await queue.enqueue(
      "ingestion.process",
      { documentId: doc.documentId, skipCache },
      { tenantId },
    );
  }

  return c.json({ ok: true }, 202);
});

/**
 * POST /api/jobs/:slug/documents/:docId/fail — force-fail a stuck document.
 *
 * Manually transitions a document to "failed" status. Used for zombie jobs
 * that got stuck in "extracting" or "parsing" due to worker crashes,
 * timeouts, or other infrastructure failures.
 */
jobs.post("/:slug/documents/:docId/fail", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));
  const reason = body.reason ?? "Manually failed by operator";

  const [doc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.documents.id,
      jobId: schema.documents.jobId,
      status: schema.documents.status,
    })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .where(and(
        eq(schema.documents.id, docId),
        eq(schema.jobs.slug, slug),
      ))
      .limit(1),
  );

  if (!doc) return c.json({ error: "Document not found" }, 404);
  if (doc.status === "failed") return c.json({ error: "Document is already failed" }, 409);

  const now = new Date();
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, async (tx) => {
    await tx.update(schema.documents).set({
      status: "failed",
      validationJson: { error_cause: "force_failed", message: reason },
      completedAt: now,
    }).where(eq(schema.documents.id, docId));

    // Update parent job counters
    await tx.update(schema.jobs).set({
      docsFailed: sql`${schema.jobs.docsFailed} + 1`,
      docsProcessed: sql`${schema.jobs.docsProcessed} + 1`,
    }).where(eq(schema.jobs.id, doc.jobId));

    // Transition the parent job to a terminal state if this was the last
    // outstanding document. The organic completion paths in
    // `ingestion/process.ts` set status + completedAt at the same time
    // they bump the counters because they're handling single-doc jobs
    // and already know they're the last. Force-fail can target any
    // document in any job shape (single, batch, fan-out), so we re-read
    // the row inside the same tx and finalize based on the new counts.
    // Without this the job stays in `running` forever when its only
    // document is force-failed.
    const [refreshed] = await tx.select({
      docsTotal: schema.jobs.docsTotal,
      docsProcessed: schema.jobs.docsProcessed,
      docsPassed: schema.jobs.docsPassed,
      docsReviewing: schema.jobs.docsReviewing,
      status: schema.jobs.status,
    }).from(schema.jobs).where(eq(schema.jobs.id, doc.jobId)).limit(1);

    const nextStatus = nextJobStatusAfterDocFinalize(refreshed);
    if (nextStatus) {
      await tx.update(schema.jobs).set({
        status: nextStatus,
        completedAt: now,
      }).where(eq(schema.jobs.id, doc.jobId));
    }
  });

  return c.json({ ok: true });
});

/**
 * GET /api/jobs/:slug/documents/:docId/preview — stream document file.
 *
 * Auth is handled by the middleware via HMAC-signed time-limited tokens.
 * The token is generated by the trace-detail endpoint and appended as
 * ?token=<expiry_hex>.<hmac_hex>. Tokens expire after 1 hour.
 */
type PreviewStorage = {
  head: (
    key: string,
  ) => Promise<{ contentType: string; size: number } | null>;
  getBuffer: (
    key: string,
  ) => Promise<{ data: Buffer; contentType: string } | null>;
  getRange: (
    key: string,
    start: number,
    end: number,
  ) => Promise<{
    data: Buffer;
    contentType: string;
    totalSize: number;
  } | null>;
};

/**
 * Resolve the storage key to serve for a document. By default prefers the
 * searchable PDF (OCR text layer) when available, otherwise the original —
 * this is what the inline viewer wants so `⌘F` works.
 *
 * When `original` is true, the searchable copy is bypassed entirely and the
 * original bytes are served. The searchable PDF is a derivative (the OCR
 * text layer is added, and for signed PDFs the signature may be stripped),
 * so "Open doc" / download must use this mode to hand back the authoritative
 * source document.
 *
 * Used by the preview handlers below to keep HEAD / range / full responses
 * pointed at the same object.
 */
export async function resolvePreviewKey(
  storage: PreviewStorage,
  storageKey: string,
  original = false,
): Promise<{ key: string; isSearchable: boolean } | null> {
  if (!original) {
    const searchableKey = `${storageKey}.searchable.pdf`;
    const searchable = await storage.head(searchableKey).catch(() => null);
    if (searchable) return { key: searchableKey, isSearchable: true };
  }
  const found = await storage.head(storageKey).catch(() => null);
  if (found) return { key: storageKey, isSearchable: false };
  return null;
}

function previewContentType(
  storageKey: string,
  isSearchable: boolean,
  storedContentType: string,
): string {
  if (isSearchable) return "application/pdf";
  const ext = storageKey.split(".").pop()?.toLowerCase();
  return ext === "pdf"
    ? "application/pdf"
    : ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : storedContentType;
}

/**
 * Parse a `Range: bytes=start-end` header. Returns `null` for unsupported
 * or malformed range specs (multi-range, malformed numbers, out-of-bounds
 * starts) — the caller should then serve the full body. Honours suffix
 * ranges (`bytes=-N` → last N bytes) which pdf.js uses to fetch the xref
 * tail of a PDF.
 *
 * Exported for unit testing — the route handler is the only production
 * caller.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header || !header.startsWith("bytes=")) return null;
  const spec = header.slice("bytes=".length).trim();
  // Multi-range not supported — fall back to full body.
  if (spec.includes(",")) return null;
  const [rawStart, rawEnd] = spec.split("-", 2);
  if (rawStart === "" && rawEnd) {
    // Suffix form: `bytes=-N` → last N bytes.
    const suffix = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = parseInt(rawStart ?? "", 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const end =
    rawEnd && rawEnd.length > 0
      ? Math.min(parseInt(rawEnd, 10), size - 1)
      : size - 1;
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

const PREVIEW_CACHE_CONTROL = "private, max-age=3600";

/**
 * Cap on the number of bytes we serve for a single range request. pdf.js
 * usually asks for ~64KB–1MB chunks; this guards against a client
 * side-stepping the streaming intent by asking for the whole file via
 * `Range:`. The full-body path below has no cap.
 */
const RANGE_BYTE_CAP = 16 * 1024 * 1024;

/**
 * HEAD /api/jobs/:slug/documents/:docId/preview — return metadata only.
 *
 * pdf.js issues a HEAD before its first range request to learn the file's
 * total size and confirm that the server advertises `Accept-Ranges`. With
 * a working HEAD + Accept-Ranges, pdf.js streams the document in chunks
 * (xref tail first, then per-page content) and renders page 1 long before
 * the full file is downloaded. Without it, pdf.js falls back to fetching
 * the whole PDF up front.
 */
jobs.on("HEAD", "/:slug/documents/:docId/preview", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage") as PreviewStorage;
  const docId = c.req.param("docId")!;

  const [doc] = await db
    .select({ storageKey: schema.documents.storageKey })
    .from(schema.documents)
    .where(eq(schema.documents.id, docId))
    .limit(1);

  if (!doc?.storageKey) return c.body(null, 404);

  // `?original=1` serves the source document, bypassing the searchable
  // derivative — used by "Open doc" / download. The inline viewer omits it.
  const original = c.req.query("original") === "1";
  const resolved = await resolvePreviewKey(storage, doc.storageKey, original);
  if (!resolved) return c.body(null, 404);

  const meta = await storage.head(resolved.key);
  if (!meta) return c.body(null, 404);

  const contentType = previewContentType(
    doc.storageKey,
    resolved.isSearchable,
    meta.contentType,
  );

  c.header("Content-Type", contentType);
  c.header("Content-Length", String(meta.size));
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Disposition", "inline");
  c.header("Cache-Control", PREVIEW_CACHE_CONTROL);
  return c.body(null, 200);
});

/**
 * GET /api/jobs/:slug/documents/:docId/preview — stream document file.
 *
 * Honours HTTP `Range:` requests so pdf.js can lazy-load a PDF instead of
 * downloading the whole file before showing page 1. Full-body GETs still
 * work (image previews, browsers without range support, integration
 * scripts).
 *
 * Auth is handled by the middleware via HMAC-signed time-limited tokens.
 * The token is generated by the trace-detail endpoint and appended as
 * ?token=<expiry_hex>.<hmac_hex>. Tokens expire after 1 hour.
 */
jobs.get("/:slug/documents/:docId/preview", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage") as PreviewStorage;
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

  // `?original=1` serves the source document, bypassing the searchable
  // derivative — used by "Open doc" / download. The inline viewer omits it.
  const original = c.req.query("original") === "1";

  try {
    const resolved = await resolvePreviewKey(storage, doc.storageKey, original);
    if (!resolved) return c.json({ error: "File not available" }, 404);

    // head() is a cheap metadata-only S3 call — gives us size + content
    // type without touching any bytes, so we can build response headers
    // before deciding whether to serve a slice or the full body.
    const meta = await storage.head(resolved.key);
    if (!meta) return c.json({ error: "File not available" }, 404);

    const contentType = previewContentType(
      doc.storageKey,
      resolved.isSearchable,
      meta.contentType,
    );

    c.header("Content-Type", contentType);
    c.header("Content-Disposition", "inline");
    c.header("Cache-Control", PREVIEW_CACHE_CONTROL);
    c.header("Accept-Ranges", "bytes");

    const range = parseRangeHeader(c.req.header("Range"), meta.size);
    if (range) {
      const requested = range.end - range.start + 1;
      const end =
        requested > RANGE_BYTE_CAP
          ? range.start + RANGE_BYTE_CAP - 1
          : range.end;
      const slice = await storage.getRange(resolved.key, range.start, end);
      if (!slice) return c.json({ error: "File not available" }, 404);
      c.header("Content-Length", String(slice.data.length));
      c.header(
        "Content-Range",
        `bytes ${range.start}-${end}/${slice.totalSize}`,
      );
      return new Response(slice.data, { status: 206, headers: c.res.headers });
    }

    const file = await storage.getBuffer(resolved.key);
    if (!file) return c.json({ error: "File not available" }, 404);
    c.header("Content-Length", String(file.data.length));
    return new Response(file.data, { headers: c.res.headers });
  } catch {
    return c.json({ error: "File not available in storage" }, 404);
  }
});

/**
 * Best-effort display value for a highlighted field. Prefers the scalar value
 * from extractionJson (string/number/boolean); for fields whose value is an
 * object/array (or missing), falls back to the highlighted words' text so the
 * picker still shows something meaningful. Returns undefined when neither is
 * available.
 */
export function highlightValue(
  extracted: unknown,
  words?: Array<{ text: string }>,
): string | undefined {
  if (typeof extracted === "string") return extracted || undefined;
  if (typeof extracted === "number" || typeof extracted === "boolean") {
    return String(extracted);
  }
  const text = words?.map((w) => w.text).join(" ").trim();
  return text || undefined;
}

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
      extractionJson: schema.documents.extractionJson,
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
    { offset?: number; length?: number; page?: number; bbox?: { x: number; y: number; w: number; h: number }; words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>; reasoning?: string; resolution?: string } | null
  >;
  const extraction = (doc.extractionJson ?? {}) as Record<string, unknown>;

  const highlights = Object.entries(provenance)
    .filter(([, v]) => v && (v.words?.length || (v.bbox && v.page)))
    .map(([field, v]) => ({
      field,
      page: v!.words?.[0]?.page ?? v!.page ?? 1,
      bbox: v!.bbox,
      words: v!.words,
      reasoning: v!.reasoning,
      // The resolution rung, so the embed viewer can render exact vs.
      // best-guess (fuzzy) highlights honestly. See BBoxHighlight.
      resolution: v!.resolution,
      // The extracted value, so the embed's field picker can show
      // "field → value". Prefer the scalar from extractionJson; fall back to
      // the highlighted words' text for fields without a scalar value.
      value: highlightValue(extraction[field], v!.words),
    }));

  return c.json({
    previewUrl,
    highlights,
    filename: doc.filename,
    pageCount: doc.pageCount,
  });
});

/**
 * Validate the resolve-region request body. Exported for tests.
 *
 * Requires an integer page ≥ 1 and a bbox of finite numbers in normalized
 * page space with positive width/height. A rectangle entirely outside the
 * page square can't select anything and is rejected as malformed rather
 * than resolving to an empty match.
 */
export function parseResolveRegionBody(
  body: unknown,
): { page: number; rect: BBox } | null {
  if (!body || typeof body !== "object") return null;
  const page = (body as { page?: unknown }).page;
  const bbox = (body as { bbox?: unknown }).bbox;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (!bbox || typeof bbox !== "object") return null;
  const { x, y, w, h } = bbox as Record<string, unknown>;
  if (
    typeof x !== "number" || typeof y !== "number" ||
    typeof w !== "number" || typeof h !== "number"
  ) return null;
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  if (x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) return null;
  return { page, rect: { x, y, w, h } };
}

/**
 * POST /api/jobs/:slug/documents/:docId/resolve-region — resolve a page
 * region to the text underneath it (highlight-to-correct, oss-373).
 *
 * Body: { page: number, bbox: {x,y,w,h} } — normalized [0,1], top-left
 * origin, page indexed from 1 (the repo-wide bbox contract).
 *
 * Returns { text, words, bbox } snapped to the matched text_map words, or
 * { text: null, words: [], bbox: null } when the selection resolves to
 * nothing (no parse cache, no text_map geometry, or a region over
 * whitespace/graphics). Callers treat text:null as "fall back to typed
 * input" — a correction is never blocked on geometry.
 *
 * Auth mirrors /preview and /embed-data: dual-aware. The middleware accepts
 * either a valid HMAC preview token (embed viewer, external host) or a normal
 * session; token-authed requests carry no tenant on the context, so the read
 * is raw (token-gated) with an explicit tenant check when a session IS
 * present. Stateless — reads the cached parse text_map, no LLM, no writes.
 */
jobs.post("/:slug/documents/:docId/resolve-region", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const slug = c.req.param("slug")!;
  const docId = c.req.param("docId")!;

  const parsed = parseResolveRegionBody(await c.req.json().catch(() => null));
  if (!parsed) {
    return c.json(
      { error: "page (integer ≥ 1) and bbox {x,y,w,h} (normalized, w/h > 0) are required" },
      400,
    );
  }

  const [doc] = await db
    .select({
      tenantId: schema.documents.tenantId,
      contentHash: schema.documents.contentHash,
    })
    .from(schema.documents)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
    .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
    .limit(1);

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }
  // Session-authenticated callers must own the document; token-authenticated
  // callers proved access via the HMAC (which signs this exact doc path).
  const sessionTenant = c.get("tenantId") as string | undefined;
  if (sessionTenant && doc.tenantId !== sessionTenant) {
    return c.json({ error: "Document not found" }, 404);
  }

  const empty = { text: null, words: [], bbox: null };
  if (!doc.contentHash) return c.json(empty);

  // Same lookup as the /markdown endpoint: parse_cache by (tenant,
  // content_hash), most recent row (a file can have one row per parse
  // provider fingerprint since oss-298).
  const [cached] = await db
    .select({ storageKey: schema.parseCache.storageKey })
    .from(schema.parseCache)
    .where(
      and(
        eq(schema.parseCache.tenantId, doc.tenantId),
        eq(schema.parseCache.fileHash, doc.contentHash),
      ),
    )
    .orderBy(desc(schema.parseCache.createdAt))
    .limit(1);
  if (!cached) return c.json(empty);

  const blob = await storage.getBuffer(cached.storageKey);
  if (!blob) return c.json(empty);

  let textMapFlat: FlatTextMapSegment[];
  try {
    const payload = JSON.parse(blob.data.toString()) as { text_map?: unknown };
    textMapFlat = Array.isArray(payload.text_map)
      ? (payload.text_map as FlatTextMapSegment[])
      : [];
  } catch {
    return c.json(empty);
  }
  if (textMapFlat.length === 0) return c.json(empty);

  const match = locateWordsByRegion(
    toProvenanceTextMap(textMapFlat),
    parsed.page,
    parsed.rect,
  );
  if (!match) return c.json(empty);

  // The text_map is immutable per (tenant, file_hash), but the match depends
  // on the request body — don't let intermediaries cache POST responses.
  c.header("Cache-Control", "no-store");
  return c.json(match);
});

/** One validated entry of a corrections request. */
export interface CorrectionInput {
  field: string;
  value: unknown;
  provenance: AnchoredProvenance | null;
}

/** Ceiling on corrections per call — a UI batches one save, not a backfill. */
const MAX_CORRECTIONS = 50;

/**
 * Validate a manual-corrections request body. Exported for tests.
 *
 * Shape: `{ corrections: [{ field, value, provenance? }], note? }` — at least
 * one entry, unique field names, `value` present on every entry (null is a
 * legal correction, a missing key is a mistake), provenance per entry
 * validated with the same rules as a review override.
 */
export function parseCorrectionsBody(
  body: unknown,
): { corrections: CorrectionInput[]; note: string | null } | { error: string } {
  if (!body || typeof body !== "object") return { error: "corrections array is required" };
  const { corrections, note } = body as Record<string, unknown>;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    return { error: "corrections must be a non-empty array" };
  }
  if (corrections.length > MAX_CORRECTIONS) {
    return { error: `at most ${MAX_CORRECTIONS} corrections per request` };
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    return { error: "note must be a string" };
  }
  const seen = new Set<string>();
  const out: CorrectionInput[] = [];
  for (const entry of corrections) {
    if (!entry || typeof entry !== "object") return { error: "each correction must be an object" };
    const e = entry as Record<string, unknown>;
    if (typeof e.field !== "string" || e.field.trim() === "" || e.field.length > 128) {
      return { error: "each correction needs a field name (≤ 128 chars)" };
    }
    if (!Object.hasOwn(e, "value")) {
      return { error: `correction for "${e.field}" is missing a value (use null to clear)` };
    }
    if (seen.has(e.field)) return { error: `duplicate correction for field "${e.field}"` };
    seen.add(e.field);
    const provenance = parseOverrideProvenance(e.provenance);
    if (provenance === "invalid") {
      return {
        error: `correction for "${e.field}": provenance must be { page: integer ≥ 1, bbox: {x,y,w,h}, words?, chunk? }`,
      };
    }
    out.push({ field: e.field, value: e.value, provenance });
  }
  return { corrections: out, note: typeof note === "string" && note.trim() ? note.trim() : null };
}

/**
 * POST /api/jobs/:slug/documents/:docId/corrections — manually correct
 * extracted values on a document, outside the review queue.
 *
 * The review queue only sees what the confidence/validation heuristics flag;
 * this is the path for fixing the confidently-wrong rest. A correction is
 * modeled as an already-resolved review item (`reason: "manual"`, status
 * completed, resolution approved) — one per corrected field — so the audit
 * trail, promote-to-corpus path, and correction analytics all reuse the
 * review machinery. No new tables.
 *
 * Effects, in order:
 *   1. one `reason: "manual"` review item per field (proposedValue = the
 *      value being replaced, finalValue = the correction, resolvedBy = caller)
 *   2. one merge into `documents.extractionJson` (all fields at once)
 *   3. anchored provenance spans (`resolution: "anchored"`) for entries that
 *      carry geometry — same highlight-to-correct semantics as the review UI
 *   4. one `document.corrected` webhook event with previous/new values per
 *      field plus the full corrected extraction, so systems that already
 *      consumed `document.delivered` don't silently diverge.
 *
 * Session or API-key auth with `review:act`. The HMAC preview token is NOT
 * accepted here — it stays read-only; external hosts call this from their
 * backend with an API key.
 */
jobs.post(
  "/:slug/documents/:docId/corrections",
  requires("review:act"),
  requireFeature("hitl_review"),
  async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const principal = getPrincipal(c);
    const slug = c.req.param("slug")!;
    const docId = c.req.param("docId")!;

    const parsed = parseCorrectionsBody(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const [doc] = await withRLS(db, getRlsScope(c), (tx) =>
      tx
        .select({
          id: schema.documents.id,
          schemaId: schema.documents.schemaId,
          extractionJson: schema.documents.extractionJson,
          provenanceJson: schema.documents.provenanceJson,
          jobId: schema.jobs.id,
          jobSlug: schema.jobs.slug,
          projectId: schema.jobs.projectId,
        })
        .from(schema.documents)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
        .where(and(eq(schema.documents.id, docId), eq(schema.jobs.slug, slug)))
        .limit(1),
    );
    if (!doc) return c.json({ error: "Document not found" }, 404);
    if (!doc.schemaId || doc.extractionJson == null) {
      return c.json({ error: "Document has no extraction to correct" }, 422);
    }

    const extraction = doc.extractionJson as Record<string, unknown>;
    // Writes happen under the job's project scope (review items are
    // project-scoped rows; the read above already enforced the caller's
    // access to this document).
    const scope = { tenantId, projectId: doc.projectId };
    const now = new Date();

    const inserted = await withRLS(db, scope, (tx) =>
      tx
        .insert(schema.reviewItems)
        .values(
          parsed.corrections.map((cor) => ({
            tenantId,
            projectId: doc.projectId,
            documentId: doc.id,
            schemaId: doc.schemaId!,
            fieldName: cor.field,
            reason: "manual",
            proposedValue: extraction[cor.field] ?? null,
            status: "completed",
            resolution: "approved",
            finalValue: cor.value,
            resolvedBy: principal.userId,
            resolvedAt: now,
            note: parsed.note,
          })),
        )
        .returning({ id: schema.reviewItems.id }),
    );

    const mergedExtraction = { ...extraction };
    const mergedProvenance = { ...((doc.provenanceJson ?? {}) as Record<string, unknown>) };
    let anchoredCount = 0;
    const changedFields: Record<string, { previous: unknown; value: unknown }> = {};
    for (const cor of parsed.corrections) {
      changedFields[cor.field] = { previous: extraction[cor.field] ?? null, value: cor.value };
      mergedExtraction[cor.field] = cor.value;
      if (cor.provenance) {
        mergedProvenance[cor.field] = buildAnchoredSpan(cor.provenance);
        anchoredCount++;
      }
    }
    await withRLS(db, scope, (tx) =>
      tx
        .update(schema.documents)
        .set({
          extractionJson: mergedExtraction,
          ...(anchoredCount > 0 ? { provenanceJson: mergedProvenance } : {}),
        })
        .where(eq(schema.documents.id, doc.id)),
    );

    await emitWebhookEvent(scope, "document.corrected", {
      document_id: doc.id,
      job_id: doc.jobId,
      job_slug: doc.jobSlug,
      fields: changedFields,
      extraction: mergedExtraction,
      corrected_by: principal.userId,
      corrected_at: now.toISOString(),
    });

    return c.json(
      {
        ok: true,
        reviewItemIds: inserted.map((r) => r.id),
        extraction: mergedExtraction,
      },
      201,
    );
  },
);

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

  const [doc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [cached] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
      // Since oss-298 a file can have multiple cache rows (one per parse
      // provider fingerprint). The document itself doesn't record which
      // fingerprint produced its parse, so show the most recent — it reflects
      // the latest parse provider the tenant ran this file under.
      .orderBy(desc(schema.parseCache.createdAt))
      .limit(1),
  );

  if (!cached) {
    return c.json({ error: "No cached markdown for this document" }, 404);
  }

  const blob = await storage.getBuffer(cached.storageKey);
  if (!blob) {
    return c.json({ error: "Cache blob missing from storage" }, 404);
  }

  let payload: { markdown?: string; pages?: number; ocr_skipped?: boolean; engine?: string };
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
    // Which parser handled the document. Older cache entries (written before
    // the engine field landed) don't carry this; returns null in that case.
    engine: payload.engine ?? null,
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

  const [doc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  const [doc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

