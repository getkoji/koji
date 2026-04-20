import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, desc, asc } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";

export const review = new Hono<Env>();

/**
 * GET /api/review — the review queue.
 *
 * Joins reviewItems → documents → jobs → pipelines and schemas so the dashboard
 * row carries all display context in a single request. Filter by status; sort
 * pending items by confidence ASC (worst first) so the queue behaves like a
 * work-prioritized inbox.
 */
review.get("/", requires("review:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const status = c.req.query("status") ?? "pending";
  const limit = parseInt(c.req.query("limit") ?? "100", 10);

  const orderClause =
    status === "completed"
      ? desc(schema.reviewItems.resolvedAt)
      : asc(schema.reviewItems.confidence);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.reviewItems.id,
        fieldName: schema.reviewItems.fieldName,
        reason: schema.reviewItems.reason,
        proposedValue: schema.reviewItems.proposedValue,
        confidence: schema.reviewItems.confidence,
        validationRule: schema.reviewItems.validationRule,
        status: schema.reviewItems.status,
        resolution: schema.reviewItems.resolution,
        finalValue: schema.reviewItems.finalValue,
        note: schema.reviewItems.note,
        assignedTo: schema.reviewItems.assignedTo,
        createdAt: schema.reviewItems.createdAt,
        resolvedAt: schema.reviewItems.resolvedAt,
        documentId: schema.documents.id,
        documentFilename: schema.documents.filename,
        jobSlug: schema.jobs.slug,
        pipelineSlug: schema.pipelines.slug,
        pipelineName: schema.pipelines.displayName,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
      })
      .from(schema.reviewItems)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.reviewItems.documentId))
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.reviewItems.schemaId))
      .where(eq(schema.reviewItems.status, status))
      .orderBy(orderClause)
      .limit(limit),
  );

  return c.json({ data: rows });
});

/**
 * GET /api/review/:id — a single review item with document preview URL.
 */
review.get("/:id", requires("review:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const id = c.req.param("id")!;

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.reviewItems.id,
        fieldName: schema.reviewItems.fieldName,
        reason: schema.reviewItems.reason,
        proposedValue: schema.reviewItems.proposedValue,
        confidence: schema.reviewItems.confidence,
        validationRule: schema.reviewItems.validationRule,
        status: schema.reviewItems.status,
        resolution: schema.reviewItems.resolution,
        finalValue: schema.reviewItems.finalValue,
        note: schema.reviewItems.note,
        assignedTo: schema.reviewItems.assignedTo,
        createdAt: schema.reviewItems.createdAt,
        resolvedAt: schema.reviewItems.resolvedAt,
        documentId: schema.documents.id,
        documentFilename: schema.documents.filename,
        documentStorageKey: schema.documents.storageKey,
        documentMimeType: schema.documents.mimeType,
        documentExtractionJson: schema.documents.extractionJson,
        documentPageCount: schema.documents.pageCount,
        jobSlug: schema.jobs.slug,
        pipelineSlug: schema.pipelines.slug,
        pipelineName: schema.pipelines.displayName,
        schemaSlug: schema.schemas.slug,
        schemaName: schema.schemas.displayName,
        schemaVersion: schema.schemaVersions.versionNumber,
      })
      .from(schema.reviewItems)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.reviewItems.documentId))
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.documents.jobId))
      .leftJoin(schema.pipelines, eq(schema.pipelines.id, schema.jobs.pipelineId))
      .leftJoin(schema.schemas, eq(schema.schemas.id, schema.reviewItems.schemaId))
      .leftJoin(
        schema.schemaVersions,
        eq(schema.schemaVersions.id, schema.pipelines.activeSchemaVersionId),
      )
      .where(eq(schema.reviewItems.id, id))
      .limit(1),
  );

  if (!row) {
    return c.json({ error: "Review item not found" }, 404);
  }

  // Try to produce a signed URL for the document. Swallow errors — seeded rows
  // may point to storage objects that don't exist in the bucket.
  let documentPreviewUrl: string | null = null;
  if (row.documentStorageKey) {
    try {
      documentPreviewUrl = await storage.getSignedUrl(row.documentStorageKey, 3600);
    } catch {
      documentPreviewUrl = null;
    }
  }

  return c.json({ ...row, documentPreviewUrl });
});

// ──────────────────────────────────────────────────────────────────────
// Decision endpoints
// ──────────────────────────────────────────────────────────────────────

async function resolveItem(
  c: Context<Env>,
  id: string,
  patch: Record<string, unknown>,
) {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);

  const [updated] = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.reviewItems)
      .set({
        ...patch,
        resolvedBy: principal.userId,
        resolvedAt: new Date(),
        status: "completed",
      })
      .where(and(eq(schema.reviewItems.id, id), eq(schema.reviewItems.status, "pending")))
      .returning(),
  );

  if (!updated) {
    return c.json({ error: "Review item not found or already resolved" }, 404);
  }
  return c.json(updated);
}

/** POST /api/review/:id/accept — approve the model's proposal as-is. */
review.post("/:id/accept", requires("review:act"), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  const [item] = await withRLS(c.get("db"), getTenantId(c), (tx) =>
    tx
      .select({ proposedValue: schema.reviewItems.proposedValue })
      .from(schema.reviewItems)
      .where(eq(schema.reviewItems.id, id))
      .limit(1),
  );
  if (!item) return c.json({ error: "Review item not found" }, 404);

  return resolveItem(c, id, {
    resolution: "approved",
    finalValue: item.proposedValue,
    note: body.note ?? null,
  });
});

/** POST /api/review/:id/override — approve with edits. */
review.post("/:id/override", requires("review:act"), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json<{ value: unknown; note?: string }>();
  if (body.value === undefined) {
    return c.json({ error: "value is required" }, 400);
  }
  return resolveItem(c, id, {
    resolution: "approved",
    finalValue: body.value,
    note: body.note ?? null,
  });
});

/** POST /api/review/:id/reject — mark the item failed. */
review.post("/:id/reject", requires("review:act"), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json<{ reason: string }>();
  if (!body.reason) {
    return c.json({ error: "reason is required" }, 400);
  }
  return resolveItem(c, id, {
    resolution: "rejected",
    note: body.reason,
  });
});

/**
 * POST /api/review/:id/skip — no-op today.
 *
 * The dashboard tracks per-session skip state client-side so skipped items
 * don't re-appear until reload. A future deprioritization mechanism (e.g. a
 * skipped_at column) will make this server-side. The endpoint exists now so
 * the client contract is stable.
 */
review.post("/:id/skip", requires("review:act"), async (c) => {
  return c.body(null, 204);
});

// Bulk fetch for queue-position math on the detail page.
// GET /api/review/queue-ids?status=pending — returns IDs in queue order so the
// detail page can compute prev/next without re-sorting client-side.
review.get("/__queue/ids", requires("review:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const status = c.req.query("status") ?? "pending";
  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.reviewItems.id })
      .from(schema.reviewItems)
      .where(eq(schema.reviewItems.status, status))
      .orderBy(
        status === "completed"
          ? desc(schema.reviewItems.resolvedAt)
          : asc(schema.reviewItems.confidence),
      ),
  );
  return c.json({ data: rows.map((r) => r.id) });
});
