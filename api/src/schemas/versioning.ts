/**
 * Schema version lifecycle: snapshot a candidate (`-rc`), graduate a candidate
 * to a release, or release directly. Activation (`schemas.currentVersionId`) is
 * decoupled from snapshotting — `validate` snapshots candidates without ever
 * touching the live pointer; only promote/release move it.
 *
 * See docs/schema-semver-versioning.md and ./semver.ts, ./schema-diff.ts.
 */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS, type Db } from "@koji/db";
import { deriveBump } from "./schema-diff";
import { bumpTarget, formatSemver, nextRcNumber, type Bump, type Semver } from "./semver";

export function hashYaml(yaml: string): string {
  return createHash("sha256").update(yaml).digest("hex");
}

export interface VersionRef extends Semver {
  id: string;
  versionNumber: number;
}

const SEMVER_COLS = {
  id: schema.schemaVersions.id,
  versionNumber: schema.schemaVersions.versionNumber,
  major: schema.schemaVersions.major,
  minor: schema.schemaVersions.minor,
  patch: schema.schemaVersions.patch,
  prerelease: schema.schemaVersions.prerelease,
} as const;

export interface SnapshotResult extends VersionRef {
  /** The bump derived (or overridden) vs the active release; null on dedup. */
  bump: Bump | null;
  /** True when an existing version with the same content was reused. */
  deduped: boolean;
}

/**
 * Snapshot YAML as a release **candidate** (`v{target}-rc.N`), without
 * activating it. Dedups by content hash — re-validating identical YAML reuses
 * the existing version (released or candidate) and only the run is new.
 */
export async function snapshotCandidate(
  db: Db,
  tenantId: string,
  opts: {
    schemaId: string;
    yaml: string;
    parsed: Record<string, unknown>;
    userId: string;
    bumpOverride?: Bump;
    commitMessage?: string;
  },
): Promise<SnapshotResult> {
  const yamlHash = hashYaml(opts.yaml);
  return withRLS(db, tenantId, async (tx) => {
    // Dedup by content.
    const [existing] = await tx
      .select(SEMVER_COLS)
      .from(schema.schemaVersions)
      .where(and(eq(schema.schemaVersions.schemaId, opts.schemaId), eq(schema.schemaVersions.yamlHash, yamlHash)))
      .limit(1);
    if (existing) return { ...existing, bump: null, deduped: true };

    // Active release (what currentVersionId points at), for bump derivation.
    const [sch] = await tx
      .select({ currentVersionId: schema.schemas.currentVersionId })
      .from(schema.schemas)
      .where(eq(schema.schemas.id, opts.schemaId))
      .limit(1);
    let active: { major: number; minor: number; patch: number; parsedJson: unknown } | null = null;
    if (sch?.currentVersionId) {
      const [v] = await tx
        .select({
          major: schema.schemaVersions.major,
          minor: schema.schemaVersions.minor,
          patch: schema.schemaVersions.patch,
          parsedJson: schema.schemaVersions.parsedJson,
        })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.id, sch.currentVersionId))
        .limit(1);
      active = v ?? null;
    }

    const bump: Bump = opts.bumpOverride ?? deriveBump((active?.parsedJson as Record<string, unknown>) ?? null, opts.parsed);
    const target = active ? bumpTarget(active, bump) : { major: 0, minor: 0, patch: 1 };

    // rc.N for this target release.
    const cands = await tx
      .select({ prerelease: schema.schemaVersions.prerelease })
      .from(schema.schemaVersions)
      .where(
        and(
          eq(schema.schemaVersions.schemaId, opts.schemaId),
          eq(schema.schemaVersions.major, target.major),
          eq(schema.schemaVersions.minor, target.minor),
          eq(schema.schemaVersions.patch, target.patch),
          isNotNull(schema.schemaVersions.prerelease),
        ),
      );
    const prerelease = `rc.${nextRcNumber(cands.map((c) => c.prerelease))}`;

    const versionNumber = await nextVersionNumber(tx, opts.schemaId);
    const [row] = await tx
      .insert(schema.schemaVersions)
      .values({
        tenantId,
        schemaId: opts.schemaId,
        versionNumber,
        major: target.major,
        minor: target.minor,
        patch: target.patch,
        prerelease,
        yamlSource: opts.yaml,
        yamlHash,
        parsedJson: opts.parsed,
        commitMessage: opts.commitMessage ?? null,
        committedBy: opts.userId,
      })
      .returning(SEMVER_COLS);
    return { ...row!, bump, deduped: false };
  });
}

/**
 * Graduate a candidate to a release: clear its prerelease (`v0.0.4-rc.7 →
 * v0.0.4`) and point `currentVersionId` at it. Returns the released label, or
 * `null` if the candidate doesn't exist / isn't a candidate, or a release
 * already occupies that `x.y.z` (the released-semver unique index).
 */
export async function graduateCandidate(
  db: Db,
  tenantId: string,
  schemaId: string,
  versionId: string,
): Promise<{ label: string } | { error: "not_found" | "already_released" }> {
  return withRLS(db, tenantId, async (tx) => {
    const [v] = await tx
      .select(SEMVER_COLS)
      .from(schema.schemaVersions)
      .where(and(eq(schema.schemaVersions.id, versionId), eq(schema.schemaVersions.schemaId, schemaId)))
      .limit(1);
    if (!v || v.prerelease === null) return { error: "not_found" as const };

    // Refuse if a release already holds this x.y.z.
    const [clash] = await tx
      .select({ id: schema.schemaVersions.id })
      .from(schema.schemaVersions)
      .where(
        and(
          eq(schema.schemaVersions.schemaId, schemaId),
          eq(schema.schemaVersions.major, v.major),
          eq(schema.schemaVersions.minor, v.minor),
          eq(schema.schemaVersions.patch, v.patch),
          isNull(schema.schemaVersions.prerelease),
        ),
      )
      .limit(1);
    if (clash) return { error: "already_released" as const };

    await tx
      .update(schema.schemaVersions)
      .set({ prerelease: null })
      .where(eq(schema.schemaVersions.id, versionId));
    await tx
      .update(schema.schemas)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(schema.schemas.id, schemaId));

    return { label: formatSemver({ major: v.major, minor: v.minor, patch: v.patch, prerelease: null }) };
  });
}

/**
 * Release YAML directly (skip rc) — the early-stage / empty-corpus path. Dedups
 * by hash: an existing candidate with this content graduates; an existing
 * release re-activates; otherwise a new released version is created. Activates it.
 */
export async function releaseDirect(
  db: Db,
  tenantId: string,
  opts: {
    schemaId: string;
    yaml: string;
    parsed: Record<string, unknown>;
    userId: string;
    bumpOverride?: Bump;
    commitMessage?: string;
  },
): Promise<{ id: string; label: string } | { error: "already_released" }> {
  const yamlHash = hashYaml(opts.yaml);
  return withRLS(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select(SEMVER_COLS)
      .from(schema.schemaVersions)
      .where(and(eq(schema.schemaVersions.schemaId, opts.schemaId), eq(schema.schemaVersions.yamlHash, yamlHash)))
      .limit(1);

    if (existing) {
      // Same content already a version. Graduate if candidate, else re-activate.
      if (existing.prerelease !== null) {
        await tx
          .update(schema.schemaVersions)
          .set({ prerelease: null })
          .where(eq(schema.schemaVersions.id, existing.id));
      }
      await tx
        .update(schema.schemas)
        .set({ currentVersionId: existing.id, updatedAt: new Date() })
        .where(eq(schema.schemas.id, opts.schemaId));
      return {
        id: existing.id,
        label: formatSemver({ major: existing.major, minor: existing.minor, patch: existing.patch, prerelease: null }),
      };
    }

    const [sch] = await tx
      .select({ currentVersionId: schema.schemas.currentVersionId })
      .from(schema.schemas)
      .where(eq(schema.schemas.id, opts.schemaId))
      .limit(1);
    let active: { major: number; minor: number; patch: number; parsedJson: unknown } | null = null;
    if (sch?.currentVersionId) {
      const [v] = await tx
        .select({
          major: schema.schemaVersions.major,
          minor: schema.schemaVersions.minor,
          patch: schema.schemaVersions.patch,
          parsedJson: schema.schemaVersions.parsedJson,
        })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.id, sch.currentVersionId))
        .limit(1);
      active = v ?? null;
    }
    const bump: Bump = opts.bumpOverride ?? deriveBump((active?.parsedJson as Record<string, unknown>) ?? null, opts.parsed);
    const target = active ? bumpTarget(active, bump) : { major: 0, minor: 0, patch: 1 };

    const versionNumber = await nextVersionNumber(tx, opts.schemaId);
    const [row] = await tx
      .insert(schema.schemaVersions)
      .values({
        tenantId,
        schemaId: opts.schemaId,
        versionNumber,
        major: target.major,
        minor: target.minor,
        patch: target.patch,
        prerelease: null,
        yamlSource: opts.yaml,
        yamlHash,
        parsedJson: opts.parsed,
        commitMessage: opts.commitMessage ?? null,
        committedBy: opts.userId,
      })
      .returning(SEMVER_COLS)
      .catch(() => [null]);
    if (!row) return { error: "already_released" as const };

    await tx
      .update(schema.schemas)
      .set({ currentVersionId: row.id, updatedAt: new Date() })
      .where(eq(schema.schemas.id, opts.schemaId));
    return { id: row.id, label: formatSemver({ major: row.major, minor: row.minor, patch: row.patch, prerelease: null }) };
  });
}

async function nextVersionNumber(tx: Parameters<Parameters<typeof withRLS>[2]>[0], schemaId: string): Promise<number> {
  const [latest] = await tx
    .select({ versionNumber: schema.schemaVersions.versionNumber })
    .from(schema.schemaVersions)
    .where(eq(schema.schemaVersions.schemaId, schemaId))
    .orderBy(desc(schema.schemaVersions.versionNumber))
    .limit(1);
  return (latest?.versionNumber ?? 0) + 1;
}
