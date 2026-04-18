import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { emitWebhookEvent } from "../webhooks/emit";

export const pipelinesRouter = new Hono<Env>();

/**
 * GET /api/pipelines — list pipelines for the current tenant.
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
        lastRunAt: schema.pipelines.lastRunAt,
        createdAt: schema.pipelines.createdAt,
      })
      .from(schema.pipelines)
      .where(sql`deleted_at IS NULL`)
      .orderBy(schema.pipelines.createdAt)
  );

  // Enrich with schema name and version info
  const enriched = [];
  for (const row of rows) {
    let schemaName: string | null = null;
    let versionNumber: number | null = null;

    if (row.schemaId) {
      const [s] = await withRLS(db, tenantId, (tx) =>
        tx.select({ displayName: schema.schemas.displayName })
          .from(schema.schemas).where(eq(schema.schemas.id, row.schemaId!)).limit(1)
      );
      schemaName = s?.displayName ?? null;
    }

    if (row.activeSchemaVersionId) {
      const [sv] = await withRLS(db, tenantId, (tx) =>
        tx.select({ versionNumber: schema.schemaVersions.versionNumber })
          .from(schema.schemaVersions).where(eq(schema.schemaVersions.id, row.activeSchemaVersionId!)).limit(1)
      );
      versionNumber = sv?.versionNumber ?? null;
    }

    enriched.push({
      ...row,
      schemaName,
      deployedVersion: versionNumber,
    });
  }

  return c.json({ data: enriched });
});

/**
 * GET /api/pipelines/:id — pipeline detail.
 */
pipelinesRouter.get("/:id", requires("pipeline:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.pipelines)
      .where(and(eq(schema.pipelines.id, pipelineId), sql`deleted_at IS NULL`))
      .limit(1)
  );

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  // Get schema info
  let schemaName: string | null = null;
  if (pipeline.schemaId) {
    const [s] = await withRLS(db, tenantId, (tx) =>
      tx.select({ displayName: schema.schemas.displayName })
        .from(schema.schemas).where(eq(schema.schemas.id, pipeline.schemaId!)).limit(1)
    );
    schemaName = s?.displayName ?? null;
  }

  // Get deployed version info
  let deployedVersion: { number: number; commitMessage: string | null; createdAt: Date } | null = null;
  if (pipeline.activeSchemaVersionId) {
    const [sv] = await withRLS(db, tenantId, (tx) =>
      tx.select({
        versionNumber: schema.schemaVersions.versionNumber,
        commitMessage: schema.schemaVersions.commitMessage,
        createdAt: schema.schemaVersions.createdAt,
      }).from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.id, pipeline.activeSchemaVersionId!)).limit(1)
    );
    if (sv) deployedVersion = { number: sv.versionNumber, commitMessage: sv.commitMessage, createdAt: sv.createdAt };
  }

  // Get connected sources
  const connectedSources = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.sources.id,
      displayName: schema.sources.displayName,
      sourceType: schema.sources.sourceType,
      status: schema.sources.status,
      lastIngestedAt: schema.sources.lastIngestedAt,
    }).from(schema.sources)
      .where(and(eq(schema.sources.targetPipelineId, pipelineId), sql`deleted_at IS NULL`))
  );

  // Get recent jobs
  const recentJobs = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.jobs.id,
      slug: schema.jobs.slug,
      status: schema.jobs.status,
      docsTotal: schema.jobs.docsTotal,
      docsPassed: schema.jobs.docsPassed,
      docsFailed: schema.jobs.docsFailed,
      createdAt: schema.jobs.createdAt,
    }).from(schema.jobs)
      .where(eq(schema.jobs.pipelineId, pipelineId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(10)
  );

  return c.json({
    ...pipeline,
    schemaName,
    deployedVersion,
    connectedSources,
    recentJobs,
  });
});

/**
 * POST /api/pipelines — create a pipeline.
 */
pipelinesRouter.post("/", requires("pipeline:write"), async (c) => {
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
    tx.insert(schema.pipelines).values({
      tenantId,
      slug: body.slug,
      displayName: body.name,
      schemaId: body.schema_id ?? null,
      modelProviderId: body.model_provider_id ?? null,
      reviewThreshold: body.review_threshold?.toString() ?? "0.9",
      configJson: body.config ?? {},
      createdBy: principal.userId,
    }).returning()
  );

  return c.json(rows[0], 201);
});

/**
 * PATCH /api/pipelines/:id — update pipeline config.
 */
pipelinesRouter.patch("/:id", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;

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
  if (body.review_threshold !== undefined) updates.reviewThreshold = body.review_threshold.toString();
  if (body.config !== undefined) updates.configJson = body.config;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines).set(updates)
      .where(eq(schema.pipelines.id, pipelineId)).returning()
  );

  if (rows.length === 0) return c.json({ error: "Pipeline not found" }, 404);
  return c.json(rows[0]);
});

/**
 * DELETE /api/pipelines/:id — soft-delete.
 */
pipelinesRouter.delete("/:id", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;

  // Unlink sources that point to this pipeline
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.sources).set({ targetPipelineId: null, updatedAt: new Date() })
      .where(eq(schema.sources.targetPipelineId, pipelineId))
  );

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines).set({ deletedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId))
  );

  return c.body(null, 204);
});

/**
 * POST /api/pipelines/:id/deploy — deploy a schema version.
 */
pipelinesRouter.post("/:id/deploy", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;
  const principal = getPrincipal(c);

  const body = await c.req.json<{ schema_version_id: string }>();
  if (!body.schema_version_id) {
    return c.json({ error: "schema_version_id is required" }, 400);
  }

  // Load pipeline
  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.pipelines.id, schemaId: schema.pipelines.schemaId, configJson: schema.pipelines.configJson })
      .from(schema.pipelines).where(eq(schema.pipelines.id, pipelineId)).limit(1)
  );

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  // Validate the schema version exists and belongs to the pipeline's schema
  const [sv] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemaVersions.id,
      schemaId: schema.schemaVersions.schemaId,
      versionNumber: schema.schemaVersions.versionNumber,
    }).from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.id, body.schema_version_id)).limit(1)
  );

  if (!sv) return c.json({ error: "Schema version not found" }, 404);

  if (pipeline.schemaId && sv.schemaId !== pipeline.schemaId) {
    return c.json({ error: "Schema version does not belong to this pipeline's schema" }, 422);
  }

  // Deploy
  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines)
      .set({
        activeSchemaVersionId: body.schema_version_id,
        schemaId: sv.schemaId, // ensure schema is linked
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelines.id, pipelineId))
      .returning()
  );

  // Emit webhook event
  await emitWebhookEvent(tenantId, "schema.deployed", {
    pipeline_id: pipelineId,
    schema_version_id: body.schema_version_id,
    version_number: sv.versionNumber,
    deployed_by: principal.userId,
  });

  return c.json(rows[0]);
});

/**
 * POST /api/pipelines/:id/pause — pause pipeline.
 */
pipelinesRouter.post("/:id/pause", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines).set({ status: "paused", updatedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId))
  );

  return c.json({ ok: true });
});

/**
 * POST /api/pipelines/:id/resume — resume pipeline.
 */
pipelinesRouter.post("/:id/resume", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.pipelines).set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.pipelines.id, pipelineId))
  );

  return c.json({ ok: true });
});
