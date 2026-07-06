import { Hono } from "hono";
import { and, eq, desc, gte, lt, ilike, sql, type SQL } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getProjectId } from "../auth/middleware";
import { resolveSince } from "./jobs";

export const documents = new Hono<Env>();

/**
 * Clamp the `limit` query param to a sane page size. Exported for tests.
 */
export function clampLimit(raw: string | undefined, fallback = 50, max = 200): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * GET /api/documents — the tenant/project-wide document list.
 *
 * Documents were previously reachable only through the job that ingested
 * them; this endpoint makes them findable directly — the entry point for
 * correction workflows ("find this document and fix it") and the data source
 * for the dashboard's Documents page.
 *
 * Query params (all optional):
 *   - search    — filename substring (case-insensitive)
 *   - status    — exact document status (delivered / review / failed / …)
 *   - pipeline  — pipeline slug
 *   - since     — shorthand (`today` | `7d` | `30d` | `all`) or ISO timestamp
 *   - cursor    — ISO timestamp from a previous page's `nextCursor`
 *   - limit     — page size (default 50, max 200)
 *
 * Project scoping: documents carry no project column — the owning job does.
 * The inner join on jobs puts every row behind the jobs RLS policy, so a
 * project-scoped request only sees documents whose job is in that project.
 *
 * Response: `{ data, nextCursor, counts: { total, byStatus } }` — same
 * envelope as GET /api/jobs. `hasPendingReview` marks documents with open
 * review items (the "needs attention" facet).
 */
documents.get("/", requires("job:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const limit = clampLimit(c.req.query("limit"));
  const status = c.req.query("status");
  const pipelineSlug = c.req.query("pipeline");
  const search = c.req.query("search")?.trim();
  const cursor = c.req.query("cursor");

  const since = resolveSince(c.req.query("since"));
  if ("error" in since) return c.json({ error: since.error }, 400);

  const baseConditions: SQL[] = [];
  if (status) baseConditions.push(eq(schema.documents.status, status));
  if (pipelineSlug) baseConditions.push(eq(schema.pipelines.slug, pipelineSlug));
  if (search) baseConditions.push(ilike(schema.documents.filename, `%${search}%`));
  if (since.cutoff) baseConditions.push(gte(schema.documents.createdAt, since.cutoff));

  const conditions = [...baseConditions];
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate.getTime())) {
      conditions.push(lt(schema.documents.createdAt, cursorDate));
    }
  }

  const scope = { tenantId, projectId: getProjectId(c) };
  const rows = await withRLS(db, scope, (tx) => {
    const base = tx
      .select({
        id: schema.documents.id,
        filename: schema.documents.filename,
        status: schema.documents.status,
        mimeType: schema.documents.mimeType,
        pageCount: schema.documents.pageCount,
        confidence: schema.documents.confidence,
        createdAt: schema.documents.createdAt,
        completedAt: schema.documents.completedAt,
        jobSlug: schema.jobs.slug,
        pipelineSlug: schema.pipelines.slug,
        pipelineName: schema.pipelines.displayName,
        schemaName: schema.schemas.displayName,
        hasPendingReview: sql<boolean>`EXISTS (
          SELECT 1 FROM ${schema.reviewItems}
          WHERE ${schema.reviewItems.documentId} = ${schema.documents.id}
            AND ${schema.reviewItems.status} = 'pending'
        )`,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.documents.schemaId));

    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    return filtered.orderBy(desc(schema.documents.createdAt)).limit(limit);
  });

  const nextCursor =
    rows.length >= limit && rows.length > 0
      ? (rows[rows.length - 1]!.createdAt as Date).toISOString()
      : null;

  // Per-status counts over the base filters (no cursor) so the facet bar
  // reflects the whole filtered set, not the current page.
  const counts = await withRLS(db, scope, (tx) => {
    const base = tx
      .select({
        status: schema.documents.status,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.documents)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId));

    const filtered = baseConditions.length > 0 ? base.where(and(...baseConditions)) : base;
    return filtered.groupBy(schema.documents.status);
  });

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of counts) {
    byStatus[row.status] = row.count;
    total += row.count;
  }

  return c.json({ data: rows, nextCursor, counts: { total, byStatus } });
});
