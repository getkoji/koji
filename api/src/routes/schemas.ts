import { Hono } from "hono";
import { eq, sql, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { compileSchema } from "../schemas/compiler";
import { createNotification } from "../notifications/emit";
import { extractFieldMetas } from "../schemas/field-meta";
import { extractFields } from "../extract";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { compareValues, type ValueDiff } from "../extract/value-compare";
import { and, isNull, isNotNull } from "drizzle-orm";
import { snapshotCandidate, graduateCandidate, releaseDirect } from "../schemas/versioning";
import { formatSemver, type Bump } from "../schemas/semver";
import { resolveMimeType } from "../ingestion/mime";
import { resolveParse, parseDocument } from "../ingestion/seam";

const DEFAULT_TEMPLATE = `name: my_schema
description: ""

fields:
  example_field:
    type: string
    required: true
    extraction_guidance: "Describe what to extract"
`;

export const schemas = new Hono<Env>();

schemas.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemas.id,
      slug: schema.schemas.slug,
      displayName: schema.schemas.displayName,
      description: schema.schemas.description,
      currentVersionId: schema.schemas.currentVersionId,
      createdAt: schema.schemas.createdAt,
    }).from(schema.schemas).where(sql`deleted_at IS NULL`)
  );

  const enriched = [];
  for (const row of rows) {
    let latestVersion: number | null = null;
    const [sv] = await withRLS(db, tenantId, (tx) =>
      tx.select({ versionNumber: schema.schemaVersions.versionNumber })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.schemaId, row.id))
        .orderBy(desc(schema.schemaVersions.versionNumber))
        .limit(1)
    );
    if (sv) latestVersion = sv.versionNumber;

    const [cc] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` })
        .from(schema.corpusEntries)
        .where(and(eq(schema.corpusEntries.schemaId, row.id), isNull(schema.corpusEntries.deletedAt)))
    );
    const corpusCount = cc?.count ?? 0;

    enriched.push({ ...row, latestVersion, corpusCount });
  }

  return c.json({ data: enriched });
});

schemas.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  let latestVersion: { versionNumber: number; yamlSource: string; commitMessage: string | null; createdAt: Date } | null = null;
  const [sv] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      versionNumber: schema.schemaVersions.versionNumber,
      yamlSource: schema.schemaVersions.yamlSource,
      commitMessage: schema.schemaVersions.commitMessage,
      createdAt: schema.schemaVersions.createdAt,
    }).from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );
  if (sv) latestVersion = sv;

  return c.json({ ...s, latestVersion });
});

/**
 * GET /api/schemas/:slug/fields — structured field metadata for a schema.
 *
 * Returns the latest committed version's YAML normalized into a stable JSON
 * shape (`{ fields: FieldMeta[] }`). Lets browser clients drop in-browser
 * YAML parsing for things like the review-page override dropdown.
 *
 * Returns 404 if the schema slug doesn't exist for this tenant, an empty
 * `fields: []` if the schema exists but has no committed YAML yet.
 */
schemas.get("/:slug/fields", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id, draftYaml: schema.schemas.draftYaml })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const [sv] = await withRLS(db, tenantId, (tx) =>
    tx.select({ yamlSource: schema.schemaVersions.yamlSource })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );

  // Prefer committed YAML; fall back to draft (covers freshly created schemas
  // that haven't committed v1 yet — same shape, same parser).
  const yamlSource = sv?.yamlSource ?? s.draftYaml ?? "";
  const fields = extractFieldMetas(yamlSource);
  return c.json({ fields });
});

schemas.post(
  "/",
  requires("schema:write"),
  requireQuantityGate("max_schemas", async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const [row] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(schema.schemas).where(sql`deleted_at IS NULL`),
    );
    return row?.count ?? 0;
  }),
  async (c) => {
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

  const yamlSource = body.initial_yaml ?? DEFAULT_TEMPLATE.replace("my_schema", body.slug);
  const result = compileSchema(yamlSource);
  if (!result.ok) {
    return c.json({ error: "Invalid initial YAML", details: result.errors }, 422);
  }

  const yamlHash = createHash("sha256").update(yamlSource).digest("hex");

  const [newSchema] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.schemas).values({
      tenantId,
      slug: body.slug,
      displayName: body.display_name,
      description: body.description ?? null,
      draftYaml: yamlSource,
      createdBy: principal.userId,
    }).returning()
  );

  const [v1] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.schemaVersions).values({
      tenantId,
      schemaId: newSchema!.id,
      versionNumber: 1,
      yamlSource,
      yamlHash,
      parsedJson: result.parsed,
      commitMessage: "Initial version",
      committedBy: principal.userId,
    }).returning()
  );

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.schemas)
      .set({ currentVersionId: v1!.id })
      .where(eq(schema.schemas.id, newSchema!.id))
  );

  return c.json({ ...newSchema, latestVersion: 1 }, 201);
});

schemas.patch("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req.json<{ display_name?: string; description?: string; draft_yaml?: string }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.draft_yaml !== undefined) { updates.draftYaml = body.draft_yaml; updates.draftUpdatedAt = new Date(); }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.schemas).set(updates).where(eq(schema.schemas.slug, slug)).returning()
  );
  if (rows.length === 0) return c.json({ error: "Schema not found" }, 404);
  return c.json(rows[0]);
});

schemas.delete("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.schemas).set({ deletedAt: new Date() }).where(eq(schema.schemas.slug, slug))
  );
  return c.body(null, 204);
});

// ── Versions ──

schemas.get("/:slug/versions", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id, currentVersionId: schema.schemas.currentVersionId })
      .from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemaVersions.id,
      versionNumber: schema.schemaVersions.versionNumber,
      major: schema.schemaVersions.major,
      minor: schema.schemaVersions.minor,
      patch: schema.schemaVersions.patch,
      prerelease: schema.schemaVersions.prerelease,
      commitMessage: schema.schemaVersions.commitMessage,
      committedByName: schema.users.name,
      createdAt: schema.schemaVersions.createdAt,
    }).from(schema.schemaVersions)
      .innerJoin(schema.users, eq(schema.users.id, schema.schemaVersions.committedBy))
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
  );

  // Enrich each version with its semver label, released/live flags, and latest
  // validate accuracy — drives both the Build version list and `koji schema versions`.
  const data = [];
  for (const v of rows) {
    const [run] = await withRLS(db, tenantId, (tx) =>
      tx.select({ accuracy: schema.schemaRuns.accuracy, regressionsCount: schema.schemaRuns.regressionsCount })
        .from(schema.schemaRuns)
        .where(and(eq(schema.schemaRuns.schemaVersionId, v.id), eq(schema.schemaRuns.status, "completed")))
        .orderBy(desc(schema.schemaRuns.createdAt))
        .limit(1)
    );
    data.push({
      ...v,
      version: formatSemver(v),
      released: v.prerelease === null,
      active: v.id === s.currentVersionId,
      accuracy: run?.accuracy ?? null,
      regressions: run?.regressionsCount ?? null,
    });
  }
  return c.json({ data });
});

schemas.get("/:slug/versions/:v", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const versionNum = parseInt(c.req.param("v")!, 10);

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const [version] = await withRLS(db, tenantId, (tx) =>
    tx.select().from(schema.schemaVersions)
      .where(sql`${schema.schemaVersions.schemaId} = ${s.id} AND ${schema.schemaVersions.versionNumber} = ${versionNum}`)
      .limit(1)
  );
  if (!version) return c.json({ error: "Version not found" }, 404);
  return c.json(version);
});

schemas.post("/:slug/versions", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const body = await c.req.json<{ yaml: string; commit_message?: string; candidate?: boolean; bump?: Bump }>();

  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);

  const result = compileSchema(body.yaml);
  if (!result.ok) {
    return c.json({ error: "Schema validation failed", details: result.errors }, 422);
  }

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  // Build mode's two actions, semver-assigned via the shared lifecycle helpers
  // (so versions never collide on the released-semver index):
  //   candidate=true  → snapshot a non-active candidate (Save as candidate)
  //   else            → release directly + activate (Release / `koji push`)
  if (body.candidate) {
    const snap = await snapshotCandidate(db, tenantId, {
      schemaId: s.id,
      yaml: body.yaml,
      parsed: result.parsed,
      userId: principal.userId,
      bumpOverride: body.bump,
      commitMessage: body.commit_message,
    });
    return c.json({ id: snap.id, version: formatSemver(snap), released: false, bump: snap.bump, deduped: snap.deduped }, 201);
  }

  const res = await releaseDirect(db, tenantId, {
    schemaId: s.id,
    yaml: body.yaml,
    parsed: result.parsed,
    userId: principal.userId,
    bumpOverride: body.bump,
    commitMessage: body.commit_message,
  });
  if ("error" in res) {
    return c.json({ error: "A release already occupies that version — re-validate for a fresh candidate." }, 409);
  }
  return c.json({ id: res.id, version: res.label, released: true }, 201);
});

/**
 * POST /api/schemas/:slug/promote — graduate a release candidate to a release
 * and make it live. Manual only; gated by schema:deploy. Defaults to the latest
 * candidate; `versionId` targets a specific one. `requireNoRegressions` refuses
 * to promote a candidate whose latest run regressed.
 */
schemas.post("/:slug/promote", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req
    .json<{ versionId?: string; requireNoRegressions?: boolean }>()
    .catch(() => ({}) as { versionId?: string; requireNoRegressions?: boolean });

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  let versionId = body.versionId;
  if (!versionId) {
    const [latestRc] = await withRLS(db, tenantId, (tx) =>
      tx.select({ id: schema.schemaVersions.id })
        .from(schema.schemaVersions)
        .where(and(eq(schema.schemaVersions.schemaId, s.id), isNotNull(schema.schemaVersions.prerelease)))
        .orderBy(desc(schema.schemaVersions.versionNumber))
        .limit(1)
    );
    if (!latestRc) return c.json({ error: "No release candidate to promote. Run validate first." }, 400);
    versionId = latestRc.id;
  }

  if (body.requireNoRegressions) {
    const [run] = await withRLS(db, tenantId, (tx) =>
      tx.select({ regressionsCount: schema.schemaRuns.regressionsCount })
        .from(schema.schemaRuns)
        .where(and(eq(schema.schemaRuns.schemaVersionId, versionId!), eq(schema.schemaRuns.status, "completed")))
        .orderBy(desc(schema.schemaRuns.createdAt))
        .limit(1)
    );
    if (run && run.regressionsCount > 0) {
      return c.json({ error: `Refusing to promote: the latest run had ${run.regressionsCount} regression(s).` }, 409);
    }
  }

  const res = await graduateCandidate(db, tenantId, s.id, versionId);
  if ("error" in res) {
    if (res.error === "already_released") {
      return c.json({ error: "A release already occupies that version — re-validate for a fresh candidate." }, 409);
    }
    return c.json({ error: "Candidate not found, or it is already a release." }, 404);
  }
  return c.json({ released: res.label });
});

/**
 * POST /api/schemas/:slug/release — release YAML directly (skip rc) and make it
 * live; defaults to the draft. The early-stage / empty-corpus path. Manual only;
 * gated by schema:deploy.
 */
schemas.post("/:slug/release", requires("schema:deploy"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const body = await c.req.json<{ yaml?: string }>().catch(() => ({}) as { yaml?: string });

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id, draftYaml: schema.schemas.draftYaml })
      .from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const yaml = body.yaml ?? s.draftYaml;
  if (!yaml) return c.json({ error: "No YAML to release — provide yaml or save a draft first." }, 400);

  const compiled = compileSchema(yaml);
  if (!compiled.ok) return c.json({ error: "Schema validation failed", details: compiled.errors }, 422);

  const res = await releaseDirect(db, tenantId, {
    schemaId: s.id,
    yaml,
    parsed: compiled.parsed,
    userId: principal.userId,
  });
  if ("error" in res) {
    return c.json({ error: "A release already occupies that version — re-validate for a fresh candidate." }, 409);
  }
  return c.json({ released: res.label, versionId: res.id });
});

// ── Corpus (documents for testing/validation) ──

/**
 * GET /api/schemas/:slug/corpus — list corpus entries for this schema.
 */
schemas.get("/:slug/corpus", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.corpusEntries.id,
      filename: schema.corpusEntries.filename,
      fileSize: schema.corpusEntries.fileSize,
      mimeType: schema.corpusEntries.mimeType,
      source: schema.corpusEntries.source,
      tags: schema.corpusEntries.tags,
      groundTruthJson: schema.corpusEntries.groundTruthJson,
      createdAt: schema.corpusEntries.createdAt,
    }).from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, s.id), isNull(schema.corpusEntries.deletedAt)))
      .orderBy(desc(schema.corpusEntries.createdAt))
  );

  const data = rows.map((r) => ({
    ...r,
    hasGroundTruth: r.groundTruthJson != null && typeof r.groundTruthJson === "object" && Object.keys(r.groundTruthJson as object).length > 0,
    groundTruthJson: undefined, // don't send the full payload in the list
  }));

  return c.json({ data });
});

/**
 * POST /api/schemas/:slug/corpus — upload a document to the corpus.
 * Creates a corpus entry with source='upload' and empty ground truth.
 * File is stored via the storage provider (S3/MinIO).
 */
schemas.post("/:slug/corpus", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const body = await c.req.parseBody();
  const file = body.file;

  if (!(file instanceof File)) {
    return c.json({ error: "file is required (multipart form with 'file' field)" }, 400);
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const { createHash } = await import("node:crypto");
  const contentHash = createHash("sha256").update(fileBuffer).digest("hex");

  // Normalize the claimed Content-Type before it touches storage or the DB.
  // Browsers/SDKs sometimes send a bare extension ("pdf") or nothing at all;
  // persisting that verbatim is what poisoned downstream parses (Doc AI 400 →
  // 502). Resolve claimed → filename → magic bytes so the corpus row always
  // carries a real MIME.
  const mimeType = resolveMimeType(file.type, file.name, fileBuffer);

  // Store to S3
  const storageKey = `corpus/${tenantId}/${s.id}/${Date.now()}-${file.name}`;
  await storage.put(storageKey, fileBuffer, {
    contentType: mimeType,
  });

  // Check if this file already exists in the corpus for this schema
  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx.select()
      .from(schema.corpusEntries)
      .where(and(
        eq(schema.corpusEntries.schemaId, s.id),
        eq(schema.corpusEntries.contentHash, contentHash),
        isNull(schema.corpusEntries.deletedAt),
      ))
      .limit(1)
  );

  if (existing) {
    // Document already in corpus — return the existing entry.
    // A previously soft-deleted entry with the same hash is ignored here,
    // so re-uploading a deleted document creates a fresh entry.
    return c.json(existing, 200);
  }

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.corpusEntries).values({
      tenantId,
      schemaId: s.id,
      filename: file.name,
      storageKey,
      fileSize: file.size,
      mimeType,
      contentHash,
      source: "upload",
      groundTruthJson: {}, // empty until promoted
      addedBy: principal.userId,
    }).returning()
  );

  return c.json(row, 201);
});

/**
 * GET /api/schemas/:slug/corpus/:entryId/url — get a signed URL for the file.
 * The browser fetches directly from S3/MinIO using this URL.
 */
schemas.get("/:slug/corpus/:entryId/url", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const entryId = c.req.param("entryId")!;

  const [entry] = await withRLS(db, tenantId, (tx) =>
    tx.select({ storageKey: schema.corpusEntries.storageKey })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.id, entryId), isNull(schema.corpusEntries.deletedAt)))
      .limit(1)
  );

  if (!entry) return c.json({ error: "Corpus entry not found" }, 404);

  const url = await storage.getSignedUrl(entry.storageKey, 3600);
  return c.json({ url });
});

/**
 * PATCH /api/schemas/:slug/corpus/:entryId — update corpus entry (tags, etc).
 */
schemas.patch("/:slug/corpus/:entryId", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const entryId = c.req.param("entryId")!;

  const body = await c.req.json<{ tags?: string[] }>();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.tags !== undefined) updates.tags = body.tags;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.corpusEntries).set(updates)
      .where(and(eq(schema.corpusEntries.id, entryId), isNull(schema.corpusEntries.deletedAt)))
      .returning()
  );

  if (rows.length === 0) return c.json({ error: "Entry not found" }, 404);
  return c.json(rows[0]);
});

/**
 * DELETE /api/schemas/:slug/corpus/:entryId — soft-delete a corpus entry.
 * Sets deleted_at; the row and its stored file are retained for recovery but
 * are filtered out of every read path (lists, counts, validate, performance,
 * extraction, dedup). Re-uploading the same document creates a fresh entry.
 */
schemas.delete("/:slug/corpus/:entryId", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const entryId = c.req.param("entryId")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.corpusEntries)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.corpusEntries.id, entryId),
        eq(schema.corpusEntries.schemaId, s.id),
        isNull(schema.corpusEntries.deletedAt),
      ))
      .returning({ id: schema.corpusEntries.id })
  );

  if (rows.length === 0) return c.json({ error: "Corpus entry not found" }, 404);
  return c.body(null, 204);
});

/**
 * GET /api/schemas/:slug/performance — performance data for the chart.
 */
schemas.get("/:slug/performance", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  // Get all runs for this schema ordered by version
  const runs = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemaRuns.id,
      schemaVersionId: schema.schemaRuns.schemaVersionId,
      accuracy: schema.schemaRuns.accuracy,
      docsTotal: schema.schemaRuns.docsTotal,
      docsPassed: schema.schemaRuns.docsPassed,
      regressionsCount: schema.schemaRuns.regressionsCount,
      costUsd: schema.schemaRuns.costUsd,
      durationMs: schema.schemaRuns.durationMs,
      completedAt: schema.schemaRuns.completedAt,
      createdAt: schema.schemaRuns.createdAt,
    }).from(schema.schemaRuns)
      .where(eq(schema.schemaRuns.schemaId, s.id))
      .orderBy(schema.schemaRuns.createdAt)
  );

  // Enrich each run with its version's semver label + released/candidate flag.
  const enrichedRuns = [];
  for (const run of runs) {
    let versionNumber: number | null = null;
    let version: string | null = null;
    let released: boolean | null = null;
    if (run.schemaVersionId) {
      const [sv] = await withRLS(db, tenantId, (tx) =>
        tx.select({
          versionNumber: schema.schemaVersions.versionNumber,
          major: schema.schemaVersions.major,
          minor: schema.schemaVersions.minor,
          patch: schema.schemaVersions.patch,
          prerelease: schema.schemaVersions.prerelease,
        })
          .from(schema.schemaVersions)
          .where(eq(schema.schemaVersions.id, run.schemaVersionId))
          .limit(1)
      );
      versionNumber = sv?.versionNumber ?? null;
      version = sv ? formatSemver(sv) : null;
      released = sv ? sv.prerelease === null : null;
    }
    enrichedRuns.push({ ...run, versionNumber, version, released });
  }

  // Compute per-field accuracy per run from extraction_runs + ground truth
  const perRunFieldAccuracy: Array<{ runId: string; fields: Record<string, number> }> = [];

  // Get all corpus entries with ground truth for this schema
  const corpusRows = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.corpusEntries.id, groundTruthJson: schema.corpusEntries.groundTruthJson })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, s.id), isNull(schema.corpusEntries.deletedAt)))
  );
  const gtMap = new Map<string, Record<string, unknown>>();
  for (const ce of corpusRows) {
    if (ce.groundTruthJson && typeof ce.groundTruthJson === "object" && Object.keys(ce.groundTruthJson as object).length > 0) {
      gtMap.set(ce.id, ce.groundTruthJson as Record<string, unknown>);
    }
  }

  for (const run of enrichedRuns) {
    // Get extraction_runs linked to this schema_run
    const exRuns = await withRLS(db, tenantId, (tx) =>
      tx.select({
        corpusEntryId: schema.extractionRuns.corpusEntryId,
        extractedJson: schema.extractionRuns.extractedJson,
      })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.schemaRunId, run.id))
    );

    if (exRuns.length === 0) continue;

    const fieldScore: Record<string, number> = {};
    const fieldChecked: Record<string, number> = {};

    for (const exRun of exRuns) {
      const gt = gtMap.get(exRun.corpusEntryId);
      if (!gt) continue;
      const extracted = exRun.extractedJson as Record<string, unknown>;

      for (const [field, expected] of Object.entries(gt)) {
        if (expected === undefined || expected === null) continue;
        fieldChecked[field] = (fieldChecked[field] ?? 0) + 1;
        fieldScore[field] = (fieldScore[field] ?? 0) + compareValues(expected, extracted[field]).score;
      }
    }

    const fields: Record<string, number> = {};
    for (const f of Object.keys(fieldChecked)) {
      fields[f] = fieldChecked[f]! > 0 ? ((fieldScore[f] ?? 0) / fieldChecked[f]!) * 100 : 100;
    }
    perRunFieldAccuracy.push({ runId: run.id, fields });
  }

  // Corpus count
  const [corpusCount] = await withRLS(db, tenantId, (tx) =>
    tx.select({ count: sql<number>`count(*)::int` })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, s.id), isNull(schema.corpusEntries.deletedAt)))
  );

  return c.json({
    runs: enrichedRuns,
    perRunFieldAccuracy,
    corpusCount: corpusCount?.count ?? 0,
  });
});

/**
 * POST /api/schemas/:slug/corpus/:entryId/ground-truth — save ground truth.
 * Append-only: creates a new GT row, previous versions preserved.
 */
schemas.post("/:slug/corpus/:entryId/ground-truth", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const entryId = c.req.param("entryId")!;
  const principal = getPrincipal(c);

  const body = await c.req.json<{ values: Record<string, unknown> }>();
  if (!body.values) return c.json({ error: "values is required" }, 400);

  // Get the latest GT to set supersedes_id
  const [latest] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.corpusEntryGroundTruth.id })
      .from(schema.corpusEntryGroundTruth)
      .where(eq(schema.corpusEntryGroundTruth.corpusEntryId, entryId))
      .orderBy(desc(schema.corpusEntryGroundTruth.createdAt))
      .limit(1)
  );

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.corpusEntryGroundTruth).values({
      tenantId,
      corpusEntryId: entryId,
      payloadJson: body.values,
      authoredBy: principal.userId,
      reviewStatus: "draft",
      supersedesId: latest?.id ?? null,
    }).returning()
  );

  // Also update the corpus entry's ground_truth_json for quick access
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.corpusEntries)
      .set({ groundTruthJson: body.values, updatedAt: new Date() })
      .where(eq(schema.corpusEntries.id, entryId))
  );

  return c.json(row, 201);
});

/**
 * GET /api/schemas/:slug/corpus/:entryId/ground-truth — get GT history.
 */
schemas.get("/:slug/corpus/:entryId/ground-truth", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const entryId = c.req.param("entryId")!;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.corpusEntryGroundTruth.id,
      payloadJson: schema.corpusEntryGroundTruth.payloadJson,
      reviewStatus: schema.corpusEntryGroundTruth.reviewStatus,
      authoredByName: schema.users.name,
      createdAt: schema.corpusEntryGroundTruth.createdAt,
    }).from(schema.corpusEntryGroundTruth)
      .innerJoin(schema.users, eq(schema.users.id, schema.corpusEntryGroundTruth.authoredBy))
      .where(eq(schema.corpusEntryGroundTruth.corpusEntryId, entryId))
      .orderBy(desc(schema.corpusEntryGroundTruth.createdAt))
  );

  return c.json({ data: rows });
});

/**
 * POST /api/schemas/:slug/corpus/:entryId/ground-truth/:gtId/approve
 *
 * Approve a draft ground-truth row — the human exit ramp for agent-authored
 * (provisional) labels promoted from the review queue. Marks the row
 * `approved` and writes the denormalized `corpusEntries.groundTruthJson` so
 * `validate` begins scoring against it. Until this runs, provisional drafts are
 * deliberately excluded from validation.
 */
schemas.post(
  "/:slug/corpus/:entryId/ground-truth/:gtId/approve",
  requires("corpus:write"),
  async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const entryId = c.req.param("entryId")!;
    const gtId = c.req.param("gtId")!;
    const principal = getPrincipal(c);

    const [gt] = await withRLS(db, tenantId, (tx) =>
      tx
        .select({
          id: schema.corpusEntryGroundTruth.id,
          payloadJson: schema.corpusEntryGroundTruth.payloadJson,
          reviewStatus: schema.corpusEntryGroundTruth.reviewStatus,
        })
        .from(schema.corpusEntryGroundTruth)
        .where(
          and(
            eq(schema.corpusEntryGroundTruth.id, gtId),
            eq(schema.corpusEntryGroundTruth.corpusEntryId, entryId),
          ),
        )
        .limit(1),
    );
    if (!gt) return c.json({ error: "Ground-truth version not found" }, 404);

    const [updated] = await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.corpusEntryGroundTruth)
        .set({
          reviewStatus: "approved",
          reviewedBy: principal.userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.corpusEntryGroundTruth.id, gtId))
        .returning(),
    );

    // Promote into the denormalized copy that `validate` scores.
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.corpusEntries)
        .set({ groundTruthJson: gt.payloadJson, updatedAt: new Date() })
        .where(eq(schema.corpusEntries.id, entryId)),
    );

    return c.json(updated);
  },
);

/**
 * POST /api/schemas/:slug/validate — run validation.
 *
 * Re-runs extraction on every corpus entry with ground truth using the
 * current schema YAML, then compares results against ground truth.
 */
schemas.post("/:slug/validate", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const startTime = Date.now();

  const body = await c.req
    .json<{ model?: string; yaml?: string; bump?: Bump; commitMessage?: string }>()
    .catch((): { model?: string; yaml?: string; bump?: Bump; commitMessage?: string } => ({}));

  const principal = getPrincipal(c);

  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemas.id,
      draftYaml: schema.schemas.draftYaml,
    })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  // Ground truth gates the whole run — check before snapshotting a candidate so
  // a contentless validate (empty corpus) doesn't litter the version history.
  const entries = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.corpusEntries.id,
      filename: schema.corpusEntries.filename,
      storageKey: schema.corpusEntries.storageKey,
      mimeType: schema.corpusEntries.mimeType,
      contentHash: schema.corpusEntries.contentHash,
      groundTruthJson: schema.corpusEntries.groundTruthJson,
    })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, schemaRow.id), isNull(schema.corpusEntries.deletedAt)))
  );

  const entriesWithGT = entries.filter((e: any) =>
    e.groundTruthJson && typeof e.groundTruthJson === "object" && Object.keys(e.groundTruthJson as object).length > 0
  );

  if (entriesWithGT.length === 0) {
    return c.json({ error: "No corpus entries have ground truth. Save ground truth from Build mode first." }, 400);
  }

  // Resolve the schema content + the version this run is tied to.
  //
  // New path: a candidate YAML is sent in the body — snapshot it as an rc
  // (dedup by content hash) WITHOUT activating it, and tie the run to that
  // candidate. This is the safe inner loop: iterating never touches the live
  // schema. Back-compat path: no YAML — validate the latest stored version
  // (or draft), as before.
  let schemaYaml: string | null = null;
  let versionId: string | undefined;
  let versionLabel: string | null = null;
  let versionNumber = 0;
  let bump: Bump | null = null;
  let deduped = false;

  if (body.yaml) {
    const compiled = compileSchema(body.yaml);
    if (!compiled.ok) {
      return c.json({ error: "Schema validation failed", details: compiled.errors }, 422);
    }
    const snap = await snapshotCandidate(db, tenantId, {
      schemaId: schemaRow.id,
      yaml: body.yaml,
      parsed: compiled.parsed,
      userId: principal.userId,
      bumpOverride: body.bump,
      commitMessage: body.commitMessage,
    });
    schemaYaml = body.yaml;
    versionId = snap.id;
    versionNumber = snap.versionNumber;
    versionLabel = formatSemver(snap);
    bump = snap.bump;
    deduped = snap.deduped;
  } else {
    const [latestVersion] = await withRLS(db, tenantId, (tx) =>
      tx.select({
        id: schema.schemaVersions.id,
        versionNumber: schema.schemaVersions.versionNumber,
        major: schema.schemaVersions.major,
        minor: schema.schemaVersions.minor,
        patch: schema.schemaVersions.patch,
        prerelease: schema.schemaVersions.prerelease,
        yamlSource: schema.schemaVersions.yamlSource,
      })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.schemaId, schemaRow.id))
        .orderBy(desc(schema.schemaVersions.versionNumber))
        .limit(1)
    );
    schemaYaml = latestVersion?.yamlSource ?? schemaRow.draftYaml;
    versionId = latestVersion?.id;
    versionNumber = latestVersion?.versionNumber ?? 0;
    versionLabel = latestVersion ? formatSemver(latestVersion) : null;
  }

  if (!schemaYaml) return c.json({ error: "No schema YAML found" }, 400);
  if (!versionId) return c.json({ error: "No schema version found. Save or validate a schema first." }, 400);

  // Create the schema_run record (ties to the candidate or the latest version).
  const [schemaRun] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.schemaRuns).values({
      tenantId,
      schemaId: schemaRow.id,
      schemaVersionId: versionId,
      runType: "validate",
      triggeredBy: principal.userId,
      status: "running",
      startedAt: new Date(),
      docsTotal: entriesWithGT.length,
    }).returning({ id: schema.schemaRuns.id })
  );
  if (!schemaRun) return c.json({ error: "Failed to create schema run" }, 500);

  // Resolve model endpoint for extraction
  const storage = c.get("storage");
  const { provider, model: extractModel } = await resolveTenantProvider(db, tenantId, {
    preferModel: body.model ?? null,
  });

  // Parse schema YAML for extraction
  let schemaDef: Record<string, unknown>;
  try {
    const { parse: parseYaml } = await import("yaml");
    schemaDef = parseYaml(schemaYaml);
  } catch {
    return c.json({ error: "Invalid schema YAML" }, 422);
  }

  const results: Array<{
    entryId: string;
    filename: string;
    groundTruth: Record<string, unknown>;
    extracted: Record<string, unknown>;
    confidenceScores: Record<string, number>;
    routingPlan?: RoutingPlan;
  }> = [];

  // Get previous extraction runs for regression detection
  const prevExtractedMap = new Map<string, Record<string, unknown>>();
  for (const entry of entriesWithGT) {
    const [prevRun] = await withRLS(db, tenantId, (tx) =>
      tx.select({ extractedJson: schema.extractionRuns.extractedJson })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.corpusEntryId, entry.id))
        .orderBy(desc(schema.extractionRuns.createdAt))
        .limit(1)
    );
    if (prevRun) {
      prevExtractedMap.set(entry.id, prevRun.extractedJson as Record<string, unknown>);
    }
  }

  // Resolve the tenant's BYO parse provider ONCE before the loop. Validate must
  // parse with the SAME provider production (`run`/ingestion) uses, not the
  // global default (`c.get("parseProvider")`) — otherwise scanned/degraded docs
  // that only the tenant's Doc AI handles parse empty here and get silently
  // dropped, surfacing downstream as expected=None/got=None (oss-308). Falls
  // back to the default provider when no endpoint is configured. `resolveParse`
  // is the one shared resolver every surface uses (oss-310).
  const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
    db,
    tenantId,
    {
      parseProviderId: null,
      defaultProvider: c.get("parseProvider"),
      parseConfig: c.get("parseConfig"),
    },
  );

  // Per-doc parse failures — surfaced in the response instead of being silently
  // dropped from `results` (which masqueraded as "no ground truth"). Each entry
  // lands in exactly one of `results` or `parseFailures` (oss-308).
  const parseFailures: Array<{ entryId: string; filename: string; error: string }> = [];

  const yamlHash = createHash("sha256").update(schemaYaml).digest("hex");

  // Run extractions directly (no HTTP loopback — works on Vercel)
  for (const entry of entriesWithGT) {
    try {
      // Get file from storage
      const fileResult = await storage.getBuffer(entry.storageKey);
      if (!fileResult) {
        const error = "file not found in storage";
        console.warn(`[validate] ${entry.filename}: ${error}`);
        parseFailures.push({ entryId: entry.id, filename: entry.filename, error });
        continue;
      }

      // Parse via the shared seam (oss-310): `parseDocument` runs the resolved
      // tenant provider through the same parse cache `run`/ingestion uses (cache
      // parity — a doc already parsed is reused, no redundant re-parse), and
      // shapes the flat parse-layer text_map into the nested provenance TextMap
      // with the one shared converter so this path can't drift from build's
      // (the oss-309 footgun). MIME is normalized with the buffer first so a
      // sloppy stored value never hard-fails the parse (#401).
      const mimeType = resolveMimeType(entry.mimeType, entry.filename, fileResult.data);
      const parsed = await parseDocument({
        db,
        storage,
        tenantId,
        document: {
          id: entry.id,
          storageKey: entry.storageKey,
          filename: entry.filename,
          mimeType,
          contentHash: entry.contentHash,
        },
        provider: parseProvider,
        fingerprint: parseFingerprint,
      });
      const markdown = parsed.markdown;

      if (!markdown) {
        const error = "parse returned empty markdown";
        console.warn(`[validate] ${entry.filename}: ${error}`);
        parseFailures.push({ entryId: entry.id, filename: entry.filename, error });
        continue;
      }

      // Extract — forward the nested text_map (bbox provenance) AND chunks, so
      // validate produces the same provenance as build/ingestion (it previously
      // dropped `chunks`). `parseDocument` already nested the text_map.
      const extractResult = await extractFields(
        markdown,
        schemaDef,
        provider,
        extractModel,
        parsed.textMap,
        parsed.chunks,
      );

      results.push({
        entryId: entry.id,
        filename: entry.filename,
        groundTruth: entry.groundTruthJson as Record<string, unknown>,
        extracted: (extractResult.extracted as Record<string, unknown>) ?? {},
        confidenceScores: (extractResult.confidence_scores as Record<string, number>) ?? {},
        // Per-field chunk routing — powers the `routingDiagnosis` on failing
        // fields (was the answer even in the chunks the model saw?). Transient:
        // consumed by computeValidateResult, never persisted or returned raw.
        routingPlan: (extractResult.routing_plan as RoutingPlan) ?? undefined,
      });

      // Persist the per-doc extraction, linked to this schema_run. The
      // performance heatmap joins extraction_runs on schema_run_id, and the
      // next validate's regression baseline reads the latest run per corpus
      // entry — without this row both saw only build-page extractions.
      // Same row shape as the build path (extract.ts) so shared consumers
      // (run detail, provenance) work on validate rows too. A failed insert
      // must not fail the validate run itself.
      try {
        await withRLS(db, tenantId, (tx) =>
          tx.insert(schema.extractionRuns).values({
            tenantId,
            schemaId: schemaRow.id,
            schemaVersionId: versionId,
            schemaRunId: schemaRun.id,
            corpusEntryId: entry.id,
            model: String(extractResult.model ?? extractModel ?? "unknown"),
            schemaYamlHash: yamlHash,
            extractedJson: extractResult.extracted ?? {},
            confidenceJson: extractResult.confidence ?? null,
            confidenceScoresJson: extractResult.confidence_scores ?? null,
            provenanceJson: extractResult.provenance ?? null,
            markdownText: markdown,
            parseSeconds: null,
            extractMs: (extractResult.elapsed_ms as number) ?? null,
            ocrSkipped: parsed.ocr_skipped ? "true" : "false",
            cached: parsed.cached ? "true" : "false",
            triggeredBy: principal.userId,
          })
        );
      } catch (err) {
        console.warn(`[validate] Failed to persist extraction run for ${entry.filename}:`, err);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[validate] Failed to extract ${entry.filename}:`, error);
      parseFailures.push({ entryId: entry.id, filename: entry.filename, error });
    }
  }

  if (results.length === 0) {
    // Update schema_run as failed
    await withRLS(db, tenantId, (tx) =>
      tx.update(schema.schemaRuns).set({ status: "failed", completedAt: new Date(), errorMessage: "All extractions failed" })
        .where(eq(schema.schemaRuns.id, schemaRun.id))
    );
    // Surface the per-doc reasons so an all-failed run is debuggable instead of
    // an opaque 502 (oss-308).
    return c.json({ error: "All extractions failed", parseFailures }, 502);
  }

  const validateResult = computeValidateResult(
    results,
    prevExtractedMap,
    versionNumber,
    startTime,
    parseFailures,
    (schemaDef.fields as Record<string, Record<string, unknown>>) ?? {},
  );

  // Update schema_run with results
  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.schemaRuns).set({
      status: "completed",
      completedAt: new Date(),
      docsTotal: validateResult.docsTotal,
      docsPassed: validateResult.docsPassed,
      regressionsCount: validateResult.regressions.length,
      accuracy: String(validateResult.overallAccuracy / 100), // stored as 0.0-1.0
      durationMs: validateResult.durationMs,
    }).where(eq(schema.schemaRuns.id, schemaRun.id))
  );

  if (validateResult.regressions.length > 0) {
    createNotification(tenantId, {
      type: "validate.regression",
      title: `Validate regression detected`,
      body: `${validateResult.regressions.length} field regression(s) on ${validateResult.docsTotal} docs (${validateResult.overallAccuracy.toFixed(1)}% accuracy)`,
      data: {
        schemaRunId: schemaRun.id,
        regressionsCount: validateResult.regressions.length,
        docsTotal: validateResult.docsTotal,
        accuracy: validateResult.overallAccuracy,
      },
    });
  }

  // Surface the candidate the run scored — its semver label, the auto-derived
  // bump (vs the active release), and whether identical content was reused.
  // The candidate is NOT activated; promotion is a separate, gated step.
  return c.json({ ...validateResult, version: versionLabel, bump, deduped });
});

/** Per-field chunk-routing record produced by the intelligent pipeline. */
type RoutingPlan = Record<
  string,
  { source: string; chunks: Array<{ index: number; title: string }>; text: string }
>;

/** Diagnosis attached to a failing (field, doc) pair to explain *why* it failed. */
interface RoutingDiagnosis {
  /** How the chunks were selected: hint | signal_inferred | broadened | fallback | full_document. */
  source: string | null;
  /**
   * Whether the ground-truth answer's text appears in the chunks the model was
   * shown. `false` ⇒ a routing miss — the model never saw the answer, so no
   * prompt or model change can fix it; fix the schema `hints`. `true` ⇒ the
   * answer reached the model and it still got it wrong — a prompt/description
   * (or, last resort, model) problem. `null` ⇒ couldn't determine (no routing
   * data, or a non-scalar expected value the heuristic doesn't score).
   */
  answerInRoutedChunks: boolean | null;
  /** The chunks the field was routed to (index + heading), for display. */
  chunks: Array<{ index: number; title: string }>;
}

/**
 * Heuristic: does the ground-truth `expected` value appear in `text` (the
 * concatenated content of the chunks the field was routed to)? Numbers match on
 * their digit sequence (tolerating `$`, commas, decimals); strings match as a
 * normalized substring or ≥60% of their significant word tokens. Booleans and
 * complex values return `null` — the routing `source` still applies. Intended as
 * a diagnostic hint, not a hard gate.
 */
export function answerPresentInText(expected: unknown, text: string | undefined): boolean | null {
  if (!text) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  if (!hay) return null;

  if (typeof expected === "number") {
    const digits = String(expected).replace(/[^0-9]/g, "");
    if (!digits) return null;
    return hay.replace(/[^0-9]/g, "").includes(digits);
  }
  if (typeof expected === "string") {
    const needle = norm(expected);
    if (!needle) return null;
    if (hay.includes(needle)) return true;
    const tokens = needle.split(" ").filter((t) => t.length > 2);
    if (tokens.length === 0) return hay.includes(needle);
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return hits / tokens.length >= 0.6;
  }
  return null;
}

/** Compare extraction results against ground truth and compute accuracy/regressions. */
export function computeValidateResult(
  results: Array<{ entryId: string; filename: string; groundTruth: Record<string, unknown>; extracted: Record<string, unknown>; confidenceScores: Record<string, number>; routingPlan?: RoutingPlan }>,
  prevExtractedMap: Map<string, Record<string, unknown>>,
  schemaVersion: number,
  startTime: number,
  /**
   * Docs that failed to parse/extract and never made it into `results`. Threaded
   * through so they're visible in the response (`parseFailures`) and counted in
   * `docsTotal` — a dropped doc must not silently inflate accuracy (oss-308).
   * Defaults to `[]` for the GET (read-only) caller that has no failure list.
   */
  parseFailures: Array<{ entryId: string; filename: string; error: string }> = [],
  /**
   * Schema field specs, so array fields can be scored with their declared
   * `element_key` (identity matching) and `informational` sub-fields (excluded
   * from scoring), and so precision/recall can be reported per array field.
   * Optional — without it, arrays still get F1 scoring via greedy matching.
   */
  schemaFields?: Record<string, Record<string, unknown>>,
) {
  const allFields = new Set<string>();
  for (const r of results) {
    for (const k of Object.keys(r.groundTruth)) allFields.add(k);
  }

  const fieldResults: Array<{ name: string; accuracy: number; prevAccuracy: number | null; status: string; precision?: number; recall?: number; failingDocs: Array<{ id: string; filename: string; diff: ValueDiff; score: number; confidence: number; routingDiagnosis?: RoutingDiagnosis }> }> = [];
  let totalScore = 0;
  let totalChecked = 0;
  const failingDocsMap = new Map<string, { id: string; filename: string; failedFields: string[]; worstConfidence: number }>();

  for (const fieldName of allFields) {
    const fieldSpec = schemaFields?.[fieldName];
    let scoreSum = 0, checked = 0, prevScoreSum = 0, prevChecked = 0;
    // Precision/recall accumulate only over docs whose expected value is an
    // array, so array fields can report both alongside the F1 accuracy.
    let precSum = 0, recSum = 0, arrChecked = 0;
    const failing: Array<{ id: string; filename: string; diff: ValueDiff; score: number; confidence: number; routingDiagnosis?: RoutingDiagnosis }> = [];

    for (const r of results) {
      const expected = r.groundTruth[fieldName];
      if (expected === undefined || expected === null) continue;
      checked++;
      const cmp = compareValues(expected, r.extracted[fieldName], fieldSpec);
      scoreSum += cmp.score;
      if (cmp.diff.kind === "array") {
        precSum += cmp.diff.precision;
        recSum += cmp.diff.recall;
        arrChecked++;
      }

      if (!cmp.match) {
        const conf = r.confidenceScores[fieldName] ?? 0;
        // Explain the failure: did the answer even reach the model? A routing
        // miss (answerInRoutedChunks=false) is schema-fixable via hints and no
        // model change helps; a hit points at prompt/description instead.
        const route = r.routingPlan?.[fieldName];
        const routingDiagnosis: RoutingDiagnosis | undefined = route
          ? {
              source: route.source,
              answerInRoutedChunks: answerPresentInText(expected, route.text),
              chunks: route.chunks,
            }
          : undefined;
        failing.push({ id: r.entryId, filename: r.filename, diff: cmp.diff, score: cmp.score, confidence: conf, ...(routingDiagnosis ? { routingDiagnosis } : {}) });
        const existing = failingDocsMap.get(r.entryId);
        if (existing) { existing.failedFields.push(fieldName); existing.worstConfidence = Math.min(existing.worstConfidence, conf); }
        else { failingDocsMap.set(r.entryId, { id: r.entryId, filename: r.filename, failedFields: [fieldName], worstConfidence: conf }); }
      }

      const prevExtracted = prevExtractedMap.get(r.entryId);
      if (prevExtracted) {
        prevChecked++;
        prevScoreSum += compareValues(expected, prevExtracted[fieldName], fieldSpec).score;
      }
    }

    const accuracy = checked > 0 ? (scoreSum / checked) * 100 : 100;
    const prevAccuracy = prevChecked > 0 ? (prevScoreSum / prevChecked) * 100 : null;
    totalScore += scoreSum;
    totalChecked += checked;
    const status = failing.length > 0 ? (prevAccuracy !== null && prevAccuracy > accuracy ? "regressed" : "failing") : "pass";
    // Report precision/recall for array fields (mean over docs, as percentages)
    // so a low F1 can be read as "missed elements" (recall) vs "spurious/wrong
    // elements" (precision) — the diagnosis Superkey needs on coverages et al.
    const prAgg =
      arrChecked > 0
        ? { precision: (precSum / arrChecked) * 100, recall: (recSum / arrChecked) * 100 }
        : {};
    fieldResults.push({ name: fieldName, accuracy, prevAccuracy, status, ...prAgg, failingDocs: failing });
  }

  fieldResults.sort((a, b) => a.accuracy - b.accuracy);
  const overallAccuracy = totalChecked > 0 ? (totalScore / totalChecked) * 100 : 100;

  return {
    overallAccuracy,
    prevAccuracy: null,
    // Attempted docs = scored docs + docs that failed to parse/extract. Counting
    // failures keeps accuracy honest — a dropped doc can't silently shrink the
    // denominator (oss-308).
    docsTotal: results.length + parseFailures.length,
    docsPassed: results.length - failingDocsMap.size,
    fieldCount: fieldResults.length,
    durationMs: Date.now() - startTime,
    costUsd: 0,
    passed: overallAccuracy >= 95,
    schemaVersion,
    ranAt: new Date().toISOString(),
    regressions: fieldResults.filter((f) => f.status === "regressed"),
    fields: fieldResults,
    failingDocs: Array.from(failingDocsMap.values()),
    // Docs that never produced an extraction (parse/storage/extract failure).
    // Additive field — read-only callers omit it and get [].
    parseFailures,
  };
}

/**
 * GET /api/schemas/:slug/validate — read latest validation results.
 *
 * Compares existing extraction_runs against ground truth. Does NOT re-run extraction.
 * Fast — just DB reads.
 */
schemas.get("/:slug/validate", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const startTime = Date.now();

  const [schemaRow] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  const [latestVersion] = await withRLS(db, tenantId, (tx) =>
    tx.select({ versionNumber: schema.schemaVersions.versionNumber, yamlSource: schema.schemaVersions.yamlSource })
      .from(schema.schemaVersions).where(eq(schema.schemaVersions.schemaId, schemaRow.id))
      .orderBy(desc(schema.schemaVersions.versionNumber)).limit(1)
  );

  // Parse the schema's field specs so array fields score with their declared
  // `element_key`/`informational` (same as the POST path). Best-effort — a
  // parse failure just falls back to schema-less F1 scoring.
  let getSchemaFields: Record<string, Record<string, unknown>> | undefined;
  if (latestVersion?.yamlSource) {
    try {
      const { parse: parseYaml } = await import("yaml");
      const parsed = parseYaml(latestVersion.yamlSource) as Record<string, unknown>;
      getSchemaFields = (parsed?.fields as Record<string, Record<string, unknown>>) ?? undefined;
    } catch {
      getSchemaFields = undefined;
    }
  }

  const entries = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.corpusEntries.id, filename: schema.corpusEntries.filename, groundTruthJson: schema.corpusEntries.groundTruthJson })
      .from(schema.corpusEntries).where(and(eq(schema.corpusEntries.schemaId, schemaRow.id), isNull(schema.corpusEntries.deletedAt)))
  );

  const entriesWithGT = entries.filter((e: any) =>
    e.groundTruthJson && typeof e.groundTruthJson === "object" && Object.keys(e.groundTruthJson as object).length > 0
  );

  if (entriesWithGT.length === 0) return c.json(null);

  const results: Array<{ entryId: string; filename: string; groundTruth: Record<string, unknown>; extracted: Record<string, unknown>; confidenceScores: Record<string, number> }> = [];
  const prevExtractedMap = new Map<string, Record<string, unknown>>();

  for (const entry of entriesWithGT) {
    const runs = await withRLS(db, tenantId, (tx) =>
      tx.select({ extractedJson: schema.extractionRuns.extractedJson, confidenceScoresJson: schema.extractionRuns.confidenceScoresJson })
        .from(schema.extractionRuns).where(eq(schema.extractionRuns.corpusEntryId, entry.id))
        .orderBy(desc(schema.extractionRuns.createdAt)).limit(2)
    );
    if (runs.length > 0) {
      results.push({
        entryId: entry.id, filename: entry.filename,
        groundTruth: entry.groundTruthJson as Record<string, unknown>,
        extracted: runs[0]!.extractedJson as Record<string, unknown>,
        confidenceScores: (runs[0]!.confidenceScoresJson as Record<string, number>) ?? {},
      });
      if (runs.length > 1) prevExtractedMap.set(entry.id, runs[1]!.extractedJson as Record<string, unknown>);
    }
  }

  if (results.length === 0) return c.json(null);

  return c.json(computeValidateResult(results, prevExtractedMap, latestVersion?.versionNumber ?? 0, startTime, [], getSchemaFields));
});
