import { Hono } from "hono";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { requireQuantityGate } from "../billing/middleware";
import { encrypt, keyHint } from "../crypto/envelope";
import { createExtractionJob, mimeTypeFor } from "../ingestion/process";

export const sources = new Hono<Env>();

/**
 * GET /api/sources — list sources for the current tenant.
 */
sources.get("/", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.sources.id,
        slug: schema.sources.slug,
        displayName: schema.sources.displayName,
        sourceType: schema.sources.sourceType,
        status: schema.sources.status,
        lastIngestedAt: schema.sources.lastIngestedAt,
        createdAt: schema.sources.createdAt,
        targetPipelineId: schema.sources.targetPipelineId,
      })
      .from(schema.sources)
      .where(sql`deleted_at IS NULL`)
      .orderBy(schema.sources.createdAt)
  );

  return c.json({ data: rows });
});

/**
 * GET /api/sources/:id — source detail.
 */
sources.get("/:id", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  const [source] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.sources.id,
        slug: schema.sources.slug,
        displayName: schema.sources.displayName,
        sourceType: schema.sources.sourceType,
        configJson: schema.sources.configJson,
        filterConfigJson: schema.sources.filterConfigJson,
        targetPipelineId: schema.sources.targetPipelineId,
        status: schema.sources.status,
        lastIngestedAt: schema.sources.lastIngestedAt,
        createdAt: schema.sources.createdAt,
      })
      .from(schema.sources)
      .where(eq(schema.sources.id, sourceId))
      .limit(1)
  );

  if (!source) return c.json({ error: "Source not found" }, 404);
  return c.json(source);
});

/**
 * POST /api/sources — create a source.
 */
sources.post(
  "/",
  requires("source:write"),
  requireQuantityGate("max_sources", async (c) => {
    const db = c.get("db");
    const tenantId = getTenantId(c);
    const [row] = await withRLS(db, tenantId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(schema.sources).where(sql`deleted_at IS NULL`),
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
    source_type: string;
    target_pipeline_id?: string;
    filter_config?: { allowed_types?: string[]; max_file_size?: number; dedupe?: boolean };
  }>();

  if (!body.name || !body.slug || !body.source_type) {
    return c.json({ error: "name, slug, and source_type are required" }, 400);
  }

  const configJson: Record<string, unknown> = {};
  let webhookSecretPlain: string | null = null;
  let authJson: Record<string, string> | null = null;

  if (body.source_type === "webhook") {
    // Generate webhook secret
    webhookSecretPlain = randomBytes(32).toString("hex");
    const masterKey = c.get("masterKey");
    if (masterKey) {
      authJson = {
        encrypted_key: encrypt(webhookSecretPlain, masterKey, tenantId),
        key_hint: keyHint(webhookSecretPlain),
      };
    }
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.sources)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.name,
        sourceType: body.source_type,
        configJson,
        authJson,
        targetPipelineId: body.target_pipeline_id ?? null,
        filterConfigJson: body.filter_config ?? null,
        createdBy: principal.userId,
      })
      .returning({
        id: schema.sources.id,
        slug: schema.sources.slug,
        displayName: schema.sources.displayName,
        sourceType: schema.sources.sourceType,
        status: schema.sources.status,
        createdAt: schema.sources.createdAt,
      })
  );

  const result: Record<string, unknown> = { ...rows[0] };

  if (webhookSecretPlain) {
    result.webhookSecret = webhookSecretPlain;
    result.secretHint = keyHint(webhookSecretPlain);
  }

  return c.json(result, 201);
});

/**
 * PATCH /api/sources/:id — update source config.
 */
sources.patch("/:id", requires("source:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  const body = await c.req.json<{
    name?: string;
    target_pipeline_id?: string | null;
    filter_config?: object;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.target_pipeline_id !== undefined) updates.targetPipelineId = body.target_pipeline_id;
  if (body.filter_config !== undefined) updates.filterConfigJson = body.filter_config;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.update(schema.sources).set(updates).where(eq(schema.sources.id, sourceId)).returning()
  );

  if (rows.length === 0) return c.json({ error: "Source not found" }, 404);
  return c.json(rows[0]);
});

/**
 * DELETE /api/sources/:id — soft-delete (not allowed for dashboard_upload).
 */
sources.delete("/:id", requires("source:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  const [source] = await withRLS(db, tenantId, (tx) =>
    tx.select({ sourceType: schema.sources.sourceType }).from(schema.sources)
      .where(eq(schema.sources.id, sourceId)).limit(1)
  );

  if (!source) return c.json({ error: "Source not found" }, 404);
  if (source.sourceType === "dashboard_upload") {
    return c.json({ error: "Cannot delete the default upload source" }, 400);
  }

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.sources).set({ deletedAt: new Date() }).where(eq(schema.sources.id, sourceId))
  );

  return c.body(null, 204);
});

/**
 * POST /api/sources/:id/pause — pause a source.
 */
sources.post("/:id/pause", requires("source:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.sources).set({ status: "paused", updatedAt: new Date() })
      .where(eq(schema.sources.id, sourceId))
  );

  return c.json({ ok: true });
});

/**
 * POST /api/sources/:id/resume — resume a paused source.
 */
sources.post("/:id/resume", requires("source:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(schema.sources).set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.sources.id, sourceId))
  );

  return c.json({ ok: true });
});

/**
 * GET /api/sources/:id/ingestions — recent ingestions for a source.
 */
sources.get("/:id/ingestions", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const sourceId = c.req.param("id")!;

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.ingestions.id,
        filename: schema.ingestions.filename,
        fileSize: schema.ingestions.fileSize,
        status: schema.ingestions.status,
        jobId: schema.ingestions.jobId,
        docId: schema.ingestions.docId,
        failureReason: schema.ingestions.failureReason,
        receivedAt: schema.ingestions.receivedAt,
        completedAt: schema.ingestions.completedAt,
      })
      .from(schema.ingestions)
      .where(eq(schema.ingestions.sourceId, sourceId))
      .orderBy(desc(schema.ingestions.receivedAt))
      .limit(100)
  );

  return c.json({ data: rows });
});

/**
 * POST /api/sources/:id/webhook — public inbound webhook endpoint.
 *
 * No user auth — verified by HMAC signature using the source's webhook secret.
 * Accepts multipart/form-data with files.
 */
sources.post("/:id/webhook", async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const queue = c.get("queue");
  const sourceId = c.req.param("id")!;

  // Load source (bypassing RLS since this is a public endpoint)
  const [source] = await db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, sourceId))
    .limit(1);

  if (!source) return c.json({ error: "Source not found" }, 404);
  if (source.sourceType !== "webhook") return c.json({ error: "Not a webhook source" }, 400);
  if (source.status === "paused") return c.json({ error: "Source is paused" }, 503);

  // Verify signature
  const signatureHeader = c.req.header("Koji-Source-Signature");
  if (!signatureHeader) return c.json({ error: "Missing Koji-Source-Signature header" }, 401);

  const masterKey = c.get("masterKey");
  if (!masterKey || !source.authJson) {
    return c.json({ error: "Source not configured for webhook verification" }, 500);
  }

  const auth = source.authJson as { encrypted_key?: string };
  if (!auth.encrypted_key) return c.json({ error: "No webhook secret configured" }, 500);

  const { decrypt } = await import("../crypto/envelope");
  const secret = decrypt(auth.encrypted_key, masterKey, source.tenantId);

  // Parse signature: t=<timestamp>,v1=<hmac>
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => {
    const [k, ...v] = p.split("=");
    return [k, v.join("=")];
  }));

  if (!parts.t || !parts.v1) {
    return c.json({ error: "Invalid signature format" }, 401);
  }

  // Verify HMAC — sign the timestamp with the secret and compare
  const expectedSig = createHmac("sha256", secret)
    .update(`${parts.t}.${sourceId}`)
    .digest("hex");

  if (parts.v1 !== expectedSig) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Check timestamp is within 5 minutes to prevent replay attacks
  const sigAge = Math.abs(Date.now() / 1000 - parseInt(parts.t, 10));
  if (sigAge > 300) {
    return c.json({ error: "Signature expired" }, 401);
  }

  const body = await c.req.parseBody();

  // For now, create ingestions for uploaded files
  const files = Object.values(body).filter((v): v is File => v instanceof File);
  if (files.length === 0) return c.json({ error: "No files in request" }, 400);

  const ingestionIds: string[] = [];
  const filterConfig = source.filterConfigJson as { max_file_size?: number; dedupe?: boolean } | null;

  for (const file of files) {
    // Check file size
    if (filterConfig?.max_file_size && file.size > filterConfig.max_file_size) {
      return c.json({ error: `File ${file.name} exceeds max size` }, 413);
    }

    // Compute content hash
    const fileBytes = await file.arrayBuffer();
    const contentHash = createHash("sha256").update(Buffer.from(fileBytes)).digest("hex");

    // Dedupe check
    if (filterConfig?.dedupe) {
      const [existing] = await db
        .select({ id: schema.ingestions.id })
        .from(schema.ingestions)
        .where(
          and(
            eq(schema.ingestions.sourceId, sourceId),
            eq(schema.ingestions.contentHash, contentHash),
          ),
        )
        .limit(1);

      if (existing) continue; // skip duplicate
    }

    const storageKey = `ingestions/${sourceId}/${Date.now()}-${file.name}`;

    // Persist the bytes before we record the ingestion — otherwise a worker
    // could pick up an ingestion that points at a missing object.
    await storage.put(storageKey, Buffer.from(fileBytes), {
      contentType: file.type || "application/octet-stream",
    });

    // Look up the source's target pipeline + active schema version. If
    // either is missing, record the ingestion as failed up front (the
    // dashboard can show the failure reason) instead of enqueuing work
    // the worker would just fail.
    const [target] = await db
      .select({
        pipelineId: schema.pipelines.id,
        schemaId: schema.pipelines.schemaId,
        activeSchemaVersionId: schema.pipelines.activeSchemaVersionId,
        pipelineType: schema.pipelines.pipelineType,
        yamlSource: schema.pipelines.yamlSource,
      })
      .from(schema.pipelines)
      .where(eq(schema.pipelines.id, source.targetPipelineId ?? ""))
      .limit(1);

    let failureReason: string | null = null;
    if (!source.targetPipelineId || !target) {
      failureReason =
        "Source has no target pipeline — connect one on the pipeline page";
    } else if (target.pipelineType === "dag") {
      // DAG pipelines need YAML, not a deployed schema version
      if (!target.yamlSource) {
        failureReason = "Pipeline has no DAG definition — save one in the editor first";
      }
    } else if (!target.schemaId || !target.activeSchemaVersionId) {
      failureReason =
        "Pipeline has no deployed schema version — deploy one first";
    }

    const [ingestion] = await db
      .insert(schema.ingestions)
      .values({
        tenantId: source.tenantId,
        sourceId,
        filename: file.name,
        fileSize: file.size,
        storageKey,
        contentHash,
        status: failureReason ? "failed" : "received",
        failureReason,
        completedAt: failureReason ? new Date() : null,
      })
      .returning({ id: schema.ingestions.id });

    ingestionIds.push(ingestion!.id);

    if (failureReason) continue;

    // Create the job + document and hand the document id to the worker.
    const created = await createExtractionJob({
      db,
      tenantId: source.tenantId,
      pipelineId: target!.pipelineId,
      schemaId: target!.schemaId || "",
      schemaVersionId: target!.activeSchemaVersionId || "",
      triggerType: source.sourceType,
      storageKey,
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type || mimeTypeFor(file.name),
      contentHash,
      ingestionId: ingestion!.id,
    });

    await db
      .update(schema.ingestions)
      .set({ status: "processing", jobId: created.jobId, docId: created.documentId })
      .where(eq(schema.ingestions.id, ingestion!.id));

    // Route to the appropriate handler based on pipeline type
    if (target!.pipelineType === "dag") {
      await queue.enqueue(
        "pipeline.dag.run",
        { documentId: created.documentId, pipelineId: target!.pipelineId },
        { tenantId: source.tenantId },
      );
    } else {
      await queue.enqueue(
        "ingestion.process",
        { documentId: created.documentId },
        { tenantId: source.tenantId },
      );
    }
  }

  // Update last ingested time
  await db
    .update(schema.sources)
    .set({ lastIngestedAt: new Date() })
    .where(eq(schema.sources.id, sourceId));

  return c.json({ ok: true, ingestions: ingestionIds }, 202);
});
