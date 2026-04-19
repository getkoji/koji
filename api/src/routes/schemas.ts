import { Hono } from "hono";
import { eq, sql, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { compileSchema } from "../schemas/compiler";

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
    enriched.push({ ...row, latestVersion });
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

schemas.post("/", requires("schema:write"), async (c) => {
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
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: schema.schemaVersions.id,
      versionNumber: schema.schemaVersions.versionNumber,
      commitMessage: schema.schemaVersions.commitMessage,
      committedByName: schema.users.name,
      createdAt: schema.schemaVersions.createdAt,
    }).from(schema.schemaVersions)
      .innerJoin(schema.users, eq(schema.users.id, schema.schemaVersions.committedBy))
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
  );

  return c.json({ data: rows });
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
  const body = await c.req.json<{ yaml: string; commit_message?: string }>();

  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);

  const result = compileSchema(body.yaml);
  if (!result.ok) {
    return c.json({ error: "Schema validation failed", details: result.errors }, 422);
  }

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const [latest] = await withRLS(db, tenantId, (tx) =>
    tx.select({ versionNumber: schema.schemaVersions.versionNumber })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );
  const nextVersion = (latest?.versionNumber ?? 0) + 1;
  const yamlHash = createHash("sha256").update(body.yaml).digest("hex");

  const [newVersion] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.schemaVersions).values({
      tenantId,
      schemaId: s.id,
      versionNumber: nextVersion,
      yamlSource: body.yaml,
      yamlHash,
      parsedJson: result.parsed,
      commitMessage: body.commit_message ?? null,
      committedBy: principal.userId,
    }).returning()
  );

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.schemas)
      .set({ currentVersionId: newVersion!.id, updatedAt: new Date() })
      .where(eq(schema.schemas.id, s.id))
  );

  return c.json(newVersion, 201);
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
      createdAt: schema.corpusEntries.createdAt,
    }).from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.schemaId, s.id))
      .orderBy(desc(schema.corpusEntries.createdAt))
  );

  return c.json({ data: rows });
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

  // Store to S3
  const storageKey = `corpus/${tenantId}/${s.id}/${Date.now()}-${file.name}`;
  await storage.put(storageKey, fileBuffer, {
    contentType: file.type || "application/octet-stream",
  });

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.corpusEntries).values({
      tenantId,
      schemaId: s.id,
      filename: file.name,
      storageKey,
      fileSize: file.size,
      mimeType: file.type || "application/octet-stream",
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
      .where(eq(schema.corpusEntries.id, entryId))
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
    tx.update(schema.corpusEntries).set(updates).where(eq(schema.corpusEntries.id, entryId)).returning()
  );

  if (rows.length === 0) return c.json({ error: "Entry not found" }, 404);
  return c.json(rows[0]);
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
