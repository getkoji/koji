import { Hono } from "hono";
import { eq, sql, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId, getRlsScope } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { compileSchema } from "../schemas/compiler";
import { extractFieldMetas } from "../schemas/field-meta";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { compareValues } from "../extract/value-compare";
import type { ProvenanceMap, FlatTextMapSegment } from "../extract/provenance";
import { toProvenanceTextMap } from "../extract/provenance";
import { locateWordsByRegion } from "../extract/region";
import { parseResolveRegionBody } from "./jobs";
import { and, isNull, isNotNull, inArray } from "drizzle-orm";
import { snapshotCandidate, graduateCandidate, releaseDirect } from "../schemas/versioning";
import { formatSemver, type Bump } from "../schemas/semver";
import { resolveMimeType } from "../ingestion/mime";
import { resolveParse } from "../ingestion/seam";
import { mapWithConcurrency } from "../parse/pdf-slice";
import { computeValidateResult } from "../schemas/validate-scoring";
import { runTuneIteration } from "../schemas/tune";
import { runTuneLoop } from "../schemas/tune-loop";
import { runCorpusTuneLoop, type CorpusEntryWithGt } from "../schemas/corpus-tune-loop";
import { streamSSE } from "hono/streaming";
import {
  runValidateDoc,
  maybeFinalizeValidateRun,
  type ValidateRunContext,
  type ValidateDocJobPayload,
} from "../schemas/validate-run";

// Validate scoring lives in ../schemas/validate-scoring (shared with the async
// run finalizer). Re-exported here for existing consumers and tests.
export { answerPresentInText } from "../schemas/validate-scoring";
export { computeValidateResult };

/** Bounded parallelism for the sync validate driver — enough to keep a small
 *  corpus well inside request timeouts without hammering the model endpoint. */
const VALIDATE_SYNC_CONCURRENCY = 3;

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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    let latestVersionLabel: string | null = null;
    const [sv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx.select({
        versionNumber: schema.schemaVersions.versionNumber,
        major: schema.schemaVersions.major,
        minor: schema.schemaVersions.minor,
        patch: schema.schemaVersions.patch,
        prerelease: schema.schemaVersions.prerelease,
      })
        .from(schema.schemaVersions)
        .where(eq(schema.schemaVersions.schemaId, row.id))
        .orderBy(desc(schema.schemaVersions.versionNumber))
        .limit(1)
    );
    if (sv) {
      latestVersion = sv.versionNumber;
      latestVersionLabel = formatSemver(sv);
    }

    const [cc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` })
        .from(schema.corpusEntries)
        .where(and(eq(schema.corpusEntries.schemaId, row.id), isNull(schema.corpusEntries.deletedAt)))
    );
    const corpusCount = cc?.count ?? 0;

    enriched.push({ ...row, latestVersion, latestVersionLabel, corpusCount });
  }

  return c.json({ data: enriched });
});

schemas.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select().from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  let latestVersion: { versionNumber: number; version: string; yamlSource: string; commitMessage: string | null; createdAt: Date } | null = null;
  const [sv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      versionNumber: schema.schemaVersions.versionNumber,
      major: schema.schemaVersions.major,
      minor: schema.schemaVersions.minor,
      patch: schema.schemaVersions.patch,
      prerelease: schema.schemaVersions.prerelease,
      yamlSource: schema.schemaVersions.yamlSource,
      commitMessage: schema.schemaVersions.commitMessage,
      createdAt: schema.schemaVersions.createdAt,
    }).from(schema.schemaVersions)
      .where(eq(schema.schemaVersions.schemaId, s.id))
      .orderBy(desc(schema.schemaVersions.versionNumber))
      .limit(1)
  );
  if (sv) {
    const { major: _ma, minor: _mi, patch: _pa, prerelease: _pr, ...rest } = sv;
    latestVersion = { ...rest, version: formatSemver(sv) };
  }

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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id, draftYaml: schema.schemas.draftYaml })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const [sv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    // Plan quantity limits are per-TENANT — count tenant-wide, not per-project,
    // or each new project would multiply the quota.
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

  const [newSchema] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.insert(schema.schemas).values({
      tenantId,
      projectId: requireProjectId(c),
      slug: body.slug,
      displayName: body.display_name,
      description: body.description ?? null,
      draftYaml: yamlSource,
      createdBy: principal.userId,
    }).returning()
  );

  const [v1] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.insert(schema.schemaVersions).values({
      tenantId,
      schemaId: newSchema!.id,
      versionNumber: 1,
      // First release is v0.0.1 — same convention as the lifecycle helpers
      // (versioning.ts) when there is no active release to bump from.
      major: 0,
      minor: 0,
      patch: 1,
      yamlSource,
      yamlHash,
      parsedJson: result.parsed,
      commitMessage: "Initial version",
      committedBy: principal.userId,
    }).returning()
  );

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.schemas)
      .set({ currentVersionId: v1!.id })
      .where(eq(schema.schemas.id, newSchema!.id))
  );

  return c.json({ ...newSchema, latestVersion: 1, latestVersionLabel: formatSemver(v1!) }, 201);
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.schemas).set(updates).where(eq(schema.schemas.slug, slug)).returning()
  );
  if (rows.length === 0) return c.json({ error: "Schema not found" }, 404);
  return c.json(rows[0]);
});

schemas.delete("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.schemas).set({ deletedAt: new Date() }).where(eq(schema.schemas.slug, slug))
  );
  return c.body(null, 204);
});

// ── Versions ──

schemas.get("/:slug/versions", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id, currentVersionId: schema.schemas.currentVersionId })
      .from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const [version] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  let versionId = body.versionId;
  if (!versionId) {
    const [latestRc] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.corpusEntries.id,
      filename: schema.corpusEntries.filename,
      fileSize: schema.corpusEntries.fileSize,
      mimeType: schema.corpusEntries.mimeType,
      source: schema.corpusEntries.source,
      tags: schema.corpusEntries.tags,
      groundTruthJson: schema.corpusEntries.groundTruthJson,
      createdAt: schema.corpusEntries.createdAt,
      // Latest ground-truth version's review status (draft/approved), or null
      // when the entry has no GT row yet. Lets the labeling queue distinguish
      // unlabeled / draft / approved without a per-entry fetch. Runs inside the
      // RLS tx, so it's tenant-scoped like the rest of the query.
      reviewStatus: sql<string | null>`(
        SELECT review_status FROM corpus_entry_ground_truth
        WHERE corpus_entry_id = ${schema.corpusEntries.id}
        ORDER BY created_at DESC LIMIT 1
      )`,
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  const [existing] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [row] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [entry] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  // Get all runs for this schema ordered by version
  const runs = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.schemaRuns.id,
      schemaVersionId: schema.schemaRuns.schemaVersionId,
      // status + errorMessage let the page distinguish a run that FAILED
      // (nothing scored) from one that scored 0 passing docs — without them
      // both render as "0/N", which hides outages entirely.
      status: schema.schemaRuns.status,
      errorMessage: schema.schemaRuns.errorMessage,
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

  // Per-doc failures for these runs, from the schema_run_docs progress rows
  // the validate runner writes (oss-348) — one grouped query, joined for the
  // filename. Powers the failed-run detail on the Performance page so a doc
  // dropped before scoring stays diagnosable after the HTTP response is gone.
  const runIds = runs.map((r) => r.id);
  const failureRows = runIds.length === 0 ? [] : await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      schemaRunId: schema.schemaRunDocs.schemaRunId,
      entryId: schema.schemaRunDocs.corpusEntryId,
      filename: schema.corpusEntries.filename,
      error: schema.schemaRunDocs.errorMessage,
    })
      .from(schema.schemaRunDocs)
      .innerJoin(schema.corpusEntries, eq(schema.corpusEntries.id, schema.schemaRunDocs.corpusEntryId))
      .where(and(
        inArray(schema.schemaRunDocs.schemaRunId, runIds),
        eq(schema.schemaRunDocs.status, "failed"),
      ))
      .orderBy(schema.schemaRunDocs.createdAt)
  );
  const failuresByRun = new Map<string, Array<{ entryId: string; filename: string; error: string }>>();
  for (const f of failureRows) {
    const list = failuresByRun.get(f.schemaRunId) ?? [];
    list.push({ entryId: f.entryId, filename: f.filename, error: f.error ?? "unknown error" });
    failuresByRun.set(f.schemaRunId, list);
  }

  // Enrich each run with its version's semver label + released/candidate flag.
  const enrichedRuns = [];
  for (const run of runs) {
    let versionNumber: number | null = null;
    let version: string | null = null;
    let released: boolean | null = null;
    if (run.schemaVersionId) {
      const [sv] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    enrichedRuns.push({ ...run, versionNumber, version, released, failures: failuresByRun.get(run.id) ?? [] });
  }

  // Compute per-field accuracy per run from extraction_runs + ground truth
  const perRunFieldAccuracy: Array<{ runId: string; fields: Record<string, number> }> = [];

  // Get all corpus entries with ground truth for this schema
  const corpusRows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    const exRuns = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  const [corpusCount] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  const body = await c.req.json<{
    values: Record<string, unknown>;
    /**
     * Optional per-field provenance (ProvenanceMap) captured by the
     * ground-truth builder when the human confirmed/anchored a value. Additive:
     * when absent the row is a value-only label, exactly as before.
     */
    provenance?: ProvenanceMap;
  }>();
  if (!body.values) return c.json({ error: "values is required" }, 400);
  const provenance = body.provenance ?? null;

  // Get the latest GT to set supersedes_id
  const [latest] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.corpusEntryGroundTruth.id })
      .from(schema.corpusEntryGroundTruth)
      .where(eq(schema.corpusEntryGroundTruth.corpusEntryId, entryId))
      .orderBy(desc(schema.corpusEntryGroundTruth.createdAt))
      .limit(1)
  );

  const [row] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.insert(schema.corpusEntryGroundTruth).values({
      tenantId,
      corpusEntryId: entryId,
      payloadJson: body.values,
      provenanceJson: provenance,
      authoredBy: principal.userId,
      reviewStatus: "draft",
      supersedesId: latest?.id ?? null,
    }).returning()
  );

  // Also update the corpus entry's ground_truth_json for quick access
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.update(schema.corpusEntries)
      .set({
        groundTruthJson: body.values,
        groundTruthProvenanceJson: provenance,
        updatedAt: new Date(),
      })
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.corpusEntryGroundTruth.id,
      payloadJson: schema.corpusEntryGroundTruth.payloadJson,
      provenanceJson: schema.corpusEntryGroundTruth.provenanceJson,
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
 * POST /api/schemas/:slug/corpus/:entryId/resolve-region — resolve a page
 * region to the text underneath it, for the ground-truth builder's
 * draw-a-box-to-correct flow. The corpus-scoped twin of the job endpoint
 * (jobs.ts `/:slug/documents/:docId/resolve-region`, oss-373): same body
 * contract, same `locateWordsByRegion` against the cached parse text_map —
 * only the entry lookup differs (corpus entry → contentHash rather than
 * document → job).
 *
 * Body: { page: number, bbox: {x,y,w,h} } — normalized [0,1], top-left, page
 * from 1. Returns { text, words, bbox } snapped to the matched words, or
 * { text: null, words: [], bbox: null } when nothing resolves (no parse
 * cache, no geometry, or a region over whitespace) so the caller falls back
 * to typed input — a correction is never blocked on geometry. Stateless read.
 */
schemas.post("/:slug/corpus/:entryId/resolve-region", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const tenantId = getTenantId(c);
  const entryId = c.req.param("entryId")!;

  const parsed = parseResolveRegionBody(await c.req.json().catch(() => null));
  if (!parsed) {
    return c.json(
      { error: "page (integer ≥ 1) and bbox {x,y,w,h} (normalized, w/h > 0) are required" },
      400,
    );
  }

  const [entry] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ contentHash: schema.corpusEntries.contentHash })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.id, entryId), isNull(schema.corpusEntries.deletedAt)))
      .limit(1)
  );
  if (!entry) return c.json({ error: "Corpus entry not found" }, 404);

  const empty = { text: null, words: [], bbox: null };
  if (!entry.contentHash) return c.json(empty);

  // Same parse_cache lookup as /markdown and the job resolve-region: by
  // (tenant, content_hash), most recent row (one per parse-provider
  // fingerprint since oss-298).
  const [cached] = await db
    .select({ storageKey: schema.parseCache.storageKey })
    .from(schema.parseCache)
    .where(
      and(
        eq(schema.parseCache.tenantId, tenantId),
        eq(schema.parseCache.fileHash, entry.contentHash),
      ),
    )
    .orderBy(desc(schema.parseCache.createdAt))
    .limit(1);
  if (!cached) return c.json(empty);

  const blob = await storage.getBuffer(cached.storageKey);
  if (!blob) return c.json(empty);

  let textMapFlat: FlatTextMapSegment[];
  try {
    const payload = JSON.parse(blob.data.toString()) as { text_map?: unknown };
    textMapFlat = Array.isArray(payload.text_map)
      ? (payload.text_map as FlatTextMapSegment[])
      : [];
  } catch {
    return c.json(empty);
  }
  if (textMapFlat.length === 0) return c.json(empty);

  const match = locateWordsByRegion(toProvenanceTextMap(textMapFlat), parsed.page, parsed.rect);
  if (!match) return c.json(empty);

  c.header("Cache-Control", "no-store");
  return c.json(match);
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

    const [gt] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

    const [updated] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx
        .update(schema.corpusEntries)
        .set({ groundTruthJson: gt.payloadJson, updatedAt: new Date() })
        .where(eq(schema.corpusEntries.id, entryId)),
    );

    return c.json(updated);
  },
);

/**
 * POST /api/schemas/:slug/tune — one schema-tuning iteration on an exemplar.
 *
 * Runs the given schema YAML against a single labeled corpus entry, scores it
 * against ground truth, diagnoses each failing field (incl. routing: did the
 * model even see the answer?), and asks the model to propose a minimal edit.
 * Returns the before-scores + the proposed YAML — it does NOT apply or persist
 * anything (the caller/loop decides). The score-aware counterpart to the free-
 * form build agent; the autonomous loop drives this repeatedly.
 */
schemas.post("/:slug/tune", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const body = await c.req.json<{ corpus_entry_id?: string; yaml?: string; model?: string }>();
  if (!body.corpus_entry_id) return c.json({ error: "corpus_entry_id is required" }, 400);
  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);
  // Capture into locals — property narrowing on `body.*` is reset across the
  // intervening awaits below.
  const corpusEntryId = body.corpus_entry_id;
  const yaml = body.yaml;

  // Validate the input YAML up front; the proposal is validated separately.
  // compileSchema returns errors (it does not throw), so check the result.
  const compiledInput = compileSchema(yaml);
  if (!compiledInput.ok) {
    return c.json(
      { error: "Invalid schema YAML", detail: compiledInput.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ") },
      422,
    );
  }
  const schemaDef = compiledInput.parsed as Record<string, unknown>;

  const [entry] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        storageKey: schema.corpusEntries.storageKey,
        mimeType: schema.corpusEntries.mimeType,
        contentHash: schema.corpusEntries.contentHash,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(
        and(
          eq(schema.corpusEntries.id, corpusEntryId),
          eq(schema.corpusEntries.schemaId, s.id),
          isNull(schema.corpusEntries.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!entry) return c.json({ error: "Corpus entry not found" }, 404);

  const groundTruth = entry.groundTruthJson as Record<string, unknown> | null;
  if (!groundTruth || Object.keys(groundTruth).length === 0) {
    return c.json({ error: "This corpus entry has no ground truth to tune against" }, 400);
  }

  try {
    const result = await runTuneIteration({
      db,
      storage: c.get("storage"),
      scope: getRlsScope(c),
      tenantId,
      defaultParseProvider: c.get("parseProvider"),
      parseConfig: c.get("parseConfig"),
      entry: {
        id: entry.id,
        filename: entry.filename,
        storageKey: entry.storageKey,
        mimeType: entry.mimeType,
        contentHash: entry.contentHash,
      },
      groundTruth,
      yaml,
      schemaDef,
      model: body.model,
    });
    return c.json(result);
  } catch (err) {
    console.error("[tune] iteration failed:", err);
    return c.json({ error: "Tuning failed", detail: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/**
 * POST /api/schemas/:slug/tune/loop — autonomous tuning loop on one exemplar.
 *
 * Drives /tune repeatedly (extract → score → propose → apply → re-run) until the
 * schema passes or the loop stalls, returning the best-scoring schema + the full
 * trace. Applies nothing durable (snapshot/promote is the human-gated step).
 * Streams SSE progress by default (`iteration` events + a final `complete`);
 * send `Accept: application/json` for a single aggregate response. Auth: job:run.
 */
schemas.post("/:slug/tune/loop", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const projectId = getProjectId(c);

  const [s] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const body = await c.req.json<{ corpus_entry_id?: string; yaml?: string; model?: string; max_iterations?: number }>();
  if (!body.corpus_entry_id) return c.json({ error: "corpus_entry_id is required" }, 400);
  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);
  // Capture into locals — property narrowing on body.* is reset across awaits.
  const corpusEntryId = body.corpus_entry_id;
  const startYaml = body.yaml;
  const model = body.model;
  const maxIterations = body.max_iterations;

  const compiledInput = compileSchema(startYaml);
  if (!compiledInput.ok) {
    return c.json(
      { error: "Invalid schema YAML", detail: compiledInput.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ") },
      422,
    );
  }

  const [entry] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        storageKey: schema.corpusEntries.storageKey,
        mimeType: schema.corpusEntries.mimeType,
        contentHash: schema.corpusEntries.contentHash,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.id, corpusEntryId), eq(schema.corpusEntries.schemaId, s.id), isNull(schema.corpusEntries.deletedAt)))
      .limit(1),
  );
  if (!entry) return c.json({ error: "Corpus entry not found" }, 404);
  const groundTruth = entry.groundTruthJson as Record<string, unknown> | null;
  if (!groundTruth || Object.keys(groundTruth).length === 0) {
    return c.json({ error: "This corpus entry has no ground truth to tune against" }, 400);
  }

  // Find-or-create an audit session so each applied proposal is recorded.
  // Best-effort, and project-scoped (agent_sessions requires a project).
  const scope = getRlsScope(c);
  let sessionId: string | null = null;
  if (projectId) {
    try {
      const [existing] = await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.select({ id: schema.agentSessions.id }).from(schema.agentSessions)
          .where(and(eq(schema.agentSessions.context, "schema_tuner"), eq(schema.agentSessions.contextEntityId, s.id), eq(schema.agentSessions.userId, principal.userId)))
          .limit(1),
      );
      if (existing) sessionId = existing.id;
      else {
        const [created] = await withRLS(db, { tenantId, projectId }, (tx) =>
          tx.insert(schema.agentSessions).values({ tenantId, projectId, userId: principal.userId, context: "schema_tuner", contextEntityId: s.id }).returning({ id: schema.agentSessions.id }),
        );
        sessionId = created?.id ?? null;
      }
    } catch (err) {
      console.warn("[tune/loop] could not open audit session:", err);
    }
  }

  const recordEdit = async (n: number, yaml: string, explanation: string) => {
    if (!sessionId) return;
    try {
      const [msg] = await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.insert(schema.agentMessages).values({ tenantId, sessionId: sessionId!, role: "assistant", content: explanation }).returning({ id: schema.agentMessages.id }),
      );
      if (!msg) return;
      await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.insert(schema.agentProposedEdits).values({
          tenantId, sessionId: sessionId!, messageId: msg.id,
          editKind: "schema_yaml", targetId: s.id, diffText: explanation,
          proposedChangeJson: { yaml, iteration: n }, status: "proposed",
        }),
      );
    } catch (err) {
      console.warn("[tune/loop] could not record proposal:", err);
    }
  };

  const loopDeps = {
    db, storage: c.get("storage"), scope, tenantId,
    defaultParseProvider: c.get("parseProvider"), parseConfig: c.get("parseConfig"),
    entry: { id: entry.id, filename: entry.filename, storageKey: entry.storageKey, mimeType: entry.mimeType, contentHash: entry.contentHash },
    groundTruth, model, startYaml, maxIterations,
  };

  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    try {
      const result = await runTuneLoop({ ...loopDeps, onEdit: recordEdit });
      return c.json(result);
    } catch (err) {
      console.error("[tune/loop] failed:", err);
      return c.json({ error: "Tuning loop failed", detail: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  return streamSSE(c, async (stream) => {
    try {
      const result = await runTuneLoop({
        ...loopDeps,
        onEdit: recordEdit,
        onIteration: async (it) => {
          await stream.writeSSE({ event: "iteration", data: JSON.stringify(it) });
        },
      });
      await stream.writeSSE({ event: "complete", data: JSON.stringify(result) });
    } catch (err) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err instanceof Error ? err.message : "Tuning loop failed" }) });
    }
  });
});

/**
 * POST /api/schemas/:slug/tune/corpus-loop — corpus-optimizing tune loop.
 *
 * Optimizes for WHOLE-CORPUS accuracy (not one doc): each round scores the
 * schema across every labeled corpus doc, focuses on a failing one to guide the
 * edit, then re-scores the corpus and keeps the edit only if overall accuracy
 * improved (rejecting fixes that regress other docs). Streams SSE `round` events
 * + a final `complete`, or returns JSON with `Accept: application/json`.
 * Auth: job:run.
 */
schemas.post("/:slug/tune/corpus-loop", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const principal = getPrincipal(c);
  const projectId = getProjectId(c);

  const [s] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const body = await c.req.json<{ yaml?: string; model?: string; max_iterations?: number }>();
  if (!body.yaml) return c.json({ error: "yaml is required" }, 400);
  const startYaml = body.yaml;
  const model = body.model;
  const maxIterations = body.max_iterations;

  const compiledInput = compileSchema(startYaml);
  if (!compiledInput.ok) {
    return c.json({ error: "Invalid schema YAML", detail: compiledInput.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ") }, 422);
  }

  // Every labeled corpus doc is a training signal.
  const rows = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx
      .select({
        id: schema.corpusEntries.id,
        filename: schema.corpusEntries.filename,
        storageKey: schema.corpusEntries.storageKey,
        mimeType: schema.corpusEntries.mimeType,
        contentHash: schema.corpusEntries.contentHash,
        groundTruthJson: schema.corpusEntries.groundTruthJson,
      })
      .from(schema.corpusEntries)
      .where(and(eq(schema.corpusEntries.schemaId, s.id), isNull(schema.corpusEntries.deletedAt))),
  );
  const entries: CorpusEntryWithGt[] = rows
    .filter((r) => {
      const gt = r.groundTruthJson as Record<string, unknown> | null;
      return gt != null && typeof gt === "object" && Object.keys(gt).length > 0;
    })
    .map((r) => ({
      id: r.id, filename: r.filename, storageKey: r.storageKey, mimeType: r.mimeType, contentHash: r.contentHash,
      groundTruth: r.groundTruthJson as Record<string, unknown>,
    }));
  if (entries.length === 0) {
    return c.json({ error: "No corpus documents with ground truth to tune against" }, 400);
  }

  const scope = getRlsScope(c);
  // Best-effort audit session (project-scoped), mirroring /tune/loop.
  let sessionId: string | null = null;
  if (projectId) {
    try {
      const [existing] = await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.select({ id: schema.agentSessions.id }).from(schema.agentSessions)
          .where(and(eq(schema.agentSessions.context, "schema_tuner"), eq(schema.agentSessions.contextEntityId, s.id), eq(schema.agentSessions.userId, principal.userId)))
          .limit(1),
      );
      if (existing) sessionId = existing.id;
      else {
        const [created] = await withRLS(db, { tenantId, projectId }, (tx) =>
          tx.insert(schema.agentSessions).values({ tenantId, projectId, userId: principal.userId, context: "schema_tuner", contextEntityId: s.id }).returning({ id: schema.agentSessions.id }),
        );
        sessionId = created?.id ?? null;
      }
    } catch (err) {
      console.warn("[tune/corpus-loop] could not open audit session:", err);
    }
  }
  const recordEdit = async (n: number, yaml: string, explanation: string) => {
    if (!sessionId) return;
    try {
      const [msg] = await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.insert(schema.agentMessages).values({ tenantId, sessionId: sessionId!, role: "assistant", content: explanation }).returning({ id: schema.agentMessages.id }),
      );
      if (!msg) return;
      await withRLS(db, { tenantId, projectId }, (tx) =>
        tx.insert(schema.agentProposedEdits).values({ tenantId, sessionId: sessionId!, messageId: msg.id, editKind: "schema_yaml", targetId: s.id, diffText: explanation, proposedChangeJson: { yaml, iteration: n }, status: "proposed" }),
      );
    } catch (err) {
      console.warn("[tune/corpus-loop] could not record proposal:", err);
    }
  };

  const loopDeps = {
    db, storage: c.get("storage"), scope, tenantId,
    defaultParseProvider: c.get("parseProvider"), parseConfig: c.get("parseConfig"),
    entries, startYaml, model, maxIterations,
  };

  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    try {
      const result = await runCorpusTuneLoop({ ...loopDeps, onEdit: recordEdit });
      return c.json(result);
    } catch (err) {
      console.error("[tune/corpus-loop] failed:", err);
      return c.json({ error: "Tuning loop failed", detail: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  return streamSSE(c, async (stream) => {
    try {
      const result = await runCorpusTuneLoop({
        ...loopDeps,
        onEdit: recordEdit,
        onStatus: async (message) => { await stream.writeSSE({ event: "status", data: JSON.stringify({ message }) }); },
        onRound: async (r) => { await stream.writeSSE({ event: "round", data: JSON.stringify(r) }); },
      });
      await stream.writeSSE({ event: "complete", data: JSON.stringify(result) });
    } catch (err) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: err instanceof Error ? err.message : "Tuning loop failed" }) });
    }
  });
});

/**
 * POST /api/schemas/:slug/validate — run validation.
 *
 * Re-runs extraction on every corpus entry with ground truth using the
 * current schema YAML, then compares results against ground truth.
 *
 * Two modes (oss-348):
 *   - default (sync, back-compat): docs run in-request with bounded
 *     parallelism; the full ValidateResult is the response.
 *   - `{async: true}`: one `schema.validate.doc` job per entry is enqueued
 *     and a 202 `{runId, ...}` returns immediately. Poll
 *     GET /:slug/validate/runs/:runId for progress + the final result.
 */
schemas.post("/:slug/validate", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  type ValidateBody = { model?: string; yaml?: string; bump?: Bump; commitMessage?: string; async?: boolean };
  const body = await c.req.json<ValidateBody>().catch((): ValidateBody => ({}));

  const principal = getPrincipal(c);

  const [schemaRow] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
  const entries = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    const [latestVersion] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  // Parse schema YAML for extraction — validated BEFORE the run row exists so
  // a bad YAML can't strand a queued run that no job can ever load.
  let schemaDef: Record<string, unknown>;
  try {
    const { parse: parseYaml } = await import("yaml");
    schemaDef = parseYaml(schemaYaml);
  } catch {
    return c.json({ error: "Invalid schema YAML" }, 422);
  }

  const isAsync = body.async === true;

  // Create the schema_run record (ties to the candidate or the latest version).
  const [schemaRun] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.insert(schema.schemaRuns).values({
      tenantId,
      schemaId: schemaRow.id,
      schemaVersionId: versionId,
      runType: "validate",
      triggeredBy: principal.userId,
      status: isAsync ? "queued" : "running",
      startedAt: new Date(),
      docsTotal: entriesWithGT.length,
    }).returning({ id: schema.schemaRuns.id })
  );
  if (!schemaRun) return c.json({ error: "Failed to create schema run" }, 500);

  // ── Async driver ──────────────────────────────────────────────
  // One `schema.validate.doc` job per corpus entry; the last doc to finish
  // finalizes the run (validate-run.ts). The client polls
  // GET /:slug/validate/runs/:runId. This is what keeps a big corpus (or an
  // expensive per-doc config like enumerate_rows) clear of every request
  // timeout — no single invocation carries more than one document (oss-348).
  if (isAsync) {
    const queue = c.get("queue");
    for (const entry of entriesWithGT) {
      const payload: ValidateDocJobPayload = {
        schemaRunId: schemaRun.id,
        corpusEntryId: entry.id,
        model: body.model ?? null,
      };
      await queue.enqueue("schema.validate.doc", payload, { tenantId, maxRetries: 2 });
    }
    return c.json(
      {
        runId: schemaRun.id,
        status: "queued",
        docsTotal: entriesWithGT.length,
        version: versionLabel,
        bump,
        deduped,
      },
      202,
    );
  }

  // ── Sync driver (back-compat) ─────────────────────────────────
  // Same per-doc unit as the async jobs, run in-request with bounded
  // parallelism. Kept so clients that don't pass `async` (older CLIs, direct
  // API callers) still get the full result in one response.
  const storage = c.get("storage");
  const { provider, model: extractModel } = await resolveTenantProvider(db, getRlsScope(c), {
    preferModel: body.model ?? null,
  });

  // Resolve the tenant's BYO parse provider ONCE before the docs run. Validate
  // must parse with the SAME provider production (`run`/ingestion) uses, not
  // the global default — otherwise scanned/degraded docs that only the
  // tenant's provider handles parse empty here and score as failures
  // (oss-308). `resolveParse` is the one shared resolver every surface uses
  // (oss-310).
  const { provider: parseProvider, fingerprint: parseFingerprint } = await resolveParse(
    db,
    getRlsScope(c),
    {
      parseProviderId: null,
      defaultProvider: c.get("parseProvider"),
      parseConfig: c.get("parseConfig"),
    },
  );

  const ctx: ValidateRunContext = {
    tenantId,
    schemaRunId: schemaRun.id,
    schemaId: schemaRow.id,
    schemaVersionId: versionId,
    schemaDef,
    yamlHash: createHash("sha256").update(schemaYaml).digest("hex"),
    provider,
    extractModel,
    parseProvider,
    parseFingerprint,
    triggeredBy: principal.userId,
  };

  await mapWithConcurrency(entriesWithGT, VALIDATE_SYNC_CONCURRENCY, (entry) =>
    runValidateDoc(db, storage, ctx, entry.id),
  );

  const outcome = await maybeFinalizeValidateRun(db, tenantId, schemaRun.id);
  if (!outcome.finalized) {
    // Every doc ran in-request, so the claim can only have been lost to a
    // concurrent caller — surface it rather than serving a half-read.
    return c.json({ error: "Validate run was finalized elsewhere" }, 409);
  }
  if (outcome.status === "failed") {
    // Surface the per-doc reasons so an all-failed run is debuggable instead
    // of an opaque 502 (oss-308).
    return c.json({ error: outcome.error, parseFailures: outcome.parseFailures }, 502);
  }

  // Surface the candidate the run scored — its semver label, the auto-derived
  // bump (vs the active release), and whether identical content was reused.
  // The candidate is NOT activated; promotion is a separate, gated step.
  return c.json({ ...outcome.result, bump, deduped });
});

/**
 * GET /api/schemas/:slug/validate/runs/:runId — poll an async validate run.
 *
 * Cheap DB reads only: run status, per-doc progress (schema_run_docs rows vs
 * docs_total), and — once finalized — the persisted ValidateResult. The CLI
 * and dashboard poll this after POST /validate {async:true}.
 */
schemas.get("/:slug/validate/runs/:runId", requires("job:run"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const runId = c.req.param("runId")!;

  const [schemaRow] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  const [run] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      id: schema.schemaRuns.id,
      schemaId: schema.schemaRuns.schemaId,
      status: schema.schemaRuns.status,
      docsTotal: schema.schemaRuns.docsTotal,
      errorMessage: schema.schemaRuns.errorMessage,
      resultJson: schema.schemaRuns.resultJson,
    }).from(schema.schemaRuns).where(eq(schema.schemaRuns.id, runId)).limit(1)
  );
  if (!run || run.schemaId !== schemaRow.id) return c.json({ error: "Run not found" }, 404);

  const [progress] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ count: sql<number>`count(*)::int` })
      .from(schema.schemaRunDocs)
      .where(eq(schema.schemaRunDocs.schemaRunId, run.id))
  );

  const failed = run.status === "failed";
  return c.json({
    runId: run.id,
    status: run.status,
    docsTotal: run.docsTotal,
    docsProcessed: progress?.count ?? 0,
    result: run.status === "completed" ? run.resultJson : null,
    error: failed ? (run.errorMessage ?? "Validate run failed") : null,
    ...(failed
      ? { parseFailures: (run.resultJson as { parseFailures?: unknown } | null)?.parseFailures ?? [] }
      : {}),
  });
});

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

  const [schemaRow] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id }).from(schema.schemas).where(eq(schema.schemas.slug, slug)).limit(1)
  );
  if (!schemaRow) return c.json({ error: "Schema not found" }, 404);

  const [latestVersion] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      versionNumber: schema.schemaVersions.versionNumber,
      major: schema.schemaVersions.major,
      minor: schema.schemaVersions.minor,
      patch: schema.schemaVersions.patch,
      prerelease: schema.schemaVersions.prerelease,
      yamlSource: schema.schemaVersions.yamlSource,
    })
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

  const entries = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
    const runs = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  // Same shape as a finalized run's resultJson — `version` is the semver label
  // the Validate tab shows instead of the raw versionNumber.
  return c.json({
    ...computeValidateResult(results, prevExtractedMap, latestVersion?.versionNumber ?? 0, startTime, [], getSchemaFields),
    version: latestVersion ? formatSemver(latestVersion) : null,
  });
});
