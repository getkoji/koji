import { Hono } from "hono";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";
import { loadClassifierConfig, ClassifierConfigError } from "../classify";
import type { ClassifierConfig } from "../classify";
import { snapshotCandidate, graduateCandidate, releaseDirect } from "../classifiers/versioning";
import { reactivateRefusalBody } from "../schemas/release-policy";
import { formatSemver, type Bump } from "../schemas/semver";

/**
 * Classifier config artifact routes — the schema-sibling of ../routes/schemas.ts.
 *
 * A classifier stores YAML defining the document classes the cascade engine can
 * assign (see ../classify). This surface is its CRUD + semver versioning: same
 * released/candidate (`rc.N`) lifecycle as an extraction schema, validated with
 * the engine's own `loadClassifierConfig` so a stored version is always a config
 * the engine can run. Permissions mirror the schema routes exactly.
 */

const DEFAULT_TEMPLATE = `name: my_classifier
description: ""

classes:
  example_class:
    description: "Describe this document class"
    keywords:
      - example
`;

/** Validate YAML with the engine; return the normalized config as parsedJson. */
function compileClassifier(
  yamlSource: string,
): { ok: true; parsed: ClassifierConfig } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: loadClassifierConfig(yamlSource) };
  } catch (err) {
    if (err instanceof ClassifierConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

export const classifiers = new Hono<Env>();

// ── CRUD ──

classifiers.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifiers.id,
        slug: schema.classifiers.slug,
        displayName: schema.classifiers.displayName,
        description: schema.classifiers.description,
        currentVersionId: schema.classifiers.currentVersionId,
        createdAt: schema.classifiers.createdAt,
      })
      .from(schema.classifiers)
      .where(sql`deleted_at IS NULL`),
  );

  const enriched = [];
  for (const row of rows) {
    let latestVersion: number | null = null;
    let latestVersionLabel: string | null = null;
    const [cv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .select({
          versionNumber: schema.classifierVersions.versionNumber,
          major: schema.classifierVersions.major,
          minor: schema.classifierVersions.minor,
          patch: schema.classifierVersions.patch,
          prerelease: schema.classifierVersions.prerelease,
        })
        .from(schema.classifierVersions)
        .where(eq(schema.classifierVersions.classifierId, row.id))
        .orderBy(desc(schema.classifierVersions.versionNumber))
        .limit(1),
    );
    if (cv) {
      latestVersion = cv.versionNumber;
      latestVersionLabel = formatSemver(cv);
    }
    enriched.push({ ...row, latestVersion, latestVersionLabel });
  }

  return c.json({ data: enriched });
});

classifiers.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select().from(schema.classifiers).where(eq(schema.classifiers.slug, slug)).limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  let latestVersion: {
    versionNumber: number;
    version: string;
    yamlSource: string;
    commitMessage: string | null;
    createdAt: Date;
  } | null = null;
  const [cv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        versionNumber: schema.classifierVersions.versionNumber,
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
        yamlSource: schema.classifierVersions.yamlSource,
        commitMessage: schema.classifierVersions.commitMessage,
        createdAt: schema.classifierVersions.createdAt,
      })
      .from(schema.classifierVersions)
      .where(eq(schema.classifierVersions.classifierId, cls.id))
      .orderBy(desc(schema.classifierVersions.versionNumber))
      .limit(1),
  );
  if (cv) {
    const { major: _ma, minor: _mi, patch: _pa, prerelease: _pr, ...rest } = cv;
    latestVersion = { ...rest, version: formatSemver(cv) };
  }

  return c.json({ ...cls, latestVersion });
});

classifiers.post("/", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    slug: string;
    display_name: string;
    description?: string;
    initial_yaml?: string;
  }>();

  if (!body.slug || !body.display_name) {
    return c.json({ error: "slug and display_name are required" }, 400);
  }

  const yamlSource = body.initial_yaml ?? DEFAULT_TEMPLATE.replace("my_classifier", body.slug);
  const result = compileClassifier(yamlSource);
  if (!result.ok) {
    return c.json({ error: "Invalid initial YAML", details: result.error }, 400);
  }

  const yamlHash = createHash("sha256").update(yamlSource).digest("hex");

  const [newClassifier] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.classifiers)
      .values({
        tenantId,
        projectId: requireProjectId(c),
        slug: body.slug,
        displayName: body.display_name,
        description: body.description ?? null,
        draftYaml: yamlSource,
        createdBy: principal.userId,
      })
      .returning(),
  );

  const [v1] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.classifierVersions)
      .values({
        tenantId,
        classifierId: newClassifier!.id,
        versionNumber: 1,
        // First release is v0.0.1 — same convention as the lifecycle helpers
        // when there is no active release to bump from.
        major: 0,
        minor: 0,
        patch: 1,
        yamlSource,
        yamlHash,
        parsedJson: result.parsed,
        commitMessage: "Initial version",
        committedBy: principal.userId,
      })
      .returning(),
  );

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.classifiers)
      .set({ currentVersionId: v1!.id })
      .where(eq(schema.classifiers.id, newClassifier!.id)),
  );

  return c.json({ ...newClassifier, latestVersion: 1, latestVersionLabel: formatSemver(v1!) }, 201);
});

classifiers.patch("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req.json<{
    display_name?: string;
    description?: string;
    draft_yaml?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.draft_yaml !== undefined) {
    updates.draftYaml = body.draft_yaml;
    updates.draftUpdatedAt = new Date();
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.classifiers).set(updates).where(eq(schema.classifiers.slug, slug)).returning(),
  );
  if (rows.length === 0) return c.json({ error: "Classifier not found" }, 404);
  return c.json(rows[0]);
});

classifiers.delete("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.classifiers)
      .set({ deletedAt: new Date() })
      .where(eq(schema.classifiers.slug, slug)),
  );
  return c.body(null, 204);
});

// ── Versions ──

classifiers.get("/:slug/versions", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, currentVersionId: schema.classifiers.currentVersionId })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.classifierVersions.id,
        versionNumber: schema.classifierVersions.versionNumber,
        major: schema.classifierVersions.major,
        minor: schema.classifierVersions.minor,
        patch: schema.classifierVersions.patch,
        prerelease: schema.classifierVersions.prerelease,
        commitMessage: schema.classifierVersions.commitMessage,
        committedByName: schema.users.name,
        createdAt: schema.classifierVersions.createdAt,
      })
      .from(schema.classifierVersions)
      .innerJoin(schema.users, eq(schema.users.id, schema.classifierVersions.committedBy))
      .where(eq(schema.classifierVersions.classifierId, cls.id))
      .orderBy(desc(schema.classifierVersions.versionNumber)),
  );

  const data = rows.map((v) => ({
    ...v,
    version: formatSemver(v),
    released: v.prerelease === null,
    active: v.id === cls.currentVersionId,
  }));
  return c.json({ data });
});

classifiers.get("/:slug/versions/:v", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const versionNum = parseInt(c.req.param("v")!, 10);

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const [version] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select()
      .from(schema.classifierVersions)
      .where(
        and(
          eq(schema.classifierVersions.classifierId, cls.id),
          eq(schema.classifierVersions.versionNumber, versionNum),
        ),
      )
      .limit(1),
  );
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json(version);
});

classifiers.post("/:slug/versions", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    yaml_source?: string;
    yaml?: string;
    commit_message?: string;
    candidate?: boolean;
    bump?: Bump;
    allow_reactivate?: boolean;
  }>();

  // Accept `yaml_source` (the artifact-native field name) or `yaml` (schema-route parity).
  const yamlSource = body.yaml_source ?? body.yaml;
  if (!yamlSource) return c.json({ error: "yaml_source is required" }, 400);

  const result = compileClassifier(yamlSource);
  if (!result.ok) {
    return c.json({ error: "Classifier validation failed", details: result.error }, 400);
  }

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  // candidate=true  → snapshot a non-active candidate (Save as candidate)
  // else            → release directly + activate
  if (body.candidate) {
    const snap = await snapshotCandidate(db, tenantId, {
      classifierId: cls.id,
      yaml: yamlSource,
      parsed: result.parsed as unknown as Record<string, unknown>,
      userId: principal.userId,
      bumpOverride: body.bump,
      commitMessage: body.commit_message,
    });
    return c.json(
      { id: snap.id, version: formatSemver(snap), released: false, bump: snap.bump, deduped: snap.deduped },
      201,
    );
  }

  const res = await releaseDirect(db, tenantId, {
    classifierId: cls.id,
    yaml: yamlSource,
    parsed: result.parsed as unknown as Record<string, unknown>,
    userId: principal.userId,
    bumpOverride: body.bump,
    commitMessage: body.commit_message,
    allowReactivate: body.allow_reactivate,
  });
  if ("error" in res) {
    if (res.error === "requires_reactivate") return c.json(reactivateRefusalBody(res), 409);
    return c.json(
      { error: "A release already occupies that version — commit a fresh candidate." },
      409,
    );
  }
  // Match the schema `release` route + the `koji classify release` CLI: 200 with
  // `released` = the version label (not a boolean), plus versionId. `action` and
  // `displaced` tell a no-op apart from a real release or a pointer move.
  return c.json({ released: res.label, versionId: res.id, action: res.action, displaced: res.displaced });
});

/**
 * POST /api/classifiers/:slug/promote — graduate a release candidate to a
 * release and make it live. Defaults to the latest candidate; `versionId`
 * targets a specific one. Gated by schema:deploy.
 */
classifiers.post("/:slug/promote", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req
    .json<{ versionId?: string }>()
    .catch(() => ({}) as { versionId?: string });

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  let versionId = body.versionId;
  if (!versionId) {
    const [latestRc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .select({ id: schema.classifierVersions.id })
        .from(schema.classifierVersions)
        .where(
          and(
            eq(schema.classifierVersions.classifierId, cls.id),
            isNotNull(schema.classifierVersions.prerelease),
          ),
        )
        .orderBy(desc(schema.classifierVersions.versionNumber))
        .limit(1),
    );
    if (!latestRc) return c.json({ error: "No release candidate to promote. Commit one first." }, 400);
    versionId = latestRc.id;
  }

  const res = await graduateCandidate(db, tenantId, cls.id, versionId);
  if ("error" in res) {
    if (res.error === "already_released") {
      return c.json(
        { error: "A release already occupies that version — commit a fresh candidate." },
        409,
      );
    }
    return c.json({ error: "Candidate not found, or it is already a release." }, 404);
  }
  return c.json({ released: res.label });
});

/**
 * POST /api/classifiers/:slug/release — release YAML directly (skip rc) and make
 * it live; defaults to the draft. Gated by schema:deploy.
 */
classifiers.post("/:slug/release", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const body = await c.req
    .json<{ yaml_source?: string; yaml?: string; allow_reactivate?: boolean }>()
    .catch(() => ({}) as { yaml_source?: string; yaml?: string; allow_reactivate?: boolean });

  const [cls] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.classifiers.id, draftYaml: schema.classifiers.draftYaml })
      .from(schema.classifiers)
      .where(eq(schema.classifiers.slug, slug))
      .limit(1),
  );
  if (!cls) return c.json({ error: "Classifier not found" }, 404);

  const yamlSource = body.yaml_source ?? body.yaml ?? cls.draftYaml;
  if (!yamlSource) {
    return c.json({ error: "No YAML to release — provide yaml_source or save a draft first." }, 400);
  }

  const compiled = compileClassifier(yamlSource);
  if (!compiled.ok) {
    return c.json({ error: "Classifier validation failed", details: compiled.error }, 400);
  }

  const res = await releaseDirect(db, tenantId, {
    classifierId: cls.id,
    yaml: yamlSource,
    parsed: compiled.parsed as unknown as Record<string, unknown>,
    userId: principal.userId,
    allowReactivate: body.allow_reactivate,
  });
  if ("error" in res) {
    if (res.error === "requires_reactivate") return c.json(reactivateRefusalBody(res), 409);
    return c.json(
      { error: "A release already occupies that version — commit a fresh candidate." },
      409,
    );
  }
  return c.json({ released: res.label, versionId: res.id, action: res.action, displaced: res.displaced });
});
