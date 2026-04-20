import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const overview = new Hono<Env>();

type ActivityItem = {
  type:
    | "job.completed"
    | "job.failed"
    | "schema.versioned"
    | "review.resolved"
    | "pipeline.updated"
    | "corpus.added";
  timestamp: string;
  description: string;
  link: string;
  status?: "ok" | "warn" | "pending";
  meta?: string;
};

type AttentionItem = {
  severity: "warning" | "info";
  kind: string;
  description: string;
  link: string;
};

/**
 * GET /api/overview — aggregate tenant-level overview payload.
 *
 * Returns metrics, recent activity, and attention items in a single roundtrip
 * so the overview page lands in one request. Every value comes from live
 * queries; missing data shows as null/0 on the client.
 */
overview.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  // ── Metrics ────────────────────────────────────────────────────────────

  const [latestRun] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ accuracy: schema.schemaRuns.accuracy })
      .from(schema.schemaRuns)
      .where(eq(schema.schemaRuns.status, "completed"))
      .orderBy(desc(schema.schemaRuns.createdAt))
      .limit(1),
  );
  const accuracy =
    latestRun?.accuracy != null ? Number(latestRun.accuracy) * 100 : null;

  const [docsCount] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.documents),
  );

  const [pendingReview] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reviewItems)
      .where(eq(schema.reviewItems.status, "pending")),
  );

  const [activePipelines] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.status, "active")),
  );

  const [schemaCount] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.schemas)
      .where(sql`deleted_at IS NULL`),
  );

  const metrics = {
    accuracy,
    documentsProcessed: docsCount?.count ?? 0,
    reviewPending: pendingReview?.count ?? 0,
    pipelinesActive: activePipelines?.count ?? 0,
    schemaCount: schemaCount?.count ?? 0,
  };

  // ── Recent activity ────────────────────────────────────────────────────
  // Pull a handful from each source, merge, sort by timestamp desc,
  // trim to 10.

  const recentJobs = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        slug: schema.jobs.slug,
        status: schema.jobs.status,
        docsTotal: schema.jobs.docsTotal,
        docsPassed: schema.jobs.docsPassed,
        completedAt: schema.jobs.completedAt,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(5),
  );

  const recentSchemaVersions = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        versionNumber: schema.schemaVersions.versionNumber,
        commitMessage: schema.schemaVersions.commitMessage,
        createdAt: schema.schemaVersions.createdAt,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
      })
      .from(schema.schemaVersions)
      .innerJoin(
        schema.schemas,
        eq(schema.schemas.id, schema.schemaVersions.schemaId),
      )
      .orderBy(desc(schema.schemaVersions.createdAt))
      .limit(5),
  );

  const recentReviewResolved = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.reviewItems.id,
        fieldName: schema.reviewItems.fieldName,
        resolution: schema.reviewItems.resolution,
        resolvedAt: schema.reviewItems.resolvedAt,
        schemaSlug: schema.schemas.slug,
      })
      .from(schema.reviewItems)
      .innerJoin(
        schema.schemas,
        eq(schema.schemas.id, schema.reviewItems.schemaId),
      )
      .where(sql`${schema.reviewItems.status} != 'pending'`)
      .orderBy(desc(schema.reviewItems.resolvedAt))
      .limit(5),
  );

  const recentCorpus = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        createdAt: schema.corpusEntries.createdAt,
        schemaSlug: schema.schemas.slug,
      })
      .from(schema.corpusEntries)
      .innerJoin(
        schema.schemas,
        eq(schema.schemas.id, schema.corpusEntries.schemaId),
      )
      .orderBy(desc(schema.corpusEntries.createdAt))
      .limit(5),
  );

  const activity: ActivityItem[] = [];

  for (const j of recentJobs) {
    const ts = j.completedAt ?? j.createdAt;
    if (j.status === "completed") {
      const rate = j.docsTotal > 0 ? (j.docsPassed / j.docsTotal) * 100 : 0;
      activity.push({
        type: "job.completed",
        timestamp: ts.toISOString(),
        description: `Job completed: ${j.slug}`,
        meta: `${j.docsTotal} ${j.docsTotal === 1 ? "doc" : "docs"}, ${rate.toFixed(1)}% pass`,
        status: "ok",
        link: `/jobs/${j.slug}`,
      });
    } else if (j.status === "failed") {
      activity.push({
        type: "job.failed",
        timestamp: ts.toISOString(),
        description: `Job failed: ${j.slug}`,
        meta: `${j.docsTotal} ${j.docsTotal === 1 ? "doc" : "docs"}`,
        status: "warn",
        link: `/jobs/${j.slug}`,
      });
    }
  }

  for (const v of recentSchemaVersions) {
    activity.push({
      type: "schema.versioned",
      timestamp: v.createdAt.toISOString(),
      description: `Schema ${v.schemaSlug} committed v${v.versionNumber}`,
      meta: v.commitMessage ?? undefined,
      status: "ok",
      link: `/schemas/${v.schemaSlug}/build`,
    });
  }

  for (const r of recentReviewResolved) {
    if (!r.resolvedAt) continue;
    activity.push({
      type: "review.resolved",
      timestamp: r.resolvedAt.toISOString(),
      description: `Review resolved on ${r.fieldName}`,
      meta: r.resolution ?? undefined,
      status: "ok",
      link: `/review`,
    });
  }

  for (const cEntry of recentCorpus) {
    activity.push({
      type: "corpus.added",
      timestamp: cEntry.createdAt.toISOString(),
      description: `Corpus entry added: ${cEntry.filename}`,
      status: "ok",
      link: `/schemas/${cEntry.schemaSlug}/corpus`,
    });
  }

  activity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const recentActivity = activity.slice(0, 10);

  // ── Attention items ────────────────────────────────────────────────────

  const attention: AttentionItem[] = [];

  if ((pendingReview?.count ?? 0) > 0) {
    const n = pendingReview!.count;
    attention.push({
      severity: "warning",
      kind: "Review queue",
      description: `${n} ${n === 1 ? "document" : "documents"} waiting for review.`,
      link: `/review`,
    });
  }

  const [failedJobs] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "failed")),
  );
  if ((failedJobs?.count ?? 0) > 0) {
    const n = failedJobs!.count;
    attention.push({
      severity: "warning",
      kind: "Failed jobs",
      description: `${n} ${n === 1 ? "job has" : "jobs have"} failed. Check logs.`,
      link: `/jobs?status=failed`,
    });
  }

  const [latestValidate] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        regressionsCount: schema.schemaRuns.regressionsCount,
        schemaId: schema.schemaRuns.schemaId,
      })
      .from(schema.schemaRuns)
      .where(
        and(
          eq(schema.schemaRuns.status, "completed"),
          eq(schema.schemaRuns.runType, "validate"),
        ),
      )
      .orderBy(desc(schema.schemaRuns.createdAt))
      .limit(1),
  );
  if (latestValidate && latestValidate.regressionsCount > 0) {
    const [slugRow] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ slug: schema.schemas.slug })
        .from(schema.schemas)
        .where(eq(schema.schemas.id, latestValidate.schemaId))
        .limit(1),
    );
    if (slugRow) {
      attention.push({
        severity: "warning",
        kind: "Validate regression",
        description: `Latest validate run on ${slugRow.slug} caught ${latestValidate.regressionsCount} ${latestValidate.regressionsCount === 1 ? "regression" : "regressions"}.`,
        link: `/schemas/${slugRow.slug}/validate`,
      });
    }
  }

  const pipelinesNoSchema = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelines)
      .where(
        and(
          eq(schema.pipelines.status, "active"),
          isNull(schema.pipelines.activeSchemaVersionId),
        ),
      ),
  );
  if ((pipelinesNoSchema[0]?.count ?? 0) > 0) {
    const n = pipelinesNoSchema[0]!.count;
    attention.push({
      severity: "warning",
      kind: "Unlinked pipeline",
      description: `${n} active ${n === 1 ? "pipeline has" : "pipelines have"} no deployed schema version.`,
      link: `/pipelines`,
    });
  }

  const schemasNoCorpus = await withRLS(db, tenantId, (tx) =>
    tx.execute(sql`
      SELECT s.slug FROM schemas s
      WHERE s.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM corpus_entries c WHERE c.schema_id = s.id
        )
    `),
  );
  const noCorpusRows = (schemasNoCorpus as unknown as { rows?: { slug: string }[] })
    .rows ?? (schemasNoCorpus as unknown as { slug: string }[]);
  const noCorpusCount = Array.isArray(noCorpusRows) ? noCorpusRows.length : 0;
  if (noCorpusCount > 0) {
    attention.push({
      severity: "info",
      kind: "Schema needs corpus",
      description: `${noCorpusCount} ${noCorpusCount === 1 ? "schema has" : "schemas have"} no corpus entries to measure against.`,
      link: `/`,
    });
  }

  // ── Onboarding checklist ───────────────────────────────────────────────
  // Each step reflects real data. Shown in the UI when the activity feed is
  // empty, so a fresh project lands on a guided setup instead of a blank
  // panel.

  const [firstSchema] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ slug: schema.schemas.slug })
      .from(schema.schemas)
      .where(sql`deleted_at IS NULL`)
      .orderBy(schema.schemas.createdAt)
      .limit(1),
  );

  const [anyCorpus] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.corpusEntries),
  );

  const [anyExtraction] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.extractionRuns),
  );

  const [anyGroundTruth] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.corpusEntries)
      .where(
        sql`${schema.corpusEntries.groundTruthJson} IS NOT NULL
            AND jsonb_typeof(${schema.corpusEntries.groundTruthJson}) = 'object'
            AND ${schema.corpusEntries.groundTruthJson}::text != '{}'`,
      ),
  );

  const [anyValidate] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.schemaRuns)
      .where(
        and(
          eq(schema.schemaRuns.status, "completed"),
          eq(schema.schemaRuns.runType, "validate"),
        ),
      ),
  );

  const [anyPipeline] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelines),
  );

  const onboarding = {
    schemaCreated: (schemaCount?.count ?? 0) > 0,
    documentUploaded: (anyCorpus?.count ?? 0) > 0,
    extractionRun: (anyExtraction?.count ?? 0) > 0,
    corpusEntries: (anyGroundTruth?.count ?? 0) > 0,
    validateRun: (anyValidate?.count ?? 0) > 0,
    pipelineConfigured: (anyPipeline?.count ?? 0) > 0,
    firstSchemaSlug: firstSchema?.slug ?? null,
  };

  return c.json({
    metrics,
    recentActivity,
    needsAttention: attention,
    onboarding,
  });
});
