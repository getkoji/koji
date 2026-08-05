/**
 * Resolve which schema version a pipeline runs — honoring its `versionMode`.
 *
 *   - `auto` (default): the schema's current live release (`currentVersionId`),
 *     so a promotion is picked up immediately.
 *   - `pinned`: the version in `pipelines.activeSchemaVersionId`, but ONLY for
 *     the schema that pin belongs to (a single pin can't cover multiple schemas
 *     in a DAG, so non-matching schemas fall back to live).
 *
 * Before P2 the runner always read `currentVersionId`; that's preserved as the
 * `auto` default, so existing pipelines behave identically.
 */
import { and, eq } from "drizzle-orm";
import { schema, withRLS, type Db } from "@koji/db";

/** Pure decision — which version id wins. Unit-tested without a database. */
export function pickVersionId(input: {
  versionMode: string | null | undefined;
  activeSchemaVersionId: string | null | undefined;
  pinBelongsToSchema: boolean;
  currentVersionId: string | null | undefined;
}): string | null {
  if (input.versionMode === "pinned" && input.activeSchemaVersionId && input.pinBelongsToSchema) {
    return input.activeSchemaVersionId;
  }
  return input.currentVersionId ?? null;
}

/**
 * Resolve the compiled schema (`parsedJson`) a pipeline should extract
 * `schemaSlug` with, applying the pipeline's `versionMode`. Returns null if the
 * schema/version can't be resolved.
 */
export async function resolvePipelineSchemaVersion(
  db: Db,
  tenantId: string,
  pipelineId: string,
  schemaSlug: string,
): Promise<{ parsedJson: Record<string, unknown>; schemaId: string; versionId: string } | null> {
  // Load the pipeline first: schema slugs are only unique per PROJECT, so the
  // slug lookup below must be confined to the pipeline's project or a
  // same-slug schema in a sibling project could win the race.
  const [p] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        projectId: schema.pipelines.projectId,
        versionMode: schema.pipelines.versionMode,
        activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, pipelineId))
      .limit(1),
  );
  if (!p) return null;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.schemas.id, currentVersionId: schema.schemas.currentVersionId })
      .from(schema.schemas)
      .where(and(eq(schema.schemas.slug, schemaSlug), eq(schema.schemas.projectId, p.projectId)))
      .limit(1),
  );
  if (!s) return null;

  // A pin is honored only if it points at a version of *this* schema.
  let pinBelongsToSchema = false;
  if (p?.versionMode === "pinned" && p.activeSchemaVersionId) {
    const [pin] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ id: schema.schemaVersions.id })
        .from(schema.schemaVersions)
        .where(and(eq(schema.schemaVersions.id, p.activeSchemaVersionId!), eq(schema.schemaVersions.schemaId, s.id)))
        .limit(1),
    );
    pinBelongsToSchema = !!pin;
  }

  const versionId = pickVersionId({
    versionMode: p?.versionMode,
    activeSchemaVersionId: p?.activeSchemaVersionId,
    pinBelongsToSchema,
    currentVersionId: s.currentVersionId,
  });
  if (!versionId) return null;

  const [ver] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ parsedJson: schema.schemaVersions.parsedJson })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.id, versionId))
      .limit(1),
  );
  return ver?.parsedJson
    ? { parsedJson: ver.parsedJson as Record<string, unknown>, schemaId: s.id, versionId }
    : null;
}
