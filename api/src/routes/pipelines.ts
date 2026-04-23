import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { RetryPolicy } from "@koji/types/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { requireUploadRateLimit } from "../billing/rate-limits";
import { requireConcurrencySlot } from "../billing/concurrency";
import { emitWebhookEvent } from "../webhooks/emit";
import { createExtractionJob, mimeTypeFor } from "../ingestion/process";

/**
 * Narrow an unknown body into a {@link RetryPolicy}. Returns the validated
 * policy on success, or an error message on failure. All four fields are
 * required; partial updates are out of scope for the initial cut.
 */
function validateRetryPolicy(input: unknown): RetryPolicy | { error: string } {
  if (input === null || typeof input !== "object") {
    return { error: "retry policy must be an object" };
  }
  const obj = input as Record<string, unknown>;
  const { maxAttempts, backoffBaseMs, backoffMaxMs, retryTransient } = obj;

  if (typeof maxAttempts !== "number" || !Number.isFinite(maxAttempts) || maxAttempts < 1) {
    return { error: "maxAttempts must be a positive number" };
  }
  if (
    typeof backoffBaseMs !== "number" ||
    !Number.isFinite(backoffBaseMs) ||
    backoffBaseMs <= 0
  ) {
    return { error: "backoffBaseMs must be a positive number" };
  }
  if (
    typeof backoffMaxMs !== "number" ||
    !Number.isFinite(backoffMaxMs) ||
    backoffMaxMs <= 0
  ) {
    return { error: "backoffMaxMs must be a positive number" };
  }
  if (backoffMaxMs < backoffBaseMs) {
    return { error: "backoffMaxMs must be >= backoffBaseMs" };
  }
  if (typeof retryTransient !== "boolean") {
    return { error: "retryTransient must be a boolean" };
  }

  return { maxAttempts, backoffBaseMs, backoffMaxMs, retryTransient };
}

export const pipelinesRouter = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the pipeline UUID from a URL segment that may be either a UUID or a slug.
 * Slugs are unique per (tenant, slug) among non-deleted rows.
 */
async function resolvePipelineId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  tenantId: string,
  idOrSlug: string,
): Promise<string | null> {
  if (UUID_RE.test(idOrSlug)) return idOrSlug;
  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.pipelines.id })
      .from(schema.pipelines)
      .where(and(eq(schema.pipelines.slug, idOrSlug), sql`deleted_at IS NULL`))
      .limit(1),
  );
  return row?.id ?? null;
}

/**
 * GET /api/pipelines — list pipelines for the current tenant.
 * Joins schema + deployed version + model endpoint for display, and folds in
 * per-pipeline job stats (total docs + success rate) in a single round trip.
 */
pipelinesRouter.get("/", requires("pipeline:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelines.id,
        slug: schema.pipelines.slug,
        displayName: schema.pipelines.displayName,
        schemaId: schema.pipelines.schemaId,
        activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
        modelProviderId: schema.pipelines.modelProviderId,
        reviewThreshold: schema.pipelines.reviewThreshold,
        status: schema.pipelines.status,
        triggerType: schema.pipelines.triggerType,
        lastRunAt: schema.pipelines.lastRunAt,
        createdAt: schema.pipelines.createdAt,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        deployedVersion: schema.schemaVersions.versionNumber,
        modelProviderName: schema.modelEndpoints.displayName,
        modelProviderModel: schema.modelEndpoints.model,
      })
      .from(schema.pipelines)
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.pipelines.schemaId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.pipelines.activeSchemaVersionId),
      )
      .leftJoin(
        schema.modelEndpoints,
        eq(schema.modelEndpoints.id, schema.pipelines.modelProviderId),
      )
      .where(sql`${schema.pipelines.deletedAt} IS NULL`)
      .orderBy(schema.pipelines.createdAt),
  );

  // Aggregate per-pipeline job stats in a single query
  const stats = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        pipelineId: schema.jobs.pipelineId,
        docsTotal: sql<number>`COALESCE(SUM(${schema.jobs.docsTotal}), 0)::int`,
        docsPassed: sql<number>`COALESCE(SUM(${schema.jobs.docsPassed}), 0)::int`,
        docsFailed: sql<number>`COALESCE(SUM(${schema.jobs.docsFailed}), 0)::int`,
      })
      .from(schema.jobs)
      .groupBy(schema.jobs.pipelineId),
  );
  const statsByPipeline = new Map(stats.map((s) => [s.pipelineId, s]));

  const enriched = rows.map((row) => {
    const s = statsByPipeline.get(row.id);
    return {
      ...row,
      docsTotal: s?.docsTotal ?? 0,
      docsPassed: s?.docsPassed ?? 0,
      docsFailed: s?.docsFailed ?? 0,
    };
  });

  return c.json({ data: enriched });
});

/**
 * GET /api/pipelines/:idOrSlug — pipeline detail.
 * The path segment may be a UUID (existing callers) or a slug (the dashboard's
 * URL convention). Both resolve to the same response.
 */
pipelinesRouter.get("/:idOrSlug", requires("pipeline:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const idOrSlug = c.req.param("idOrSlug")!;
  const pipelineId = await resolvePipelineId(db, tenantId, idOrSlug);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelines.id,
        slug: schema.pipelines.slug,
        displayName: schema.pipelines.displayName,
        schemaId: schema.pipelines.schemaId,
        activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
        modelProviderId: schema.pipelines.modelProviderId,
        configJson: schema.pipelines.configJson,
        retryPolicyJson: schema.pipelines.retryPolicyJson,
        reviewThreshold: schema.pipelines.reviewThreshold,
        yamlSource: schema.pipelines.yamlSource,
        triggerType: schema.pipelines.triggerType,
        triggerConfigJson: schema.pipelines.triggerConfigJson,
        status: schema.pipelines.status,
        lastRunAt: schema.pipelines.lastRunAt,
        createdBy: schema.pipelines.createdBy,
        createdAt: schema.pipelines.createdAt,
        updatedAt: schema.pipelines.updatedAt,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        modelProviderName: schema.modelEndpoints.displayName,
        modelProviderModel: schema.modelEndpoints.model,
        creatorEmail: schema.users.email,
        creatorName: schema.users.name,
      })
      .from(schema.pipelines)
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.pipelines.schemaId))
      .leftJoin(
        schema.modelEndpoints,
        eq(schema.modelEndpoints.id, schema.pipelines.modelProviderId),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.pipelines.createdBy))
      .where(and(eq(schema.pipelines.id, pipelineId), sql`${schema.pipelines.deletedAt} IS NULL`))
      .limit(1),
  );

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  // Deployed version details
  let deployedVersion:
    | { id: string; number: number; commitMessage: string | null; deployedAt: Date }
    | null = null;
  if (pipeline.activeSchemaVersionId) {
    const activeVersionId = pipeline.activeSchemaVersionId;
    const [sv] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({
          id: schema.schemaVersions.id,
          versionNumber: schema.schemaVersions.versionNumber,
          commitMessage: schema.schemaVersions.commitMessage,
          createdAt: schema.schemaVersions.createdAt,
        })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.id, activeVersionId))
        .limit(1),
    );
    if (sv) {
      deployedVersion = {
        id: sv.id,
        number: sv.versionNumber,
        commitMessage: sv.commitMessage,
        deployedAt: sv.createdAt,
      };
    }
  }

  // Connected sources
  const connectedSources = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.sources.id,
        slug: schema.sources.slug,
        displayName: schema.sources.displayName,
        sourceType: schema.sources.sourceType,
        status: schema.sources.status,
        lastIngestedAt: schema.sources.lastIngestedAt,
      })
      .from(schema.sources)
      .where(
        and(
          eq(schema.sources.targetPipelineId, pipelineId),
          sql`${schema.sources.deletedAt} IS NULL`,
        ),
      ),
  );

  // Recent jobs (last 10)
  const recentJobs = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.jobs.id,
        slug: schema.jobs.slug,
        status: schema.jobs.status,
        docsTotal: schema.jobs.docsTotal,
        docsProcessed: schema.jobs.docsProcessed,
        docsPassed: schema.jobs.docsPassed,
        docsFailed: schema.jobs.docsFailed,
        avgLatencyMs: schema.jobs.avgLatencyMs,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.pipelineId, pipelineId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(10),
  );

  // Per-pipeline rollup
  const [stats] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        docsTotal: sql<number>`COALESCE(SUM(${schema.jobs.docsTotal}), 0)::int`,
        docsPassed: sql<number>`COALESCE(SUM(${schema.jobs.docsPassed}), 0)::int`,
        docsFailed: sql<number>`COALESCE(SUM(${schema.jobs.docsFailed}), 0)::int`,
        jobCount: sql<number>`COUNT(*)::int`,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.pipelineId, pipelineId)),
  );

  // `retryPolicyJson` is stored as jsonb; surface it as a typed `retryPolicy`
  // field (null = fall back to platform defaults).
  const retryPolicy = (pipeline.retryPolicyJson ?? null) as RetryPolicy | null;

  return c.json({
    ...pipeline,
    retryPolicy,
    deployedVersion,
    connectedSources,
    recentJobs,
    stats: stats ?? { docsTotal: 0, docsPassed: 0, docsFailed: 0, jobCount: 0 },
  });
});

/**
 * POST /api/pipelines — create a pipeline.
 */
pipelinesRouter.post(
  "/",
  requires("pipeline:write"),
  requireQuantityGate("max_pipelines", async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const [row] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(schema.pipelines).where(sql`deleted_at IS NULL`),
    );
    return row?.count ?? 0;
  }),
  async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);

  const body = await c.req.json<{
    name: string;
    slug: string;
    schema_id?: string;
    model_provider_id?: string;
    review_threshold?: number;
    config?: Record<string, unknown>;
  }>();

  if (!body.name || !body.slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.pipelines)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.name,
        schemaId: body.schema_id ?? null,
        modelProviderId: body.model_provider_id ?? null,
        reviewThreshold: body.review_threshold?.toString() ?? "0.9",
        configJson: body.config ?? {},
        createdBy: principal.userId,
      })
      .returning(),
  );

  return c.json(rows[0], 201);
});

/**
 * PATCH /api/pipelines/:idOrSlug — update pipeline config.
 */
pipelinesRouter.patch("/:idOrSlug", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const idOrSlug = c.req.param("idOrSlug")!;
  const pipelineId = await resolvePipelineId(db, tenantId, idOrSlug);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.json<{
    name?: string;
    schema_id?: string;
    model_provider_id?: string;
    review_threshold?: number;
    config?: Record<string, unknown>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.schema_id !== undefined) updates.schemaId = body.schema_id;
  if (body.model_provider_id !== undefined) updates.modelProviderId = body.model_provider_id;
  if (body.review_threshold !== undefined)
    updates.reviewThreshold = body.review_threshold.toString();
  if (body.config !== undefined) updates.configJson = body.config;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines).set(updates).where(eq(schema.pipelines.id, pipelineId)).returning(),
  );

  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);
  return c.json(rows[0]);
});

/**
 * PATCH /api/pipelines/:idOrSlug/retry-policy — set or reset the retry policy.
 *
 * Accepts either a full {@link RetryPolicy} object or `null` to clear the
 * override and fall back to platform defaults. Partial updates are not
 * supported: callers must send all four fields together so the policy is
 * internally consistent. Wired into the motor/queue is a follow-up after
 * platform-53 (transient-error classifier).
 */
pipelinesRouter.patch("/:idOrSlug/retry-policy", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const idOrSlug = c.req.param("idOrSlug")!;
  const pipelineId = await resolvePipelineId(db, tenantId, idOrSlug);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const body = (await c.req.json().catch(() => undefined)) as unknown;

  let nextValue: RetryPolicy | null;
  if (body === null) {
    nextValue = null;
  } else {
    const parsed = validateRetryPolicy(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    nextValue = parsed;
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({ retryPolicyJson: nextValue, updatedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId))
      .returning({
        id: schema.pipelines.id,
        retryPolicyJson: schema.pipelines.retryPolicyJson,
      }),
  );

  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);
  return c.json({ retryPolicy: (rows[0]!.retryPolicyJson ?? null) as RetryPolicy | null });
});

/**
 * DELETE /api/pipelines/:idOrSlug — soft-delete; unlinks sources.
 */
pipelinesRouter.delete("/:idOrSlug", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const idOrSlug = c.req.param("idOrSlug")!;
  const pipelineId = await resolvePipelineId(db, tenantId, idOrSlug);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.sources)
      .set({ targetPipelineId: null, updatedAt: new Date() })
      .where(eq(schema.sources.targetPipelineId, pipelineId)),
  );

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({ deletedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId)),
  );

  return c.body(null, 204);
});

/**
 * POST /api/pipelines/:idOrSlug/deploy — deploy a schema version.
 */
pipelinesRouter.post("/:idOrSlug/deploy", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const idOrSlug = c.req.param("idOrSlug")!;
  const principal = getPrincipal(c);
  const pipelineId = await resolvePipelineId(db, tenantId, idOrSlug);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.json<{ schema_version_id: string }>();
  if (!body.schema_version_id) {
    return c.json({ error: "schema_version_id is required" }, 400);
  }

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelines.id,
        schemaId: schema.pipelines.schemaId,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const [sv] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.schemaVersions.id,
        schemaId: schema.schemaVersions.schemaId,
        versionNumber: schema.schemaVersions.versionNumber,
      })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.id, body.schema_version_id))
      .limit(1),
  );
  if (!sv) return c.json({ error: "Schema version not found" }, 404);
  if (pipeline.schemaId && sv.schemaId !== pipeline.schemaId) {
    return c.json({ error: "Schema version does not belong to this pipeline's schema" }, 422);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({
        activeSchemaVersionId: body.schema_version_id,
        schemaId: sv.schemaId,
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelines.id, pipelineId))
      .returning(),
  );

  await emitWebhookEvent(tenantId, "schema.deployed", {
    pipeline_id: pipelineId,
    schema_version_id: body.schema_version_id,
    version_number: sv.versionNumber,
    deployed_by: principal.userId,
  });

  return c.json(rows[0]);
});

/** POST /api/pipelines/:idOrSlug/pause */
pipelinesRouter.post("/:idOrSlug/pause", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId)),
  );

  return c.json({ ok: true });
});

/** POST /api/pipelines/:idOrSlug/resume */
pipelinesRouter.post("/:idOrSlug/resume", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.pipelines)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId)),
  );

  return c.json({ ok: true });
});

/**
 * POST /api/pipelines/:idOrSlug/run — manual upload + run.
 *
 * Accepts multipart/form-data with one file. Creates a job + document under
 * the pipeline (no source/ingestion row), persists bytes to storage, and
 * enqueues the extraction handler. Returns the job slug so the dashboard can
 * navigate to the job detail page and watch it tick.
 */
pipelinesRouter.post("/:idOrSlug/run", requires("job:run"), requireUploadRateLimit(), requireConcurrencySlot(), async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const queue = c.get("queue");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelines.id,
        schemaId: schema.pipelines.schemaId,
        activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);
  if (!pipeline.schemaId || !pipeline.activeSchemaVersionId) {
    return c.json(
      { error: "Pipeline has no deployed schema version. Deploy one first." },
      422,
    );
  }

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file in 'file' field" }, 400);
  }

  const fileBytes = await file.arrayBuffer();
  const buffer = Buffer.from(fileBytes);
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const storageKey = `pipeline-runs/${pipelineId}/${Date.now()}-${file.name}`;

  await storage.put(storageKey, buffer, {
    contentType: file.type || mimeTypeFor(file.name),
  });

  const created = await createExtractionJob({
    db,
    tenantId,
    pipelineId,
    schemaId: pipeline.schemaId,
    schemaVersionId: pipeline.activeSchemaVersionId,
    triggerType: "manual",
    storageKey,
    filename: file.name,
    fileSize: file.size,
    mimeType: file.type || mimeTypeFor(file.name),
    contentHash,
  });

  await queue.enqueue(
    "ingestion.process",
    { documentId: created.documentId },
    { tenantId },
  );

  return c.json(
    { jobId: created.jobId, jobSlug: created.jobSlug, documentId: created.documentId },
    202,
  );
});
