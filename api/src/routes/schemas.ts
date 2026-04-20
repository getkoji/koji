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

    const [cc] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` })
        .from(schema.corpusEntries)
        .where(eq(schema.corpusEntries.schemaId, row.id))
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

  // Enrich with version numbers
  const enrichedRuns = [];
  for (const run of runs) {
    let versionNumber: number | null = null;
    if (run.schemaVersionId) {
      const [sv] = await withRLS(db, tenantId, (tx) =>
        tx.select({ versionNumber: schema.schemaVersions.versionNumber })
          .from(schema.schemaVersions)
          .where(eq(schema.schemaVersions.id, run.schemaVersionId))
          .limit(1)
      );
      versionNumber = sv?.versionNumber ?? null;
    }
    enrichedRuns.push({ ...run, versionNumber });
  }

  // Compute per-field accuracy per run from extraction_runs + ground truth
  const perRunFieldAccuracy: Array<{ runId: string; fields: Record<string, number> }> = [];

  // Get all corpus entries with ground truth for this schema
  const corpusRows = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ id: schema.corpusEntries.id, groundTruthJson: schema.corpusEntries.groundTruthJson })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.schemaId, s.id))
  );
  const gtMap = new Map<string, Record<string, unknown>>();
  for (const ce of corpusRows) {
    if (ce.groundTruthJson && typeof ce.groundTruthJson === "object" && Object.keys(ce.groundTruthJson as object).length > 0) {
      gtMap.set(ce.id, ce.groundTruthJson as Record<string, unknown>);
    }
  }

  for (const run of enrichedRuns) {
    // Get extraction_runs linked to this schema_run
    const exRuns = await withRLS(db, tenantId, (tx: any) =>
      tx.select({
        corpusEntryId: schema.extractionRuns.corpusEntryId,
        extractedJson: schema.extractionRuns.extractedJson,
      })
        .from(schema.extractionRuns)
        .where(eq(schema.extractionRuns.schemaRunId, run.id))
    );

    if (exRuns.length === 0) continue;

    const fieldCorrect: Record<string, number> = {};
    const fieldChecked: Record<string, number> = {};

    for (const exRun of exRuns) {
      const gt = gtMap.get(exRun.corpusEntryId);
      if (!gt) continue;
      const extracted = exRun.extractedJson as Record<string, unknown>;

      for (const [field, expected] of Object.entries(gt)) {
        if (expected === undefined || expected === null) continue;
        fieldChecked[field] = (fieldChecked[field] ?? 0) + 1;
        const got = extracted[field];
        if (String(expected).trim().toLowerCase() === String(got ?? "").trim().toLowerCase()) {
          fieldCorrect[field] = (fieldCorrect[field] ?? 0) + 1;
        }
      }
    }

    const fields: Record<string, number> = {};
    for (const f of Object.keys(fieldChecked)) {
      fields[f] = fieldChecked[f]! > 0 ? ((fieldCorrect[f] ?? 0) / fieldChecked[f]!) * 100 : 100;
    }
    perRunFieldAccuracy.push({ runId: run.id, fields });
  }

  // Corpus count
  const [corpusCount] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ count: sql<number>`count(*)::int` })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.schemaId, s.id))
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

  const body = await c.req.json<{ model?: string }>().catch(() => ({}));

  // Get schema + current YAML
  const [schemaRow] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({
      id: schema.schemas.id,
      draftYaml: schema.schemas.draftYaml,
    })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  // Get latest version YAML (fallback to draft)
  const [latestVersion] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({
      versionNumber: schema.schemaVersions.versionNumber,
      yamlSource: schema.schemaVersions.yamlSource,
    })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, schemaRow.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );

  const schemaYaml = latestVersion?.yamlSource ?? schemaRow.draftYaml;
  if (!schemaYaml) return c.json({ error: "No schema YAML found" }, 400);

  // Get all corpus entries with ground truth
  const entries = await withRLS(db, tenantId, (tx: any) =>
    tx.select({
      id: schema.corpusEntries.id,
      filename: schema.corpusEntries.filename,
      groundTruthJson: schema.corpusEntries.groundTruthJson,
    })
      .from(schema.corpusEntries)
      .where(eq(schema.corpusEntries.schemaId, schemaRow.id))
  );

  const entriesWithGT = entries.filter((e: any) =>
    e.groundTruthJson && typeof e.groundTruthJson === "object" && Object.keys(e.groundTruthJson as object).length > 0
  );

  if (entriesWithGT.length === 0) {
    return c.json({ error: "No corpus entries have ground truth. Save ground truth from Build mode first." }, 400);
  }

  const principal = getPrincipal(c);

  // Get the version ID for the schema_run
  const [latestVersionRow] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ id: schema.schemaVersions.id })
      .from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, schemaRow.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );
  const versionId = latestVersionRow?.id;
  if (!versionId) return c.json({ error: "No schema version found. Commit the schema first." }, 400);

  // Create the schema_run record
  const [schemaRun] = await withRLS(db, tenantId, (tx: any) =>
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

  // Run extraction on each entry via the internal extract/run endpoint
  const EXTRACT_RUN_URL = `http://localhost:${process.env.PORT ?? "9401"}/api/extract/run`;
  const sessionCookie = c.req.header("cookie") ?? "";
  const tenantHeader = c.req.header("x-koji-tenant") ?? "";

  const results: Array<{
    entryId: string;
    filename: string;
    groundTruth: Record<string, unknown>;
    extracted: Record<string, unknown>;
    confidenceScores: Record<string, number>;
  }> = [];

  // Get previous extraction runs for regression detection (before we create new ones)
  const prevExtractedMap = new Map<string, Record<string, unknown>>();
  for (const entry of entriesWithGT) {
    const [prevRun] = await withRLS(db, tenantId, (tx: any) =>
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

  // Run extractions (sequentially to avoid overwhelming the extract service)
  for (const entry of entriesWithGT) {
    try {
      const resp = await fetch(EXTRACT_RUN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": sessionCookie,
          "x-koji-tenant": tenantHeader,
        },
        body: JSON.stringify({
          corpus_entry_id: entry.id,
          schema_yaml: schemaYaml,
          schema_run_id: schemaRun.id,
          ...(body.model ? { model: body.model } : {}),
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        results.push({
          entryId: entry.id,
          filename: entry.filename,
          groundTruth: entry.groundTruthJson as Record<string, unknown>,
          extracted: (data.extracted as Record<string, unknown>) ?? {},
          confidenceScores: (data.confidence_scores as Record<string, number>) ?? {},
        });
      }
    } catch (err) {
      console.warn(`[validate] Failed to extract ${entry.filename}:`, err instanceof Error ? err.message : err);
    }
  }

  if (results.length === 0) {
    // Update schema_run as failed
    await withRLS(db, tenantId, (tx: any) =>
      tx.update(schema.schemaRuns).set({ status: "failed", completedAt: new Date(), errorMessage: "All extractions failed" })
        .where(eq(schema.schemaRuns.id, schemaRun.id))
    );
    return c.json({ error: "All extractions failed" }, 502);
  }

  const validateResult = computeValidateResult(results, prevExtractedMap, latestVersion?.versionNumber ?? 0, startTime);

  // Update schema_run with results
  await withRLS(db, tenantId, (tx: any) =>
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

  return c.json(validateResult);
});

/** Compare extraction results against ground truth and compute accuracy/regressions. */
function computeValidateResult(
  results: Array<{ entryId: string; filename: string; groundTruth: Record<string, unknown>; extracted: Record<string, unknown>; confidenceScores: Record<string, number> }>,
  prevExtractedMap: Map<string, Record<string, unknown>>,
  schemaVersion: number,
  startTime: number,
) {
  const allFields = new Set<string>();
  for (const r of results) {
    for (const k of Object.keys(r.groundTruth)) allFields.add(k);
  }

  const fieldResults: Array<{ name: string; accuracy: number; prevAccuracy: number | null; status: string; failingDocs: Array<{ id: string; filename: string; expected: string; got: string; confidence: number }> }> = [];
  let totalCorrect = 0;
  let totalChecked = 0;
  const failingDocsMap = new Map<string, { id: string; filename: string; failedFields: string[]; worstConfidence: number }>();

  for (const fieldName of allFields) {
    let correct = 0, checked = 0, prevCorrect = 0, prevChecked = 0;
    const failing: Array<{ id: string; filename: string; expected: string; got: string; confidence: number }> = [];

    for (const r of results) {
      const expected = r.groundTruth[fieldName];
      if (expected === undefined || expected === null) continue;
      checked++;
      const expectedStr = String(expected).trim().toLowerCase();
      const got = r.extracted[fieldName];

      if (String(got ?? "").trim().toLowerCase() === expectedStr) {
        correct++;
      } else {
        const conf = r.confidenceScores[fieldName] ?? 0;
        failing.push({ id: r.entryId, filename: r.filename, expected: String(expected), got: String(got ?? "—"), confidence: conf });
        const existing = failingDocsMap.get(r.entryId);
        if (existing) { existing.failedFields.push(fieldName); existing.worstConfidence = Math.min(existing.worstConfidence, conf); }
        else { failingDocsMap.set(r.entryId, { id: r.entryId, filename: r.filename, failedFields: [fieldName], worstConfidence: conf }); }
      }

      const prevExtracted = prevExtractedMap.get(r.entryId);
      if (prevExtracted) {
        prevChecked++;
        if (String(prevExtracted[fieldName] ?? "").trim().toLowerCase() === expectedStr) prevCorrect++;
      }
    }

    const accuracy = checked > 0 ? (correct / checked) * 100 : 100;
    const prevAccuracy = prevChecked > 0 ? (prevCorrect / prevChecked) * 100 : null;
    totalCorrect += correct;
    totalChecked += checked;
    const status = failing.length > 0 ? (prevAccuracy !== null && prevAccuracy > accuracy ? "regressed" : "failing") : "pass";
    fieldResults.push({ name: fieldName, accuracy, prevAccuracy, status, failingDocs: failing });
  }

  fieldResults.sort((a, b) => a.accuracy - b.accuracy);
  const overallAccuracy = totalChecked > 0 ? (totalCorrect / totalChecked) * 100 : 100;

  return {
    overallAccuracy,
    prevAccuracy: null,
    docsTotal: results.length,
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

  const [schemaRow] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  const [latestVersion] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ versionNumber: schema.schemaVersions.versionNumber })
      .from(schema.schemaVersions).where(eq(schema.schemaVersions.schemaId, schemaRow.id))
      .orderBy(desc(schema.schemaVersions.versionNumber)).limit(1)
  );

  const entries = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ id: schema.corpusEntries.id, filename: schema.corpusEntries.filename, groundTruthJson: schema.corpusEntries.groundTruthJson })
      .from(schema.corpusEntries).where(eq(schema.corpusEntries.schemaId, schemaRow.id))
  );

  const entriesWithGT = entries.filter((e: any) =>
    e.groundTruthJson && typeof e.groundTruthJson === "object" && Object.keys(e.groundTruthJson as object).length > 0
  );

  if (entriesWithGT.length === 0) return c.json(null);

  const results: Array<{ entryId: string; filename: string; groundTruth: Record<string, unknown>; extracted: Record<string, unknown>; confidenceScores: Record<string, number> }> = [];
  const prevExtractedMap = new Map<string, Record<string, unknown>>();

  for (const entry of entriesWithGT) {
    const runs = await withRLS(db, tenantId, (tx: any) =>
      tx.select({ extractedJson: schema.extractionRuns.extractedJson, confidenceScoresJson: schema.extractionRuns.confidenceScoresJson })
        .from(schema.extractionRuns).where(eq(schema.extractionRuns.corpusEntryId, entry.id))
        .orderBy(desc(schema.extractionRuns.createdAt)).limit(2)
    );
    if (runs.length > 0) {
      results.push({
        entryId: entry.id, filename: entry.filename,
        groundTruth: entry.groundTruthJson as Record<string, unknown>,
        extracted: runs[0].extractedJson as Record<string, unknown>,
        confidenceScores: (runs[0].confidenceScoresJson as Record<string, number>) ?? {},
      });
      if (runs.length > 1) prevExtractedMap.set(entry.id, runs[1].extractedJson as Record<string, unknown>);
    }
  }

  if (results.length === 0) return c.json(null);

  return c.json(computeValidateResult(results, prevExtractedMap, latestVersion?.versionNumber ?? 0, startTime));
});
