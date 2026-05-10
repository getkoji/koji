import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { schema, withRLS } from "@koji/db";
import { compilePipeline, calculatePipelineCosts } from "@koji/pipeline";
import type { RetryPolicy } from "@koji/types/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { requireUploadRateLimit } from "../billing/rate-limits";
import { requireConcurrencySlot } from "../billing/concurrency";
import { emitWebhookEvent } from "../webhooks/emit";
import { createExtractionJob, addDocumentToJob, mimeTypeFor } from "../ingestion/process";

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
        pipelineType: schema.pipelines.pipelineType,
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
        pipelineType: schema.pipelines.pipelineType,
        dagJson: schema.pipelines.dagJson,
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

  // Redact webhook header values from the YAML before returning
  let safeYamlSource = pipeline.yamlSource;
  if (safeYamlSource) {
    try {
      const parsed = YAML.parse(safeYamlSource);
      if (parsed?.steps) {
        let redacted = false;
        for (const step of parsed.steps) {
          if (step.type === "webhook" && step.config?.headers) {
            const headers = step.config.headers as Record<string, string>;
            for (const key of Object.keys(headers)) {
              if (headers[key] && headers[key] !== "***") {
                headers[key] = "***";
                redacted = true;
              }
            }
          }
        }
        if (redacted) safeYamlSource = YAML.stringify(parsed);
      }
    } catch { /* keep original if parse fails */ }
  }

  return c.json({
    ...pipeline,
    yamlSource: safeYamlSource,
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
    yaml?: string;
    schema_id?: string;
    model_provider_id?: string;
    review_threshold?: number;
    config?: Record<string, unknown>;
  }>();

  if (!body.name || !body.slug) {
    return c.json({ error: "name and slug are required" }, 400);
  }

  // If yaml is provided, mark as a DAG pipeline and store the source.
  // Full compilation is deferred to validate/deploy when @koji/pipeline lands.
  let pipelineType = "simple";
  let dagJson: Record<string, unknown> | null = null;
  let yamlSource = "";

  if (body.yaml) {
    pipelineType = "dag";
    yamlSource = body.yaml;
    dagJson = {};
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.pipelines)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.name,
        pipelineType,
        yamlSource,
        dagJson,
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
    yaml?: string;
    schema_id?: string;
    model_provider_id?: string;
    review_threshold?: number;
    config?: Record<string, unknown>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.yaml !== undefined) {
    updates.yamlSource = body.yaml;
    updates.pipelineType = "dag";
    // Compile the YAML and store the compiled DAG
    const compiled = compilePipeline(body.yaml);
    updates.dagJson = compiled.ok ? compiled.pipeline : {};

    // Encrypt webhook header values — they may contain auth tokens
    const masterKey = c.get("masterKey") as string | null;
    if (masterKey) {
      try {
        const { encrypt: encryptValue } = await import("../crypto/envelope");
        const parsed = YAML.parse(body.yaml);
        const encryptedHeaders: Record<string, Record<string, string>> = {};
        if (parsed?.steps) {
          for (const step of parsed.steps) {
            if (step.type === "webhook" && step.config?.headers) {
              const headers = step.config.headers as Record<string, string>;
              const encrypted: Record<string, string> = {};
              for (const [key, value] of Object.entries(headers)) {
                if (value && value !== "***") {
                  encrypted[key] = encryptValue(value, masterKey, tenantId);
                }
              }
              if (Object.keys(encrypted).length > 0) {
                encryptedHeaders[step.id] = encrypted;
              }
            }
          }
        }
        if (Object.keys(encryptedHeaders).length > 0) {
          // Store encrypted headers alongside the pipeline config
          const existingConfig = (await withRLS(db, tenantId, (tx) =>
            tx.select({ configJson: schema.pipelines.configJson })
              .from(schema.pipelines)
              .where(eq(schema.pipelines.id, pipelineId))
              .limit(1),
          ))[0]?.configJson as Record<string, unknown> || {};
          updates.configJson = { ...existingConfig, encryptedHeaders };
        }
      } catch {
        // If encryption fails, continue without encrypting — better than blocking save
      }
    }
  }
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
 * POST /api/pipelines/:idOrSlug/validate — validate pipeline YAML without saving.
 */
pipelinesRouter.post("/:idOrSlug/validate", requires("pipeline:write"), async (c) => {
  const body = await c.req.json<{ yaml: string }>();
  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);

  const result = compilePipeline(body.yaml);

  if (result.ok) {
    const costs = calculatePipelineCosts(result.pipeline);
    return c.json({
      valid: true,
      errors: [],
      compiled: {
        name: result.pipeline.name,
        steps: result.pipeline.steps.length,
        entryStepId: result.pipeline.entryStepId,
        terminalStepIds: result.pipeline.terminalStepIds,
        estimatedMaxCostPerDoc: result.pipeline.estimatedMaxCostPerDoc,
        paths: costs.paths,
      },
    });
  }

  return c.json({ valid: false, errors: result.errors });
});

/**
 * GET /api/pipelines/:idOrSlug/cost — per-doc cost estimate.
 */
pipelinesRouter.get("/:idOrSlug/cost", requires("pipeline:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        pipelineType: schema.pipelines.pipelineType,
        dagJson: schema.pipelines.dagJson,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  if (pipeline.pipelineType === "simple") {
    return c.json({
      max_cost_per_doc: 0.08,
      paths: [{ steps: ["extract"], cost: 0.08, description: "Single-schema extraction" }],
    });
  }

  // For DAG pipelines, compile the YAML and calculate costs
  const [full] = await withRLS(db, tenantId, (tx) =>
    tx.select({ yamlSource: schema.pipelines.yamlSource })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );

  if (full?.yamlSource) {
    const result = compilePipeline(full.yamlSource);
    if (result.ok) {
      const costs = calculatePipelineCosts(result.pipeline);
      return c.json({
        max_cost_per_doc: costs.maxCostPerDoc,
        paths: costs.paths,
      });
    }
  }

  // Fallback if YAML doesn't compile
  const dag = pipeline.dagJson as Record<string, unknown> | null;
  return c.json({
    max_cost_per_doc: (dag?.estimatedMaxCostPerDoc as number) ?? 0.08,
    paths: [],
  });
});

/**
 * POST /api/pipelines/:idOrSlug/versions — create a pipeline version (draft or deployed).
 */
pipelinesRouter.post("/:idOrSlug/versions", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.json<{
    yaml: string;
    commit_message?: string;
    deploy?: boolean;
  }>();

  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);

  // Get the next version number
  const [latest] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ maxVersion: sql<number>`COALESCE(MAX(version_number), 0)::int` })
      .from(schema.pipelineVersions)
      .where(eq(schema.pipelineVersions.pipelineId, pipelineId)),
  );

  const nextVersion = (latest?.maxVersion ?? 0) + 1;

  // Compile the YAML
  const compiled = compilePipeline(body.yaml);
  if (!compiled.ok) {
    return c.json({ error: "Pipeline YAML is invalid", errors: compiled.errors }, 422);
  }
  const dagJson = compiled.pipeline;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.pipelineVersions)
      .values({
        tenantId,
        pipelineId,
        versionNumber: nextVersion,
        yamlSource: body.yaml,
        dagJson,
        commitMessage: body.commit_message ?? null,
        committedBy: principal.userId,
        deployedAt: body.deploy ? new Date() : null,
      })
      .returning(),
  );

  // If deploying, update the pipeline's active state
  if (body.deploy && rows[0]) {
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.pipelines)
        .set({
          pipelineType: "dag",
          yamlSource: body.yaml,
          dagJson,
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelines.id, pipelineId)),
    );
  }

  return c.json(rows[0], 201);
});

/**
 * GET /api/pipelines/:idOrSlug/versions — list pipeline versions.
 */
pipelinesRouter.get("/:idOrSlug/versions", requires("pipeline:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.pipelineVersions.id,
        versionNumber: schema.pipelineVersions.versionNumber,
        commitMessage: schema.pipelineVersions.commitMessage,
        deployedAt: schema.pipelineVersions.deployedAt,
        createdAt: schema.pipelineVersions.createdAt,
      })
      .from(schema.pipelineVersions)
      .where(eq(schema.pipelineVersions.pipelineId, pipelineId))
      .orderBy(desc(schema.pipelineVersions.versionNumber))
      .limit(50),
  );

  return c.json({ data: rows });
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
        pipelineType: schema.pipelines.pipelineType,
        yamlSource: schema.pipelines.yamlSource,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  // DAG pipelines require YAML to be saved
  // Simple pipelines require a deployed schema version
  if (pipeline.pipelineType === "simple") {
    if (!pipeline.schemaId || !pipeline.activeSchemaVersionId) {
      return c.json(
        { error: "Pipeline has no deployed schema version. Deploy one first." },
        422,
      );
    }
  } else if (pipeline.pipelineType === "dag") {
    if (!pipeline.yamlSource) {
      return c.json({ error: "Pipeline has no DAG definition. Save one first." }, 422);
    }
  }

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file in 'file' field" }, 400);
  }
  const groupKey = (body.group as string) || c.req.header("X-Koji-Group") || null;

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
    schemaId: pipeline.schemaId || "",
    schemaVersionId: pipeline.activeSchemaVersionId || "",
    triggerType: "manual",
    storageKey,
    groupKey,
    filename: file.name,
    fileSize: file.size,
    mimeType: file.type || mimeTypeFor(file.name),
    contentHash,
  });

  // Route to the appropriate handler based on pipeline type
  if (pipeline.pipelineType === "dag") {
    await queue.enqueue(
      "pipeline.dag.run",
      { documentId: created.documentId, pipelineId },
      { tenantId },
    );
  } else {
    await queue.enqueue(
      "ingestion.process",
      { documentId: created.documentId },
      { tenantId },
    );
  }

  return c.json(
    { jobId: created.jobId, jobSlug: created.jobSlug, documentId: created.documentId },
    202,
  );
});

/**
 * POST /api/pipelines/:idOrSlug/jobs/:jobId/docs — add a document to an existing job.
 *
 * Used for batch uploads: the client creates a job with the first file via /run,
 * then adds subsequent files to the same job via this endpoint.
 */
pipelinesRouter.post("/:idOrSlug/jobs/:jobId/docs", requires("job:run"), async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const queue = c.get("queue");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const jobId = c.req.param("jobId")!;

  // Verify job exists and belongs to this pipeline
  const [job] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.jobs.id, pipelineId: schema.jobs.pipelineId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1),
  );
  if (!job || job.pipelineId !== pipelineId) {
    return c.json({ error: "Job not found" }, 404);
  }

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      schemaId: schema.pipelines.schemaId,
      activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
    })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );
  if (!pipeline?.schemaId || !pipeline.activeSchemaVersionId) {
    return c.json({ error: "Pipeline has no deployed schema version" }, 422);
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

  const created = await addDocumentToJob({
    db,
    tenantId,
    pipelineId,
    jobId,
    schemaId: pipeline.schemaId,
    schemaVersionId: pipeline.activeSchemaVersionId,
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

  return c.json({ documentId: created.documentId }, 202);
});

// ── Pipeline test mode (dry-run) ──

const STEP_COSTS: Record<string, number> = {
  classify: 0.005, extract: 0.08, ocr: 0.03, split: 0.01,
  tag: 0, filter: 0, webhook: 0, transform: 0, gate: 0,
  redact: 0.005, enrich: 0, validate: 0, summarize: 0.01,
  compare: 0.005, merge_documents: 0,
};

function resolveTestDotPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evalTestCondition(condition: string, context: Record<string, unknown>): boolean {
  const m = condition.match(/^([\w.]+)\s*(==|!=|>=?|<=?|in)\s*(.+)$/);
  if (!m) return true;
  const left = resolveTestDotPath(context, m[1]!);
  const raw = m[3]!.trim();
  let right: unknown;
  if (raw.startsWith("'") && raw.endsWith("'")) right = raw.slice(1, -1);
  else if (raw.startsWith("[")) { try { right = JSON.parse(raw.replace(/'/g, '"')); } catch { right = raw; } }
  else if (!isNaN(Number(raw))) right = Number(raw);
  else right = raw;
  switch (m[2]) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    case "in": return Array.isArray(right) && right.includes(left);
    default: return true;
  }
}

interface TestEdge { from: string; to: string; when?: string; default?: boolean }

function resolveTestNextStep(edges: TestEdge[], output: Record<string, unknown>): string | null {
  const all = resolveTestNextSteps(edges, output);
  return all[0] ?? null;
}

function resolveTestNextSteps(edges: TestEdge[], output: Record<string, unknown>): string[] {
  const matched: string[] = [];
  for (const e of edges) {
    if (e.default) continue;
    if (!e.when) { matched.push(e.to); continue; }
    if (evalTestCondition(e.when, { output })) matched.push(e.to);
  }
  if (matched.length > 0) return matched;
  const def = edges.find(e => e.default);
  return def ? [def.to] : [];
}

async function executeTestStep(
  step: { id: string; type: string; config: Record<string, unknown> },
  docInfo: { filename: string; mimeType: string; fileSize: number; text?: string; pageCount?: number; chunks?: Array<{ index: number; title: string; content: string }>; fileBuffer?: Buffer; parseProvider?: any },
  priorOutputs: Record<string, unknown>,
  ctx?: { db: unknown; tenantId: string; pipelineId: string },
): Promise<{ ok: boolean; output: Record<string, unknown>; costUsd: number; error?: string }> {
  const cost = STEP_COSTS[step.type] ?? 0;
  switch (step.type) {
    case "classify": {
      const labels = (step.config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];
      const method = (step.config.method as string) || "keyword_then_llm";
      const question = (step.config.question as string) || "What type of document is this?";

      // Try keyword classification first
      if (method === "keyword" || method === "keyword_then_llm") {
        const text = (docInfo.text || docInfo.filename).toLowerCase();
        for (const label of labels) {
          if (!label.keywords?.length) continue;
          const hits = label.keywords.filter(kw => text.includes(kw.toLowerCase()));
          if (hits.length >= 2) {
            return { ok: true, output: { label: label.id, confidence: 1.0, method: "keyword", reasoning: `Matched keywords: ${hits.join(", ")}` }, costUsd: 0 };
          }
        }
        if (method === "keyword") {
          return { ok: true, output: { label: labels[labels.length - 1]?.id || "unknown", confidence: 0.5, method: "keyword", reasoning: "No keyword match found" }, costUsd: 0 };
        }
      }

      // LLM classification — try to resolve model endpoint
      if (ctx?.db && ctx.tenantId) {
        try {
          const { resolveExtractEndpoint } = await import("../extract/resolve-endpoint");
          const { createProvider } = await import("../extract/providers");
          // Look up the pipeline's model provider ID
          const pipelineRows = await withRLS(ctx.db as any, ctx.tenantId, (tx: any) =>
            tx.select({ modelProviderId: schema.pipelines.modelProviderId })
              .from(schema.pipelines)
              .where(eq(schema.pipelines.id, ctx.pipelineId))
              .limit(1),
          ) as Array<{ modelProviderId: string | null }>;
          const endpoint = await resolveExtractEndpoint(ctx.db as any, ctx.tenantId, pipelineRows[0]?.modelProviderId ?? null);
          if (endpoint) {
            const provider = createProvider(endpoint.model, endpoint);
            const labelDescriptions = labels.map(l => `- "${l.id}"${l.description ? `: ${l.description}` : ""}`).join("\n");
            const docText = (docInfo.text || docInfo.filename).slice(0, 3000);
            const prompt = `${question}\n\nClassify this document into exactly one of the following categories:\n${labelDescriptions}\n\nDocument text (first 3000 characters):\n${docText}\n\nRespond with JSON only:\n{"label": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>"}`;
            const response = await provider.generate(prompt, true);
            try {
              const parsed = JSON.parse(response);
              const validLabel = labels.find(l => l.id === parsed.label);
              return {
                ok: true,
                output: {
                  label: validLabel?.id || labels[0]?.id || "unknown",
                  confidence: parsed.confidence ?? 0.8,
                  method: "llm",
                  reasoning: parsed.reasoning || "LLM classification",
                },
                costUsd: cost,
              };
            } catch {
              return { ok: true, output: { label: labels[0]?.id || "unknown", confidence: 0.5, method: "llm", reasoning: `LLM response not parseable: ${response.slice(0, 200)}` }, costUsd: cost };
            }
          }
        } catch (err) {
          // Fall through to simulated if endpoint resolution fails
        }
      }

      // Fallback: simulated
      return { ok: true, output: { label: labels[0]?.id || "unknown", confidence: 0.85, method: "simulated", reasoning: "No model endpoint configured — simulated classification" }, costUsd: cost };
    }
    case "extract": {
      const schemaSlug = (step.config.schema as string) || "";
      if (!schemaSlug) {
        return { ok: false, output: {}, costUsd: cost, error: "No schema configured on extract step" };
      }
      if (!ctx?.db || !ctx.tenantId || !docInfo.text) {
        return { ok: true, output: { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, confidence: 0, note: docInfo.text ? "No DB context" : "No parsed text available" }, costUsd: cost };
      }
      try {
        // Look up the schema definition
        const schemaRows = await withRLS(ctx.db as any, ctx.tenantId, (tx: any) =>
          tx.select({
            id: schema.schemas.id,
            currentVersionId: schema.schemas.currentVersionId,
          })
          .from(schema.schemas)
          .where(eq(schema.schemas.slug, schemaSlug))
          .limit(1),
        ) as Array<{ id: string; currentVersionId: string | null }>;
        const schemaRow = schemaRows[0];
        if (!schemaRow?.currentVersionId) {
          return { ok: true, output: { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, confidence: 0, note: `Schema "${schemaSlug}" not found or has no committed version` }, costUsd: cost };
        }
        const versionRows = await withRLS(ctx.db as any, ctx.tenantId, (tx: any) =>
          tx.select({ parsedJson: schema.schemaVersions.parsedJson })
            .from(schema.schemaVersions)
            .where(eq(schema.schemaVersions.id, schemaRow.currentVersionId!))
            .limit(1),
        ) as Array<{ parsedJson: Record<string, unknown> | null }>;
        const version = versionRows[0];
        if (!version?.parsedJson) {
          return { ok: true, output: { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, confidence: 0, note: "Schema version has no parsed definition" }, costUsd: cost };
        }
        // Resolve model endpoint
        const { resolveExtractEndpoint } = await import("../extract/resolve-endpoint");
        const { createProvider } = await import("../extract/providers");
        const { extractFields } = await import("../extract/pipeline");
        const pRows = await withRLS(ctx.db as any, ctx.tenantId, (tx: any) =>
          tx.select({ modelProviderId: schema.pipelines.modelProviderId })
            .from(schema.pipelines)
            .where(eq(schema.pipelines.id, ctx.pipelineId))
            .limit(1),
        ) as Array<{ modelProviderId: string | null }>;
        const endpoint = await resolveExtractEndpoint(ctx.db as any, ctx.tenantId, pRows[0]?.modelProviderId ?? null);
        if (!endpoint) {
          return { ok: true, output: { schema: schemaSlug, fields: {}, fieldCount: 0, totalFields: 0, confidence: 0, note: "No model endpoint configured — cannot run extraction" }, costUsd: cost };
        }
        const provider = createProvider(endpoint.model, endpoint);
        const schemaDef = version.parsedJson as Record<string, unknown>;
        const result = await extractFields(docInfo.text, schemaDef, provider, endpoint.model);
        const fieldNames = Object.keys(result.extracted || {});
        const nonNullFields = fieldNames.filter(f => (result.extracted as Record<string, unknown>)[f] != null);
        return {
          ok: true,
          output: {
            schema: schemaSlug,
            fields: result.extracted || {},
            fieldCount: nonNullFields.length,
            totalFields: fieldNames.length,
            confidence: (() => { const s = Object.values(result.confidence_scores || {}); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0; })(),
            confidenceScores: result.confidence_scores || {},
            model: result.model,
            strategy: result.strategy,
            elapsed_ms: result.elapsed_ms,
          },
          costUsd: cost,
        };
      } catch (err) {
        return { ok: false, output: { schema: schemaSlug }, costUsd: cost, error: `Extraction failed: ${(err as Error).message}` };
      }
    }
    case "tag":
      return { ok: true, output: { tags: (step.config.tags as Record<string, string>) || {} }, costUsd: 0 };
    case "filter": {
      const passed = evalTestCondition((step.config.condition as string) || "true", { document: docInfo, steps: priorOutputs });
      return { ok: true, output: { passed }, costUsd: 0 };
    }
    case "transform": {
      // Apply transform operations to upstream extraction results
      const ops = (step.config.operations as Array<Record<string, unknown>>) || [];
      let fields: Record<string, unknown> = {};
      // Collect fields from upstream extract steps
      for (const so of Object.values(priorOutputs)) {
        const out = so as Record<string, unknown>;
        if (out?.fields && typeof out.fields === "object") {
          fields = { ...fields, ...(out.fields as Record<string, unknown>) };
        }
      }
      const applied: string[] = [];
      for (const op of ops) {
        if (op.rename && typeof op.rename === "object") {
          const { from: f, to: t } = op.rename as { from: string; to: string };
          if (f in fields) { fields[t] = fields[f]; delete fields[f]; applied.push(`rename: ${f} → ${t}`); }
        } else if (op.set && typeof op.set === "object") {
          const { field: f, value: v } = op.set as { field: string; value: unknown };
          let resolved = v;
          if (typeof v === "string") {
            resolved = v.replace("{{now}}", new Date().toISOString())
              .replace("{{document.filename}}", docInfo.filename);
          }
          fields[f] = resolved; applied.push(`set: ${f}`);
        } else if (op.remove && typeof op.remove === "object") {
          const { field: f } = op.remove as { field: string };
          delete fields[f]; applied.push(`remove: ${f}`);
        }
      }
      return { ok: true, output: { fields, operations_applied: applied, operation_count: applied.length }, costUsd: 0 };
    }
    case "resolve_references": {
      // In test mode, resolve references using the group key if provided
      // Test mode can't query the DB for other docs in the group (ephemeral),
      // but we can show what the step would detect in the current doc
      const currentChunks = docInfo.chunks || [];
      if (currentChunks.length === 0) {
        return { ok: true, output: { references: [], note: "No chunks — document wasn't parsed" }, costUsd: 0.02 };
      }

      // Regex scan for reference patterns
      const refPatterns = [
        /(?:see|refer to|per|pursuant to|in accordance with|as (?:defined|described|set forth) in)\s+(?:the\s+)?(.{3,80}?)(?:\.|,|;|\)|\n|$)/gi,
        /(?:Section|Article|Exhibit|Schedule|Appendix|Addendum|Amendment)\s+[\d.A-Z]+/gi,
      ];
      const detected: Array<{ text: string; source_chunk: string; resolved: boolean; method: string }> = [];
      for (const chunk of currentChunks) {
        for (const pattern of refPatterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(chunk.content)) !== null) {
            detected.push({
              text: match[0].trim(),
              source_chunk: chunk.title,
              resolved: false,
              method: "detected_in_test",
            });
          }
        }
      }

      return {
        ok: true,
        output: {
          references: detected,
          references_detected: detected.length,
          chunks_scanned: currentChunks.length,
          note: detected.length > 0
            ? `Found ${detected.length} reference(s) in this document. In production with a group key, these would be resolved against other documents in the group.`
            : "No cross-document references detected in this document.",
        },
        costUsd: 0.02,
      };
    }
    case "split": {
      const method = (step.config.method as string) || "auto";
      const labels = (step.config.labels as Array<{ id: string; description?: string; keywords?: string[] }>) || [];

      if (method === "fixed") {
        const ranges = (step.config.page_ranges as Array<{ start: number; end: number; type?: string }>) || [];
        const groups = ranges.map(r => ({ startPage: r.start, endPage: r.end, type: r.type || "document", confidence: 1.0, method: "fixed" }));
        return { ok: true, output: { groups, method: "fixed", count: groups.length }, costUsd: 0 };
      }

      // Use structural page analysis for smart boundary detection
      if (!docInfo.parseProvider?.analyzePages && !docInfo.parseProvider?.pageHeaders) {
        return { ok: false, output: { groups: [], error: "Parse provider does not support page analysis" }, costUsd: cost };
      }
      if (!docInfo.fileBuffer) {
        return { ok: false, output: { groups: [], error: "No file buffer available" }, costUsd: cost };
      }

      let groups: Array<{ startPage: number; endPage: number; type: string; confidence: number; method: string }>;

      if (docInfo.parseProvider.analyzePages) {
        // Full structural analysis — layered detection
        const { detectSections } = await import("../extract/split-detect");
        const pageData = await docInfo.parseProvider.analyzePages({ fileBuffer: docInfo.fileBuffer });

        let llmProvider: any = undefined;
        if (ctx?.db && ctx.tenantId) {
          try {
            const { resolveTenantProvider } = await import("../extract/resolve-endpoint");
            const resolved = await resolveTenantProvider(ctx.db as any, ctx.tenantId);
            llmProvider = resolved.provider;
          } catch {}
        }

        const sections = await detectSections(pageData, { labels, llmProvider });
        groups = sections;
        console.log(`[test/split] detectSections found ${sections.length} sections:`, sections.map(s => `p${s.startPage}-${s.endPage} ${s.type} (${s.method})`));
      } else {
        // Fallback to page headers + LLM (old approach)
        const result = await docInfo.parseProvider.pageHeaders!({ fileBuffer: docInfo.fileBuffer });
        const headers = result.headers;
        if (headers.length === 0) {
          return { ok: false, output: { groups: [], error: "No pages found" }, costUsd: cost };
        }

        if (!ctx?.db || !ctx.tenantId) {
          return { ok: false, output: { groups: [], error: "No DB context for LLM classification" }, costUsd: cost };
        }
        const { resolveTenantProvider } = await import("../extract/resolve-endpoint");
        const { provider } = await resolveTenantProvider(ctx.db as any, ctx.tenantId);
        const labelDesc = labels.length > 0
          ? `\nKnown document types:\n${labels.map(l => `- "${l.id}"${l.description ? `: ${l.description}` : ""}`).join("\n")}\n`
          : "";
        const headerList = headers.map(h => `Page ${h.page}: "${h.header_text}"`).join("\n");
        const prompt = `This is a multi-document PDF submission. Here are the first ~200 characters from each page:\n\n${headerList}\n${labelDesc}\nIdentify where new documents begin. Return a JSON array:\n[{"start_page": 1, "end_page": 3, "type": "document_type"},...]`;
        const raw = await provider.generate(prompt, true);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { const m = raw.match(/\[[\s\S]*\]/); if (m) parsed = JSON.parse(m[0]); else throw new Error("Could not parse LLM response"); }
        const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as any).documents)) ? (parsed as any).documents : [];
        groups = arr.map((g: any) => ({ startPage: g.start_page ?? g.startPage ?? 1, endPage: g.end_page ?? g.endPage ?? 1, type: g.type ?? "document", confidence: g.confidence ?? 0.85, method: "llm_fallback" }));
      }

        // Filter groups by type if filter_types is configured
        const filterTypes = step.config.filter_types as string[] | undefined;
        const groupsToSlice = filterTypes?.length
          ? groups.filter((g) => filterTypes.some((ft) => g.type.toLowerCase().includes(ft.toLowerCase())))
          : groups;

        // Slice PDFs for matching groups — store in R2 and return signed URLs
        const children: Array<{ group: typeof groups[0]; text?: string; pageCount: number; filename: string; storageKey?: string; previewUrl?: string }> = [];
        if (docInfo.parseProvider?.slicePdf && docInfo.fileBuffer && groupsToSlice.length > 0) {
          for (const group of groupsToSlice) {
            try {
              const sliced = await docInfo.parseProvider.slicePdf({
                fileBuffer: docInfo.fileBuffer,
                startPage: group.startPage,
                endPage: group.endPage,
              });
              const childFilename = `${docInfo.filename.replace(/\.pdf$/i, "")}_p${group.startPage}-${group.endPage}_${group.type.replace(/\s+/g, "_")}.pdf`;
              const childBuffer = Buffer.from(sliced.pdf_base64, "base64");

              // Store sliced PDF in R2
              let storageKey: string | undefined;
              let previewUrl: string | undefined;
              if (docInfo.storage) {
                storageKey = `test-runs/${Date.now()}-${childFilename}`;
                await docInfo.storage.put(storageKey, childBuffer, { contentType: "application/pdf" });
                try { previewUrl = await docInfo.storage.getSignedUrl(storageKey, 3600); } catch {}
              }

              // Don't parse here — defer to downstream steps that need the text.
              // Store the buffer so runBranch can parse lazily when extract runs.
              children.push({ group, text: undefined, pageCount: sliced.pages, filename: childFilename, storageKey, previewUrl, fileBuffer: childBuffer });
            } catch (err) {
              console.warn(`[test/split] slice failed for pages ${group.startPage}-${group.endPage}:`, (err as Error).message);
            }
          }
        }

        return {
          ok: true,
          output: { groups, count: groups.length, children },
          costUsd: 0.005,
        };
    }
    case "webhook": {
      // Show what the webhook payload WOULD be — don't actually deliver
      const webhookUrl = (step.config.url as string) || "(no URL configured)";
      const payloadMode = (step.config.payload as string) || "result";
      const extractOutput = Object.values(priorOutputs).reverse().find(o => (o as any)?.fields);
      const splitOutput = Object.values(priorOutputs).reverse().find(o => (o as any)?.current_group);
      const payload: Record<string, unknown> = {
        document_id: "(test)",
        filename: docInfo.filename,
        mime_type: docInfo.mimeType,
        page_count: docInfo.pageCount,
      };
      if (splitOutput) {
        payload.document_url = (splitOutput as any).document_url;
        payload.group = (splitOutput as any).current_group;
        payload.storage_key = (splitOutput as any).storage_key;
      }
      if (payloadMode === "result" && extractOutput) {
        payload.extraction = extractOutput;
      }
      return { ok: true, output: { skipped: true, reason: "Webhooks not delivered in test mode", url: webhookUrl, would_send: payload }, costUsd: 0 };
    }
    case "gate":
      return { ok: true, output: { reviewed: true, auto_approved: true, reason: "Gates auto-approved in test mode" }, costUsd: 0 };
    default:
      return { ok: true, output: { note: `Step type "${step.type}" — simulated in test mode` }, costUsd: cost };
  }
}

/**
 * POST /api/pipelines/:idOrSlug/test — dry-run a document through the pipeline.
 * No persistence. Supports SSE streaming via ?stream=true.
 */
pipelinesRouter.post("/:idOrSlug/test", requires("pipeline:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const pipelineId = await resolvePipelineId(db, tenantId, c.req.param("idOrSlug")!);
  if (!pipelineId) return c.json({ error: "Pipeline not found" }, 404);

  const stream = c.req.query("stream") === "true";
  const mode = c.req.query("mode") || "auto";

  const [pipeline] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.pipelines.id,
      yamlSource: schema.pipelines.yamlSource,
      pipelineType: schema.pipelines.pipelineType,
      schemaSlug: schema.schemas.slug,
    })
    .from(schema.pipelines)
    .leftJoin(schema.schemas, eq(schema.schemas.id, schema.pipelines.schemaId))
    .where(eq(schema.pipelines.id, pipelineId))
    .limit(1),
  );
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "Missing file in 'file' field" }, 400);

  const fileBytes = await file.arrayBuffer();
  const mimeType = file.type || "application/octet-stream";

  // ── Implicit parse step: extract text from document ──
  // Every pipeline starts with parsing. This runs before any user-defined steps.
  const parseProvider = (c as any).get("parseProvider");
  let docText: string | undefined;
  let pageCount: number | undefined;
  try {
    if (parseProvider?.parse) {
      const parseResult = await parseProvider.parse({
        filename: file.name,
        mimeType,
        fileBuffer: Buffer.from(fileBytes),
      });
      docText = parseResult.markdown;
      pageCount = parseResult.pages ?? undefined;
    }
  } catch (err) {
    // Parse failed — fall back to basic text extraction
    console.error("[test] Parse failed, falling back to basic text extraction:", (err as Error).message);
  }

  // Fallback for text-based files if parse service didn't run
  if (!docText && (mimeType.startsWith("text/") || mimeType === "application/json")) {
    docText = new TextDecoder().decode(fileBytes);
  }

  // Chunk the parsed text
  const { chunkMarkdown } = await import("../extract/chunker");
  const docChunks = docText ? chunkMarkdown(docText) : [];

  const storage = c.get("storage");
  // Copy fileBytes into a new Buffer — Buffer.from(ArrayBuffer) creates a view
  // that shares memory, which can be detached after the first fetch call consumes it.
  const fileBufferCopy = Buffer.from(new Uint8Array(fileBytes));
  const docInfo = { filename: file.name, mimeType, fileSize: fileBytes.byteLength, text: docText, pageCount, chunks: docChunks, fileBuffer: fileBufferCopy, parseProvider, storage };
  const testCtx = { db, tenantId, pipelineId: pipelineId! };

  // Parse pipeline steps + edges
  type PStep = { id: string; type: string; config: Record<string, unknown> };
  let pSteps: PStep[] = [];
  let pEdges: TestEdge[] = [];

  if (pipeline.pipelineType === "dag" && pipeline.yamlSource) {
    try {
      const { parse: parseYaml } = await import("yaml");
      const parsed = parseYaml(pipeline.yamlSource);
      if (parsed?.steps) {
        pSteps = parsed.steps.map((s: any) => ({ id: s.id, type: s.type, config: s.config || {} }));
        for (const s of parsed.steps) {
          if (Array.isArray(s.routes)) for (const r of s.routes) { if (r.goto) pEdges.push({ from: s.id, to: r.goto, when: r.when, default: r.default }); }
          if (s.next) pEdges.push({ from: s.id, to: s.next });
        }
        if (pEdges.length === 0 && pSteps.length > 1) for (let i = 0; i < pSteps.length - 1; i++) pEdges.push({ from: pSteps[i]!.id, to: pSteps[i + 1]!.id });
      }
    } catch { return c.json({ error: "Failed to parse pipeline YAML" }, 422); }
  } else {
    pSteps = [{ id: "extract", type: "extract", config: { schema: pipeline.schemaSlug || "" } }];
  }
  if (pSteps.length === 0) return c.json({ error: "Pipeline has no steps" }, 422);

  // Find entry step
  const withIncoming = new Set(pEdges.map(e => e.to));
  let currentId: string | null = pSteps.find(s => !withIncoming.has(s.id))?.id || pSteps[0]?.id || null;

  // Resume support for step mode
  if (mode === "step" && body.resume_from) currentId = body.resume_from as string;
  const stepOutputs: Record<string, Record<string, unknown>> = {};
  if (mode === "step" && body.step_outputs) { try { Object.assign(stepOutputs, JSON.parse(body.step_outputs as string)); } catch {} }

  const results: Array<any> = [];
  const path: string[] = [];
  let stepOrder = 0;

  // SSE streaming
  if (stream) {
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        async function streamBranch(branchStartId: string | null, branchDocInfo?: typeof docInfo) {
          const activeDocInfo = branchDocInfo || docInfo;
          let branchId = branchStartId;
          while (branchId && stepOrder < 20) {
            const step = pSteps.find(s => s.id === branchId);
            if (!step) break;
            if (stepOutputs[branchId]) { branchId = resolveTestNextStep(pEdges.filter(e => e.from === branchId), stepOutputs[branchId]!); continue; }
            stepOrder++;
            send("step_start", { stepId: step.id, stepType: step.type, stepOrder });
            const t0 = Date.now();
            const result = await executeTestStep(step, activeDocInfo, stepOutputs, testCtx);
            const ms = Date.now() - t0;
            const outEdges = pEdges.filter(e => e.from === step.id);
            const nextIds = resolveTestNextSteps(outEdges, result.output);
            const evals = outEdges.map(e => ({ to: e.to, condition: e.when || (e.default ? "default" : undefined), matched: nextIds.includes(e.to) }));
            const sr = { stepId: step.id, stepType: step.type, status: result.ok ? "completed" : "failed", output: result.output, durationMs: ms, costUsd: result.costUsd, error: result.error, edgeEvaluations: evals };
            results.push(sr); path.push(step.id);
            if (result.ok) stepOutputs[step.id] = result.output;
            send("step_complete", sr);
            if (!result.ok) break;
            if (mode === "step") { send("pipeline_paused", { nextStepId: nextIds[0] ?? null, completedSteps: path, stepOutputs }); return; }

            // Split fan-out with real child documents
            if (step.type === "split" && result.ok && result.output.children) {
              const children = result.output.children as Array<{ group: { startPage: number; endPage: number; type: string }; text?: string; pageCount: number; filename: string }>;
              for (const child of children) {
                const childDocInfo = { ...activeDocInfo, filename: child.filename, text: child.text, pageCount: child.pageCount };
                const childStepOutputs = { ...stepOutputs };
                childStepOutputs[step.id] = { ...result.output, current_group: child.group };
                Object.assign(stepOutputs, childStepOutputs);
                send("split_child", { group: child.group, filename: child.filename, pageCount: child.pageCount });
                for (const nextId of nextIds) { await streamBranch(nextId, childDocInfo); }
              }
              return;
            }

            if (nextIds.length > 1) {
              await Promise.all(nextIds.map(nextId => streamBranch(nextId, activeDocInfo)));
              return;
            }
            branchId = nextIds[0] ?? null;
          }
        }
        await streamBranch(currentId);
        send("pipeline_complete", { status: "completed", path, skippedSteps: pSteps.filter(s => !path.includes(s.id)).map(s => s.id), totalDurationMs: results.reduce((a: number, r: any) => a + r.durationMs, 0), totalCostUsd: results.reduce((a: number, r: any) => a + r.costUsd, 0), documentInfo: { filename: docInfo.filename, pageCount: docInfo.pageCount, mimeType: docInfo.mimeType } });
        controller.close();
      },
    });
    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
  }

  // Non-streaming — with parallel fan-out support
  async function runBranch(startId: string | null, branchDocInfo?: typeof docInfo) {
    const activeDocInfo = branchDocInfo || docInfo;
    let branchId = startId;
    while (branchId && stepOrder < 20) {
      const step = pSteps.find(s => s.id === branchId);
      if (!step) break;
      if (stepOutputs[branchId]) { branchId = resolveTestNextStep(pEdges.filter(e => e.from === branchId), stepOutputs[branchId]!); continue; }
      stepOrder++;
      const t0 = Date.now();
      const result = await executeTestStep(step, activeDocInfo, stepOutputs, testCtx);
      const ms = Date.now() - t0;
      const outEdges = pEdges.filter(e => e.from === step.id);
      const nextIds = resolveTestNextSteps(outEdges, result.output);
      const evals = outEdges.map(e => ({ to: e.to, condition: e.when || (e.default ? "default" : undefined), matched: nextIds.includes(e.to) }));
      results.push({ stepId: step.id, stepType: step.type, status: result.ok ? "completed" : "failed", output: result.output, durationMs: ms, costUsd: result.costUsd, error: result.error, edgeEvaluations: evals });
      path.push(step.id);
      if (result.ok) stepOutputs[step.id] = result.output;
      if (!result.ok) break;
      if (mode === "step") return;

      // Split fan-out: run downstream steps for each child document
      if (step.type === "split" && result.ok && result.output.children) {
        const children = result.output.children as Array<{ group: { startPage: number; endPage: number; type: string }; text?: string; pageCount: number; filename: string; storageKey?: string; previewUrl?: string; fileBuffer?: Buffer }>;
        const childBranches = nextIds.length > 0 ? nextIds : [];
        for (const child of children) {
          // Lazy parse: only parse child PDF if a downstream step needs text
          let childText = child.text;
          if (!childText && child.fileBuffer && activeDocInfo.parseProvider?.parse) {
            const hasExtractStep = childBranches.some((id) => pSteps.find((s) => s.id === id)?.type === "extract");
            if (hasExtractStep) {
              try {
                const parseResult = await activeDocInfo.parseProvider.parse({ filename: child.filename, mimeType: "application/pdf", fileBuffer: child.fileBuffer });
                childText = parseResult.markdown;
              } catch { /* parse failed */ }
            }
          }
          const childDocInfo = {
            ...activeDocInfo,
            filename: child.filename,
            text: childText,
            pageCount: child.pageCount,
            fileBuffer: child.fileBuffer ?? activeDocInfo.fileBuffer,
          };
          // Set the split output for this child so filter/webhook can access group type + URL
          const childStepOutputs = { ...stepOutputs };
          childStepOutputs[step.id] = {
            ...result.output,
            current_group: child.group,
            document_url: child.previewUrl,
            storage_key: child.storageKey,
          };
          for (const nextId of childBranches) {
            const savedOutputs = { ...stepOutputs };
            Object.assign(stepOutputs, childStepOutputs);
            results.push({
              stepId: `${step.id}:${child.group.type.replace(/\s+/g, "_")}_p${child.group.startPage}-${child.group.endPage}`,
              stepType: "split_child",
              status: "completed",
              output: {
                group: child.group,
                filename: child.filename,
                pageCount: child.pageCount,
                textLength: child.text?.length ?? 0,
                previewUrl: child.previewUrl,
              },
              durationMs: 0,
              costUsd: 0,
            });
            path.push(`${step.id}:child`);
            await runBranch(nextId, childDocInfo);
            Object.assign(stepOutputs, savedOutputs);
          }
        }
        return;
      }

      // Regular fan-out: run each matching branch
      if (nextIds.length > 1) {
        await Promise.all(nextIds.map(nextId => runBranch(nextId, activeDocInfo)));
        return;
      }
      branchId = nextIds[0] ?? null;
    }
  }

  await runBranch(currentId);

  if (mode === "step" && results.length > 0) {
    const lastResult = results[results.length - 1];
    const outEdges = pEdges.filter(e => e.from === lastResult.stepId);
    const nextId = resolveTestNextStep(outEdges, lastResult.output);
    return c.json({ status: "paused", currentStep: lastResult, nextStepId: nextId, completedSteps: path, stepOutputs });
  }

  return c.json({ status: "completed", steps: results, path, skippedSteps: pSteps.filter(s => !path.includes(s.id)).map(s => s.id), totalDurationMs: results.reduce((a, r) => a + r.durationMs, 0), totalCostUsd: results.reduce((a, r) => a + r.costUsd, 0), documentInfo: docInfo });
});
