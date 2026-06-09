import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";

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
    const [s] = await withRLS(db, tenantId, (tx) =>
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
  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schema.schemas.id })
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

  // Check for existing entry with same hash
  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx.select()
      .from(schema.corpusEntries)
      .where(and(
        eq(schema.corpusEntries.schemaId, s.id),
        eq(schema.corpusEntries.contentHash, contentHash),
      ))
      .limit(1),
  );

  if (existing) {
    // Duplicate — clean up the just-uploaded file and return existing entry
    await storage.delete(body.storageKey);
    return c.json(existing, 200);
  }

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.insert(schema.corpusEntries).values({
      tenantId,
      schemaId: s.id,
      filename: body.filename,
      storageKey: body.storageKey,
      fileSize: fileResult.data.length,
      mimeType: fileResult.contentType,
      contentHash,
      source: "upload",
      groundTruthJson: {},
      addedBy: principal.userId,
    }).returning(),
  );

  return c.json(row, 201);
});
