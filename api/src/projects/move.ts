/**
 * Move a project-scoped resource to a different project within the same tenant.
 *
 * Project isolation makes resources resolve *within a project* (RESTRICTIVE
 * RLS), so a resource that references another project-scoped resource in a
 * different project is broken — a pipeline whose schema lives elsewhere can't
 * resolve it at run time. So a move must not strand a cross-project reference
 * in EITHER direction: we validate every project-scoped edge incident to the
 * resource and block the move (returning the blockers) rather than silently
 * breaking a pipeline. The caller resolves the blockers by moving those
 * resources first.
 *
 * History follows the resource: moving a pipeline moves its jobs and their
 * review items too, so config and run history stay together.
 *
 * The whole operation runs under a BARE-tenant RLS scope (no project setting).
 * That's required: the project policy's WITH CHECK would otherwise reject
 * writing a row's `project_id` to anything other than the current setting.
 * With no project set, the null-arm passes and we can reassign freely — while
 * tenant isolation still holds.
 */
import { and, eq, ne, sql, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { compilePipeline } from "@koji/pipeline";
import { deriveCredentialId } from "../routes/model-providers";

/**
 * Schema slugs a pipeline references. DAG (and shorthand) pipelines name their
 * schemas by SLUG in each extract step's `config.schema`, compiled from
 * `yamlSource` — NOT via the legacy `schemaId` FK column (which is usually
 * null for DAG pipelines). Resolution is project-scoped at run time, so these
 * slug references are exactly what a move must not strand.
 */
function referencedSchemaSlugs(yamlSource: string | null | undefined): Set<string> {
  const slugs = new Set<string>();
  if (!yamlSource) return slugs;
  let compiled;
  try {
    compiled = compilePipeline(yamlSource);
  } catch {
    return slugs; // an uncompilable pipeline can't meaningfully reference a schema
  }
  if (!compiled.ok) return slugs;
  for (const step of compiled.pipeline.steps) {
    const s = step.config?.schema;
    if (typeof s === "string" && s) slugs.add(s);
  }
  return slugs;
}

export type MovableType =
  | "schema"
  | "pipeline"
  | "source"
  | "classifier"
  | "model_endpoint"
  | "parse_endpoint"
  | "webhook_target"
  | "api_key";

/** The tenant-role write permission that gates moving each resource type. */
export const MOVE_PERMISSION: Record<MovableType, string> = {
  schema: "schema:write",
  pipeline: "pipeline:write",
  source: "source:write",
  classifier: "schema:write",
  model_endpoint: "endpoint:write",
  parse_endpoint: "endpoint:write",
  webhook_target: "webhook:write",
  api_key: "api_key:write",
};

export interface MoveBlocker {
  /** A related resource that would end up cross-project if the move proceeded. */
  type: string;
  slug: string;
  reason: string;
}

export type MoveResult =
  | { status: "moved" }
  | { status: "noop" } // already in the destination
  | { status: "not_found" }
  | { status: "slug_conflict"; conflictWith: string }
  | { status: "blocked"; blockers: MoveBlocker[] };

/**
 * Resolve a movable resource's DB table + slug column. api_keys are named,
 * not slugged; everything else has a `slug`.
 */
function tableFor(type: MovableType) {
  switch (type) {
    case "schema": return { table: schema.schemas, nameCol: "slug" as const, hasDeletedAt: true };
    case "pipeline": return { table: schema.pipelines, nameCol: "slug" as const, hasDeletedAt: true };
    case "source": return { table: schema.sources, nameCol: "slug" as const, hasDeletedAt: true };
    case "classifier": return { table: schema.classifiers, nameCol: "slug" as const, hasDeletedAt: true };
    case "model_endpoint": return { table: schema.modelEndpoints, nameCol: "slug" as const, hasDeletedAt: true };
    case "parse_endpoint": return { table: schema.parseEndpoints, nameCol: "slug" as const, hasDeletedAt: true };
    case "webhook_target": return { table: schema.webhookTargets, nameCol: "slug" as const, hasDeletedAt: false };
    case "api_key": return { table: schema.apiKeys, nameCol: "name" as const, hasDeletedAt: false };
  }
}

/**
 * Move `type`/`resourceId` to `toProjectId`. Returns a discriminated result;
 * the route maps it to an HTTP status.
 */
export async function moveResource(
  db: Db,
  tenantId: string,
  type: MovableType,
  resourceId: string,
  toProjectId: string,
  opts: { dryRun?: boolean } = {},
): Promise<MoveResult> {
  return withRLS(db, tenantId, async (tx) => {
    const { table, nameCol } = tableFor(type);

    // 1. Load the resource (tenant-wide; the RESTRICTIVE project policy passes
    //    because no project is set).
    const [row] = await tx
      .select({
        id: (table as any).id,
        projectId: (table as any).projectId,
        name: (table as any)[nameCol],
      })
      .from(table as any)
      .where(eq((table as any).id, resourceId))
      .limit(1);
    if (!row) return { status: "not_found" };
    if (row.projectId === toProjectId) return { status: "noop" };

    // 2. Slug/name must be free in the destination project.
    const [clash] = await tx
      .select({ id: (table as any).id })
      .from(table as any)
      .where(
        and(
          eq((table as any).projectId, toProjectId),
          eq((table as any)[nameCol], row.name),
          ne((table as any).id, resourceId),
          ...((tableFor(type).hasDeletedAt) ? [isNull((table as any).deletedAt)] : []),
        ),
      )
      .limit(1);
    if (clash) return { status: "slug_conflict", conflictWith: row.name };

    // A model_endpoint drags its paired provider_credentials row (same slug)
    // along in step 4, so that slug must be free in the destination too — else
    // the credential's own unique index would abort the move with a raw 500.
    if (type === "model_endpoint") {
      const [credClash] = await tx
        .select({ id: schema.providerCredentials.id })
        .from(schema.providerCredentials)
        .where(
          and(
            eq(schema.providerCredentials.projectId, toProjectId),
            eq(schema.providerCredentials.slug, row.name),
            ne(schema.providerCredentials.id, deriveCredentialId(resourceId)),
            isNull(schema.providerCredentials.deletedAt),
          ),
        )
        .limit(1);
      if (credClash) return { status: "slug_conflict", conflictWith: row.name };
    }

    // 3. Reference conflicts — anything that would end up cross-project.
    const blockers = await collectBlockers(tx, type, resourceId, toProjectId);
    if (blockers.length > 0) return { status: "blocked", blockers };

    // A dry run stops here — no mutation, just the pre-flight verdict.
    if (opts.dryRun) return { status: "moved" };

    // 4. Reassign project_id (+ paired credential + history cascade).
    await tx.update(table as any).set({ projectId: toProjectId }).where(eq((table as any).id, resourceId));

    if (type === "model_endpoint") {
      // The paired provider_credentials row (same derived id) must move too so
      // the credential→model resolver keeps seeing it in the same project.
      await tx
        .update(schema.providerCredentials)
        .set({ projectId: toProjectId })
        .where(eq(schema.providerCredentials.id, deriveCredentialId(resourceId)));
    }

    if (type === "pipeline") {
      // History follows: the pipeline's jobs and their review items.
      await tx.update(schema.jobs).set({ projectId: toProjectId }).where(eq(schema.jobs.pipelineId, resourceId));
      await tx.execute(sql`
        UPDATE review_items SET project_id = ${toProjectId}
        WHERE document_id IN (
          SELECT d.id FROM documents d
          JOIN jobs j ON j.id = d.job_id
          WHERE j.pipeline_id = ${resourceId}
        )
      `);
    }

    return { status: "moved" };
  });
}

/**
 * Collect the project-scoped resources that would be stranded (left in a
 * different project) if `resourceId` moved to `toProjectId`.
 */
async function collectBlockers(
  tx: any,
  type: MovableType,
  resourceId: string,
  toProjectId: string,
): Promise<MoveBlocker[]> {
  const blockers: MoveBlocker[] = [];

  const pipelinesUsingSchema = async (schemaId: string, schemaSlug: string) => {
    // Two ways a pipeline references a schema, both project-scoped at runtime:
    //   - the legacy `schemaId` FK (simple pipelines), and
    //   - a `config.schema` SLUG in a DAG extract step (compiled from yaml).
    // Any such pipeline left in a different project would break, so it blocks.
    const candidates = await tx
      .select({
        slug: schema.pipelines.slug,
        schemaId: schema.pipelines.schemaId,
        yamlSource: schema.pipelines.yamlSource,
      })
      .from(schema.pipelines)
      .where(and(isNull(schema.pipelines.deletedAt), ne(schema.pipelines.projectId, toProjectId)));
    return candidates
      .filter(
        (r: any) => r.schemaId === schemaId || referencedSchemaSlugs(r.yamlSource).has(schemaSlug),
      )
      .map((r: any) => ({ type: "pipeline", slug: r.slug, reason: "uses this schema" }));
  };

  const pipelinesUsingEndpoint = async (col: "modelProviderId" | "parseProviderId") => {
    const rows = await tx
      .select({ slug: schema.pipelines.slug })
      .from(schema.pipelines)
      .where(
        and(
          isNull(schema.pipelines.deletedAt),
          ne(schema.pipelines.projectId, toProjectId),
          eq(schema.pipelines[col], resourceId),
        ),
      );
    return rows.map((r: any) => ({ type: "pipeline", slug: r.slug, reason: "uses this endpoint" }));
  };

  switch (type) {
    case "schema": {
      const [s] = await tx
        .select({ slug: schema.schemas.slug })
        .from(schema.schemas)
        .where(eq(schema.schemas.id, resourceId))
        .limit(1);
      if (s) blockers.push(...(await pipelinesUsingSchema(resourceId, s.slug)));
      break;
    }
    case "pipeline": {
      const [p] = await tx
        .select({
          schemaId: schema.pipelines.schemaId,
          yamlSource: schema.pipelines.yamlSource,
          modelProviderId: schema.pipelines.modelProviderId,
          parseProviderId: schema.pipelines.parseProviderId,
        })
        .from(schema.pipelines)
        .where(eq(schema.pipelines.id, resourceId))
        .limit(1);
      if (p?.schemaId) {
        const [sc] = await tx
          .select({ slug: schema.schemas.slug, projectId: schema.schemas.projectId })
          .from(schema.schemas)
          .where(eq(schema.schemas.id, p.schemaId))
          .limit(1);
        if (sc && sc.projectId !== toProjectId) {
          blockers.push({ type: "schema", slug: sc.slug, reason: "this pipeline's schema is in another project" });
        }
      }
      // DAG extract steps reference schemas by slug — every referenced slug
      // must resolve to a schema in the destination project after the move.
      for (const slug of referencedSchemaSlugs(p?.yamlSource)) {
        const [sc] = await tx
          .select({ id: schema.schemas.id })
          .from(schema.schemas)
          .where(
            and(
              eq(schema.schemas.slug, slug),
              eq(schema.schemas.projectId, toProjectId),
              isNull(schema.schemas.deletedAt),
            ),
          )
          .limit(1);
        if (!sc) {
          blockers.push({ type: "schema", slug, reason: "this pipeline extracts with a schema not present in the destination" });
        }
      }
      if (p?.modelProviderId) {
        const [ep] = await tx
          .select({ slug: schema.modelEndpoints.slug, projectId: schema.modelEndpoints.projectId })
          .from(schema.modelEndpoints)
          .where(eq(schema.modelEndpoints.id, p.modelProviderId))
          .limit(1);
        if (ep && ep.projectId !== toProjectId) {
          blockers.push({ type: "model_endpoint", slug: ep.slug, reason: "this pipeline's model endpoint is in another project" });
        }
      }
      if (p?.parseProviderId) {
        const [ep] = await tx
          .select({ slug: schema.parseEndpoints.slug, projectId: schema.parseEndpoints.projectId })
          .from(schema.parseEndpoints)
          .where(eq(schema.parseEndpoints.id, p.parseProviderId))
          .limit(1);
        if (ep && ep.projectId !== toProjectId) {
          blockers.push({ type: "parse_endpoint", slug: ep.slug, reason: "this pipeline's parse endpoint is in another project" });
        }
      }
      const srcs = await tx
        .select({ slug: schema.sources.slug })
        .from(schema.sources)
        .where(
          and(
            isNull(schema.sources.deletedAt),
            ne(schema.sources.projectId, toProjectId),
            eq(schema.sources.targetPipelineId, resourceId),
          ),
        );
      blockers.push(...srcs.map((r: any) => ({ type: "source", slug: r.slug, reason: "targets this pipeline" })));
      break;
    }
    case "source": {
      const [src] = await tx
        .select({ targetPipelineId: schema.sources.targetPipelineId })
        .from(schema.sources)
        .where(eq(schema.sources.id, resourceId))
        .limit(1);
      if (src?.targetPipelineId) {
        const [pl] = await tx
          .select({ slug: schema.pipelines.slug, projectId: schema.pipelines.projectId })
          .from(schema.pipelines)
          .where(eq(schema.pipelines.id, src.targetPipelineId))
          .limit(1);
        if (pl && pl.projectId !== toProjectId) {
          blockers.push({ type: "pipeline", slug: pl.slug, reason: "this source's target pipeline is in another project" });
        }
      }
      break;
    }
    case "model_endpoint":
      blockers.push(...(await pipelinesUsingEndpoint("modelProviderId")));
      break;
    case "parse_endpoint":
      blockers.push(...(await pipelinesUsingEndpoint("parseProviderId")));
      break;
    case "classifier":
    case "webhook_target":
    case "api_key":
      // No project-scoped resource references these by a hard edge that the
      // engine resolves cross-project. (Corpus entries follow their schema.)
      break;
  }

  return blockers;
}
