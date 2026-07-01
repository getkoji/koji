/**
 * Classifier version lifecycle — the schema-sibling of api/src/schemas/versioning.ts.
 *
 * Snapshot a candidate (`-rc`), graduate a candidate to a release, or release
 * directly. Activation (`classifiers.currentVersionId`) is decoupled from
 * snapshotting — a candidate is committed without ever touching the live
 * pointer; only promote/release move it.
 *
 * The semver math is shared with schemas (../schemas/semver.ts); only the
 * tables and the bump-derivation differ (classes vs fields).
 */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS, type Db } from "@koji/db";
import { deriveClassifierBump } from "./classifier-diff";
import { bumpTarget, formatSemver, nextRcNumber, type Bump, type Semver } from "../schemas/semver";

export function hashYaml(yaml: string): string {
  return createHash("sha256").update(yaml).digest("hex");
}

export interface VersionRef extends Semver {
  id: string;
  versionNumber: number;
}

const SEMVER_COLS = {
  id: schema.classifierVersions.id,
  versionNumber: schema.classifierVersions.versionNumber,
  major: schema.classifierVersions.major,
  minor: schema.classifierVersions.minor,
  patch: schema.classifierVersions.patch,
  prerelease: schema.classifierVersions.prerelease,
} as const;

export interface SnapshotResult extends VersionRef {
  /** The bump derived (or overridden) vs the active release; null on dedup. */
  bump: Bump | null;
  /** True when an existing version with the same content was reused. */
  deduped: boolean;
}

/**
 * Snapshot YAML as a release **candidate** (`v{target}-rc.N`), without
 * activating it. Dedups by content hash — re-committing identical YAML reuses
 * the existing version (released or candidate).
 */
export async function snapshotCandidate(
  db: Db,
  tenantId: string,
  opts: {
    classifierId: string;
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
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.classifierId, opts.classifierId),
          eq(schema.classifierVersions.yamlHash, yamlHash),
        ),
      )
      .limit(1);
    if (existing) return { ...existing, bump: null, deduped: true };

    // Active release (what currentVersionId points at), for bump derivation.
    const [cls] = await tx
      .select({ currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.id, opts.classifierId))
      .limit(1);
    let active: { major: number; minor: number; patch: number; parsedJson: unknown } | null = null;
    if (cls?.currentVersionId) {
      const [v] = await tx
        .select({
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          parsedJson: schema.classifierVersions.parsedJson,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.id, cls.currentVersionId))
        .limit(1);
      active = v ?? null;
    }

    const bump: Bump =
      opts.bumpOverride ??
      deriveClassifierBump((active?.parsedJson as Record<string, unknown>) ?? null, opts.parsed);
    const target = active ? bumpTarget(active, bump) : { major: 0, minor: 0, patch: 1 };

    // rc.N for this target release.
    const cands = await tx
      .select({ prerelease: schema.classifierVersions.prerelease })
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.classifierId, opts.classifierId),
          eq(schema.classifierVersions.major, target.major),
          eq(schema.classifierVersions.minor, target.minor),
          eq(schema.classifierVersions.patch, target.patch),
          isNotNull(schema.classifierVersions.prerelease),
        ),
      );
    const prerelease = `rc.${nextRcNumber(cands.map((c) => c.prerelease))}`;

    const versionNumber = await nextVersionNumber(tx, opts.classifierId);
    const [row] = await tx
      .insert(schema.classifierVersions)
      .values({
        tenantId,
        classifierId: opts.classifierId,
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
 * an error if the candidate doesn't exist / isn't a candidate, or a release
 * already occupies that `x.y.z` (the released-semver unique index).
 */
export async function graduateCandidate(
  db: Db,
  tenantId: string,
  classifierId: string,
  versionId: string,
): Promise<{ label: string } | { error: "not_found" | "already_released" }> {
  return withRLS(db, tenantId, async (tx) => {
    const [v] = await tx
      .select(SEMVER_COLS)
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.id, versionId),
          eq(schema.classifierVersions.classifierId, classifierId),
        ),
      )
      .limit(1);
    if (!v || v.prerelease === null) return { error: "not_found" as const };

    // Refuse if a release already holds this x.y.z.
    const [clash] = await tx
      .select({ id: schema.classifierVersions.id })
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.classifierId, classifierId),
          eq(schema.classifierVersions.major, v.major),
          eq(schema.classifierVersions.minor, v.minor),
          eq(schema.classifierVersions.patch, v.patch),
          isNull(schema.classifierVersions.prerelease),
        ),
      )
      .limit(1);
    if (clash) return { error: "already_released" as const };

    await tx
      .update(schema.classifierVersions)
      .set({ prerelease: null })
      .where(eq(schema.classifierVersions.id, versionId));
    await tx
      .update(schema.classifiers)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(schema.classifiers.id, classifierId));

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
    classifierId: string;
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
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.classifierId, opts.classifierId),
          eq(schema.classifierVersions.yamlHash, yamlHash),
        ),
      )
      .limit(1);

    if (existing) {
      // Same content already a version. Graduate if candidate, else re-activate.
      if (existing.prerelease !== null) {
        await tx
          .update(schema.classifierVersions)
          .set({ prerelease: null })
          .where(eq(schema.classifierVersions.id, existing.id));
      }
      await tx
        .update(schema.classifiers)
        .set({ currentVersionId: existing.id, updatedAt: new Date() })
        .where(eq(schema.classifiers.id, opts.classifierId));
      return {
        id: existing.id,
        label: formatSemver({
          major: existing.major,
          minor: existing.minor,
          patch: existing.patch,
          prerelease: null,
        }),
      };
    }

    const [cls] = await tx
      .select({ currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.id, opts.classifierId))
      .limit(1);
    let active: { major: number; minor: number; patch: number; parsedJson: unknown } | null = null;
    if (cls?.currentVersionId) {
      const [v] = await tx
        .select({
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          parsedJson: schema.classifierVersions.parsedJson,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.id, cls.currentVersionId))
        .limit(1);
      active = v ?? null;
    }
    const bump: Bump =
      opts.bumpOverride ??
      deriveClassifierBump((active?.parsedJson as Record<string, unknown>) ?? null, opts.parsed);
    const target = active ? bumpTarget(active, bump) : { major: 0, minor: 0, patch: 1 };

    const versionNumber = await nextVersionNumber(tx, opts.classifierId);
    const [row] = await tx
      .insert(schema.classifierVersions)
      .values({
        tenantId,
        classifierId: opts.classifierId,
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
      .update(schema.classifiers)
      .set({ currentVersionId: row.id, updatedAt: new Date() })
      .where(eq(schema.classifiers.id, opts.classifierId));
    return {
      id: row.id,
      label: formatSemver({ major: row.major, minor: row.minor, patch: row.patch, prerelease: null }),
    };
  });
}

async function nextVersionNumber(
  tx: Parameters<Parameters<typeof withRLS>[2]>[0],
  classifierId: string,
): Promise<number> {
  const [latest] = await tx
    .select({ versionNumber: schema.classifierVersions.versionNumber })
    .from(schema.classifierVersions)
    .where(eq(schema.classifierVersions.classifierId, classifierId))
    .orderBy(desc(schema.classifierVersions.versionNumber))
    .limit(1);
  return (latest?.versionNumber ?? 0) + 1;
}
