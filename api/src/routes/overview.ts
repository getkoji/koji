import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";

export const overview = new Hono<Env>();

/**
 * GET /api/overview — single-query tenant overview.
 *
 * One SQL round-trip returns all metrics, recent activity, attention items,
 * and onboarding state. The query runs as a CTE pipeline inside withRLS so
 * tenant isolation is enforced at the row level.
 */
overview.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const [result] = await withRLS(db, tenantId, (tx) =>
    tx.execute(sql`
      WITH
        metrics AS (
          SELECT
            (SELECT (accuracy * 100)::float FROM schema_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1) AS accuracy,
            (SELECT count(*)::int FROM documents d JOIN schemas s ON s.id = d.schema_id WHERE s.deleted_at IS NULL) AS documents_processed,
            (SELECT count(*)::int FROM review_items WHERE status = 'pending') AS review_pending,
            (SELECT count(*)::int FROM pipelines WHERE status = 'active') AS pipelines_active,
            (SELECT count(*)::int FROM schemas WHERE deleted_at IS NULL) AS schema_count
        ),

        recent_jobs AS (
          SELECT slug, status, docs_total, docs_passed,
                 coalesce(completed_at, created_at) AS ts, created_at
          FROM jobs ORDER BY created_at DESC LIMIT 5
        ),

        recent_versions AS (
          SELECT sv.version_number, sv.commit_message, sv.created_at AS ts,
                 s.slug AS schema_slug, s.display_name AS schema_name
          FROM schema_versions sv
          JOIN schemas s ON s.id = sv.schema_id
          ORDER BY sv.created_at DESC LIMIT 5
        ),

        recent_reviews AS (
          SELECT ri.id, ri.field_name, ri.resolution, ri.resolved_at AS ts,
                 s.slug AS schema_slug
          FROM review_items ri
          JOIN schemas s ON s.id = ri.schema_id
          WHERE ri.status != 'pending' AND ri.resolved_at IS NOT NULL
          ORDER BY ri.resolved_at DESC LIMIT 5
        ),

        recent_corpus AS (
          SELECT ce.id, ce.filename, ce.created_at AS ts,
                 s.slug AS schema_slug
          FROM corpus_entries ce
          JOIN schemas s ON s.id = ce.schema_id
          ORDER BY ce.created_at DESC LIMIT 5
        ),

        attention_failed_jobs AS (
          SELECT count(*)::int AS count FROM jobs WHERE status = 'failed'
        ),

        attention_latest_validate AS (
          SELECT regressions_count, schema_id
          FROM schema_runs
          WHERE status = 'completed' AND run_type = 'validate'
          ORDER BY created_at DESC LIMIT 1
        ),

        attention_unlinked_pipelines AS (
          SELECT count(*)::int AS count
          FROM pipelines
          WHERE status = 'active' AND active_schema_version_id IS NULL
        ),

        attention_no_corpus AS (
          SELECT count(*)::int AS count
          FROM schemas s
          WHERE s.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM corpus_entries c WHERE c.schema_id = s.id)
        ),

        onboarding AS (
          SELECT
            (SELECT slug FROM schemas WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1) AS first_schema_slug,
            (SELECT count(*)::int > 0 FROM corpus_entries) AS has_corpus,
            (SELECT count(*)::int > 0 FROM extraction_runs) AS has_extraction,
            (SELECT count(*)::int > 0 FROM corpus_entries
              WHERE ground_truth_json IS NOT NULL
                AND jsonb_typeof(ground_truth_json) = 'object'
                AND ground_truth_json::text != '{}') AS has_ground_truth,
            (SELECT count(*)::int > 0 FROM schema_runs
              WHERE status = 'completed' AND run_type = 'validate') AS has_validate,
            (SELECT count(*)::int > 0 FROM pipelines) AS has_pipeline
        ),

        failed_recent AS (
          SELECT count(*)::int AS count
          FROM jobs
          WHERE status = 'failed' AND created_at >= now() - interval '24 hours'
        )

      SELECT jsonb_build_object(
        'metrics', (SELECT row_to_json(metrics) FROM metrics),
        'recentJobs', (SELECT coalesce(jsonb_agg(row_to_json(recent_jobs) ORDER BY ts DESC), '[]'::jsonb) FROM recent_jobs),
        'recentVersions', (SELECT coalesce(jsonb_agg(row_to_json(recent_versions) ORDER BY ts DESC), '[]'::jsonb) FROM recent_versions),
        'recentReviews', (SELECT coalesce(jsonb_agg(row_to_json(recent_reviews) ORDER BY ts DESC), '[]'::jsonb) FROM recent_reviews),
        'recentCorpus', (SELECT coalesce(jsonb_agg(row_to_json(recent_corpus) ORDER BY ts DESC), '[]'::jsonb) FROM recent_corpus),
        'failedJobsCount', (SELECT count FROM attention_failed_jobs),
        'latestValidate', (SELECT row_to_json(attention_latest_validate) FROM attention_latest_validate),
        'unlinkedPipelinesCount', (SELECT count FROM attention_unlinked_pipelines),
        'noCorpusCount', (SELECT count FROM attention_no_corpus),
        'onboarding', (SELECT row_to_json(onboarding) FROM onboarding),
        'failedRecentCount', (SELECT count FROM failed_recent)
      ) AS data
    `),
  );

  const d = (result as any).data;
  const m = d.metrics;

  // ── Build activity feed ───────────────────────────────────────────────

  type ActivityItem = {
    type: string;
    timestamp: string;
    description: string;
    link: string;
    status?: string;
    meta?: string;
  };

  const activity: ActivityItem[] = [];

  for (const j of d.recentJobs) {
    if (j.status === "completed") {
      const rate = j.docs_total > 0 ? (j.docs_passed / j.docs_total) * 100 : 0;
      activity.push({
        type: "job.completed",
        timestamp: j.ts,
        description: `Job completed: ${j.slug}`,
        meta: `${j.docs_total} ${j.docs_total === 1 ? "doc" : "docs"}, ${rate.toFixed(1)}% pass`,
        status: "ok",
        link: `/jobs/${j.slug}`,
      });
    } else if (j.status === "failed") {
      activity.push({
        type: "job.failed",
        timestamp: j.ts,
        description: `Job failed: ${j.slug}`,
        meta: `${j.docs_total} ${j.docs_total === 1 ? "doc" : "docs"}`,
        status: "warn",
        link: `/jobs/${j.slug}`,
      });
    }
  }

  for (const v of d.recentVersions) {
    activity.push({
      type: "schema.versioned",
      timestamp: v.ts,
      description: `Schema ${v.schema_slug} committed v${v.version_number}`,
      meta: v.commit_message ?? undefined,
      status: "ok",
      link: `/schemas/${v.schema_slug}/build`,
    });
  }

  for (const r of d.recentReviews) {
    activity.push({
      type: "review.resolved",
      timestamp: r.ts,
      description: `Review resolved on ${r.field_name}`,
      meta: r.resolution ?? undefined,
      status: "ok",
      link: `/review`,
    });
  }

  for (const ce of d.recentCorpus) {
    activity.push({
      type: "corpus.added",
      timestamp: ce.ts,
      description: `Corpus entry added: ${ce.filename}`,
      status: "ok",
      link: `/schemas/${ce.schema_slug}/corpus`,
    });
  }

  activity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // ── Attention items ───────────────────────────────────────────────────

  type AttentionItem = {
    severity: string;
    kind: string;
    description: string;
    link: string;
  };

  const attention: AttentionItem[] = [];

  if (m.review_pending > 0) {
    attention.push({
      severity: "warning",
      kind: "Review queue",
      description: `${m.review_pending} ${m.review_pending === 1 ? "document" : "documents"} waiting for review.`,
      link: `/review`,
    });
  }

  if (d.failedJobsCount > 0) {
    attention.push({
      severity: "warning",
      kind: "Failed jobs",
      description: `${d.failedJobsCount} ${d.failedJobsCount === 1 ? "job has" : "jobs have"} failed. Check logs.`,
      link: `/jobs?status=failed`,
    });
  }

  if (d.latestValidate?.regressions_count > 0) {
    // Look up schema slug for the validate run
    const validateSchemaId = d.latestValidate.schema_id;
    const [slugRow] = await withRLS(db, tenantId, (tx) =>
      tx.execute(sql`SELECT slug FROM schemas WHERE id = ${validateSchemaId} LIMIT 1`),
    );
    if (slugRow) {
      attention.push({
        severity: "warning",
        kind: "Validate regression",
        description: `Latest validate run caught ${d.latestValidate.regressions_count} regression(s).`,
        link: `/schemas/${(slugRow as any).slug}/validate`,
      });
    }
  }

  if (d.unlinkedPipelinesCount > 0) {
    attention.push({
      severity: "warning",
      kind: "Unlinked pipeline",
      description: `${d.unlinkedPipelinesCount} active pipeline(s) have no deployed schema version.`,
      link: `/pipelines`,
    });
  }

  if (d.noCorpusCount > 0) {
    attention.push({
      severity: "info",
      kind: "Schema needs corpus",
      description: `${d.noCorpusCount} schema(s) have no corpus entries to measure against.`,
      link: `/`,
    });
  }

  // ── Onboarding ────────────────────────────────────────────────────────

  const ob = d.onboarding;
  const onboarding = {
    schemaCreated: m.schema_count > 0,
    documentUploaded: ob.has_corpus,
    extractionRun: ob.has_extraction,
    corpusEntries: ob.has_ground_truth,
    validateRun: ob.has_validate,
    pipelineConfigured: ob.has_pipeline,
    firstSchemaSlug: ob.first_schema_slug,
  };

  // ── Accent line ───────────────────────────────────────────────────────

  let accentLine: string;
  if (d.failedRecentCount > 0) {
    accentLine = "Something needs attention.";
  } else if (d.latestValidate?.regressions_count > 0) {
    accentLine = "Regression caught.";
  } else if (m.review_pending > 0) {
    accentLine = "Waiting on you.";
  } else if (!onboarding.schemaCreated && !onboarding.documentUploaded && m.documents_processed === 0) {
    accentLine = "Ready when you are.";
  } else {
    accentLine = "Quietly working.";
  }

  return c.json({
    metrics: {
      accuracy: m.accuracy,
      documentsProcessed: m.documents_processed,
      reviewPending: m.review_pending,
      pipelinesActive: m.pipelines_active,
      schemaCount: m.schema_count,
    },
    recentActivity: activity.slice(0, 10),
    needsAttention: attention,
    onboarding,
    accentLine,
  });
});
