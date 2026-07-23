import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getProjectId } from "../auth/middleware";

/**
 * Project-level corpus pool routes (oss-449 / oss-450).
 *
 * The pool is the project's shared document store — one row per file, uploaded
 * by any corpus surface (a schema corpus, a classifier corpus). This lists it
 * so a picker can attach a document to a new label without re-uploading it,
 * which is the reuse the split exists for: label a PDF once for a schema, then
 * label the same pooled PDF for a classifier via `document_id`.
 */
export const corpus = new Hono<Env>();

/**
 * GET /api/corpus/documents — list the current project's pool documents.
 *
 * Project-scoped via the RESTRICTIVE policy (needs `x-koji-project`). Optional
 * `?content_hash=` filters to a specific file (e.g. "is this document already
 * pooled?"). Never returns the storage key — a signed URL is a separate,
 * audited fetch.
 */
corpus.get("/documents", requires("corpus:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const contentHash = c.req.query("content_hash");

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.corpusDocuments.id,
        filename: schema.corpusDocuments.filename,
        fileSize: schema.corpusDocuments.fileSize,
        mimeType: schema.corpusDocuments.mimeType,
        contentHash: schema.corpusDocuments.contentHash,
        source: schema.corpusDocuments.source,
        createdAt: schema.corpusDocuments.createdAt,
      })
      .from(schema.corpusDocuments)
      .where(
        and(
          isNull(schema.corpusDocuments.deletedAt),
          contentHash ? eq(schema.corpusDocuments.contentHash, contentHash) : undefined,
        ),
      )
      .orderBy(desc(schema.corpusDocuments.createdAt)),
  );

  return c.json({ data: rows });
});
