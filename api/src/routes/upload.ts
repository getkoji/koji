import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId } from "../auth/middleware";
import { upsertCorpusDocument } from "../schemas/corpus-pool";
import { normalizeMimeTypeWithWarning } from "../ingestion/process";

export const upload = new Hono<Env>();

/**
 * POST /api/upload/presign — generate a presigned PUT URL for direct-to-S3 upload.
 *
 * The client PUTs the file directly to the returned URL, bypassing Vercel's
 * 4.5 MB body size limit.
 */
upload.post("/presign", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");

  const body = await c.req.json<{
    filename: string;
    contentType: string;
    context: "corpus" | "test";
    schemaSlug?: string;
  }>();

  if (!body.filename || !body.contentType) {
    return c.json({ error: "filename and contentType are required" }, 400);
  }

  // For corpus uploads, resolve the schema to scope the storage key
  let schemaId = "ephemeral";
  if (body.context === "corpus") {
    if (!body.schemaSlug) {
      return c.json({ error: "schemaSlug is required for corpus uploads" }, 400);
    }
    const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
      tx.select({ id: schema.schemas.id })
        .from(schema.schemas)
        .where(eq(schema.schemas.slug, body.schemaSlug!))
        .limit(1),
    );
    if (!s) return c.json({ error: "Schema not found" }, 404);
    schemaId = s.id;
  }

  // Sanitize filename for use in S3 key
  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storageKey = `${body.context}/${tenantId}/${schemaId}/${Date.now()}-${safeName}`;

  const uploadUrl = await storage.getSignedUploadUrl(storageKey, body.contentType);

  return c.json({ uploadUrl, storageKey });
});

/**
 * POST /api/upload/complete — finalize a presigned upload.
 *
 * After the client PUTs the file to S3, it calls this endpoint to create the
 * DB record (corpus entry). The server verifies the file exists, computes its
 * content hash for dedup, and inserts the row.
 */
upload.post("/complete", requires("corpus:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const principal = getPrincipal(c);

  const body = await c.req.json<{
    storageKey: string;
    filename: string;
    context: "corpus";
    schemaSlug: string;
  }>();

  if (!body.storageKey || !body.filename || !body.schemaSlug) {
    return c.json({ error: "storageKey, filename, and schemaSlug are required" }, 400);
  }

  // Verify the storage key belongs to this tenant
  if (!body.storageKey.includes(`/${tenantId}/`)) {
    return c.json({ error: "Invalid storage key" }, 403);
  }

  // Resolve schema
  const [s] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({ id: schema.schemas.id, projectId: schema.schemas.projectId })
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, body.schemaSlug))
      .limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  // Verify file was actually uploaded
  const fileResult = await storage.getBuffer(body.storageKey);
  if (!fileResult) {
    return c.json({ error: "File not found in storage — upload may have failed" }, 404);
  }

  // Compute content hash for dedup
  const contentHash = createHash("sha256").update(fileResult.data).digest("hex");

  const mimeResult = normalizeMimeTypeWithWarning(fileResult.contentType, body.filename);
  if (mimeResult.warning) {
    console.warn(
      `[mime-normalize] tenant=${tenantId} endpoint=upload.complete ` +
        `filename=${JSON.stringify(body.filename)} ` +
        `claimed=${JSON.stringify(fileResult.contentType ?? null)} ` +
        `normalized=${JSON.stringify(mimeResult.value)}`,
    );
  }

  // Corpus lives in the schema's project (derived from the schema row, not the
  // header) — matches the backfill and needs no x-koji-project.
  const projectId = s.projectId;
  const documentId = await upsertCorpusDocument(db, { tenantId, projectId }, {
    tenantId,
    projectId,
    filename: body.filename,
    storageKey: body.storageKey,
    fileSize: fileResult.data.length,
    mimeType: mimeResult.value,
    contentHash,
    source: "upload",
    addedBy: principal.userId,
  });

  // Canonical file fields come from the pooled document (oss-476) — on a dedup
  // hit the pool document may already point at a DIFFERENT stored copy, and we
  // delete this upload below, so the response must reflect the pool document,
  // not the just-deleted bytes.
  const [doc] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx.select({
      filename: schema.corpusDocuments.filename,
      storageKey: schema.corpusDocuments.storageKey,
      fileSize: schema.corpusDocuments.fileSize,
      mimeType: schema.corpusDocuments.mimeType,
      contentHash: schema.corpusDocuments.contentHash,
      source: schema.corpusDocuments.source,
    })
      .from(schema.corpusDocuments)
      .where(eq(schema.corpusDocuments.id, documentId))
      .limit(1),
  );

  // Dedup on the pooled document, not the raw hash: one label per
  // (schema, document).
  const [existing] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx.select()
      .from(schema.corpusEntries)
      .where(and(
        eq(schema.corpusEntries.schemaId, s.id),
        eq(schema.corpusEntries.documentId, documentId),
        isNull(schema.corpusEntries.deletedAt),
      ))
      .limit(1),
  );

  if (existing) {
    // Duplicate label — clean up the just-uploaded file and return existing.
    await storage.delete(body.storageKey);
    return c.json({ ...existing, ...doc }, 200);
  }

  const [row] = await withRLS(db, { tenantId, projectId }, (tx) =>
    tx.insert(schema.corpusEntries).values({
      tenantId,
      projectId,
      documentId,
      schemaId: s.id,
      groundTruthJson: {},
      addedBy: principal.userId,
    }).returning(),
  );

  const entryResponse = { ...row, ...doc };
  return c.json(
    mimeResult.warning ? { ...entryResponse, warnings: [mimeResult.warning] } : entryResponse,
    201,
  );
});
