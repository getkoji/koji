import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, desc, asc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, generatePreviewToken } from "../auth/middleware";
import { requireFeature } from "../billing/middleware";
import { resolveMimeType } from "../ingestion/mime";

export const review = new Hono<Env>();

/**
 * Review item ids are `uuid` columns; comparing a non-UUID string throws at the
 * Postgres layer (uncaught → 500). Callers sometimes pass a truncated/typo'd id
 * (e.g. the 8-char prefix shown in `koji review ls`), so validate the shape and
 * treat anything malformed as "not found" instead of crashing.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/**
 * Decide how a review item may be promoted into the corpus.
 *
 * This encodes the safety-critical invariant of the review → corpus loop:
 *
 *   - Human-gated (default): only a resolved + approved item may promote, and
 *     its label is `approved` and written to the denormalized
 *     `corpusEntries.groundTruthJson` that `validate` scores immediately.
 *   - Provisional: an agent-supplied label promotes as a `draft` and is
 *     deliberately KEPT OUT of the denormalized copy, so `validate` excludes it
 *     until a human approves the draft. This is what prevents an agent from
 *     grading its own homework.
 *
 * Pure and exported so the contract is unit-tested without a database.
 */
export type PromotionDecision =
  | { ok: false; error: string }
  | {
      ok: true;
      reviewStatus: "draft" | "approved";
      authoredViaAgent: boolean;
      /** Whether to write the denormalized GT copy that `validate` scores. */
      writeDenormalizedGt: boolean;
    };

export function resolvePromotion(input: {
  provisional: boolean;
  status: string | null | undefined;
  resolution: string | null | undefined;
}): PromotionDecision {
  if (!input.provisional && !(input.status === "completed" && input.resolution === "approved")) {
    return {
      ok: false,
      error:
        "Review item must be resolved and approved before promotion. " +
        "Pass provisional:true to write an unapproved draft label instead.",
    };
  }
  return input.provisional
    ? { ok: true, reviewStatus: "draft", authoredViaAgent: true, writeDenormalizedGt: false }
    : { ok: true, reviewStatus: "approved", authoredViaAgent: false, writeDenormalizedGt: true };
}

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
  const reason = c.req.query("reason");
  const limit = parseInt(c.req.query("limit") ?? "100", 10);

  const orderClause =
    status === "completed"
      ? desc(schema.reviewItems.resolvedAt)
      : asc(schema.reviewItems.confidence);

  const where = reason
    ? and(eq(schema.reviewItems.status, status), eq(schema.reviewItems.reason, reason))
    : eq(schema.reviewItems.status, status);

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
      .where(where)
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
  if (!isUuid(id)) return c.json({ error: "Review item not found" }, 404);

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
        documentConfidenceScoresJson: schema.documents.confidenceScoresJson,
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

  // Build a document preview URL via the HMAC-signed `/api/jobs/.../preview`
  // endpoint instead of a raw signed-storage URL. The preview endpoint sets
  // `Content-Disposition: inline` and the correct `Content-Type`, so browsers
  // render the document inline (PDF viewer / image) instead of triggering a
  // download — which is what storage providers do for keys without
  // recognized extensions.
  //
  // Same pattern as the jobs document-detail route; mirror it here so any
  // page that knows a review item ID can render the document with the
  // shared `<DocumentViewer />` component.
  let documentPreviewUrl: string | null = null;
  let documentToken: string | null = null;
  if (row.documentStorageKey && row.documentId && row.jobSlug) {
    const previewPath = `/api/jobs/${row.jobSlug}/documents/${row.documentId}/preview`;
    const basePath = `/api/jobs/${row.jobSlug}/documents/${row.documentId}`;
    const masterKey = c.get("masterKey") as string | null;
    if (masterKey) {
      documentToken = generatePreviewToken(basePath, masterKey);
      documentPreviewUrl = `${previewPath}?token=${documentToken}`;
    } else {
      documentPreviewUrl = previewPath;
    }
  }

  return c.json({ ...row, documentPreviewUrl, documentToken });
});

// ──────────────────────────────────────────────────────────────────────
// Decision endpoints
// ──────────────────────────────────────────────────────────────────────

async function resolveItem(
  c: Context<Env>,
  id: string,
  patch: Record<string, unknown>,
  fieldOverrides?: Record<string, unknown>,
) {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);

  const overridesPayload = fieldOverrides && Object.keys(fieldOverrides).length > 0
    ? fieldOverrides
    : undefined;

  const [updated] = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.reviewItems)
      .set({
        ...patch,
        ...(overridesPayload ? { fieldOverrides: overridesPayload } : {}),
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

  // Apply field overrides to the document's extraction JSON so downstream
  // consumers see the corrected values. Also apply the primary field's
  // final value if it differs from the proposed value.
  const documentId = (updated as Record<string, unknown>).documentId as string | undefined;
  if (documentId) {
    const allEdits: Record<string, unknown> = {};
    const fieldName = (updated as Record<string, unknown>).fieldName as string;
    const finalValue = patch.finalValue;
    if (finalValue !== undefined) {
      allEdits[fieldName] = finalValue;
    }
    if (overridesPayload) {
      Object.assign(allEdits, overridesPayload);
    }
    if (Object.keys(allEdits).length > 0) {
      // Read the current extraction, merge edits, write back
      const [doc] = await withRLS(db, tenantId, (tx) =>
        tx
          .select({ extractionJson: schema.documents.extractionJson })
          .from(schema.documents)
          .where(eq(schema.documents.id, documentId))
          .limit(1),
      );
      if (doc?.extractionJson) {
        const merged = { ...(doc.extractionJson as Record<string, unknown>), ...allEdits };
        await withRLS(db, tenantId, (tx) =>
          tx
            .update(schema.documents)
            .set({ extractionJson: merged })
            .where(eq(schema.documents.id, documentId)),
        );
      }
    }
  }

  return c.json(updated);
}

/** POST /api/review/:id/accept — approve the model's proposal as-is. */
review.post("/:id/accept", requires("review:act"), requireFeature("hitl_review"), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json<{ note?: string; fieldOverrides?: Record<string, unknown> }>()
    .catch(() => ({} as { note?: string; fieldOverrides?: Record<string, unknown> }));
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
  }, body.fieldOverrides);
});

/** POST /api/review/:id/override — approve with edits. */
review.post("/:id/override", requires("review:act"), requireFeature("hitl_review"), async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json<{ value: unknown; note?: string; fieldOverrides?: Record<string, unknown> }>();
  if (body.value === undefined) {
    return c.json({ error: "value is required" }, 400);
  }
  return resolveItem(c, id, {
    resolution: "approved",
    finalValue: body.value,
    note: body.note ?? null,
  }, body.fieldOverrides);
});

/** POST /api/review/:id/reject — mark the item failed. */
review.post("/:id/reject", requires("review:act"), requireFeature("hitl_review"), async (c) => {
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
 * POST /api/review/:id/promote — promote a reviewed document into the corpus
 * as ground truth, closing the review → corpus loop.
 *
 * Two modes:
 *
 *   Human-gated (default): the review item MUST be resolved+approved. The
 *   document's `extractionJson` already carries the human's corrections (the
 *   resolve flow merges them in), so it becomes APPROVED ground truth that
 *   `validate` scores against immediately — we write the denormalized
 *   `corpusEntries.groundTruthJson`.
 *
 *   Provisional (`provisional: true`): an agent-supplied label that has NOT
 *   been human-confirmed. Written as a `draft`, `authoredViaAgent` ground-truth
 *   row, and we deliberately leave `corpusEntries.groundTruthJson` empty so
 *   `validate` (which scores only the denormalized copy) excludes it until a
 *   human approves the draft. Optional `groundTruth` overrides the payload;
 *   otherwise the document's current `extractionJson` is used.
 *
 * The source file is copied into a corpus-scoped storage key so the corpus
 * entry's lifecycle is independent of the originating document/job. Dedup is by
 * (schemaId, contentHash): a re-promoted doc appends a new ground-truth version
 * to the existing entry instead of creating a duplicate.
 */
review.post("/:id/promote", requires("corpus:promote"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const storage = c.get("storage");
  const id = c.req.param("id")!;
  if (!isUuid(id)) return c.json({ error: "Review item not found" }, 404);

  const body = await c.req
    .json<{ provisional?: boolean; to?: string; groundTruth?: Record<string, unknown> }>()
    .catch(() => ({}) as { provisional?: boolean; to?: string; groundTruth?: Record<string, unknown> });
  const provisional = body.provisional === true;

  // Load the review item with its document + schema context.
  const [item] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        reviewId: schema.reviewItems.id,
        status: schema.reviewItems.status,
        resolution: schema.reviewItems.resolution,
        schemaId: schema.reviewItems.schemaId,
        documentId: schema.documents.id,
        filename: schema.documents.filename,
        storageKey: schema.documents.storageKey,
        mimeType: schema.documents.mimeType,
        schemaVersionId: schema.documents.schemaVersionId,
        extractionJson: schema.documents.extractionJson,
      })
      .from(schema.reviewItems)
      .leftJoin(schema.documents, eq(schema.documents.id, schema.reviewItems.documentId))
      .where(eq(schema.reviewItems.id, id))
      .limit(1),
  );

  if (!item) return c.json({ error: "Review item not found" }, 404);
  if (!item.documentId || !item.storageKey || !item.filename || !item.mimeType) {
    return c.json({ error: "Review item has no associated document" }, 400);
  }

  // Gating + the draft-vs-approved / write-denormalized-GT decision (pure,
  // unit-tested in review.test.ts).
  const decision = resolvePromotion({
    provisional,
    status: item.status,
    resolution: item.resolution,
  });
  if (!decision.ok) return c.json({ error: decision.error }, 409);

  // The ground-truth payload: the corrected full record. For provisional an
  // agent may override it; otherwise use the document's current extraction.
  const payload: Record<string, unknown> =
    (provisional ? body.groundTruth : null) ??
    (item.extractionJson as Record<string, unknown> | null) ??
    {};
  if (!payload || Object.keys(payload).length === 0) {
    return c.json({ error: "Document has no extracted values to promote" }, 400);
  }

  // Read the source file so we can copy it into the corpus and hash it.
  const file = await storage.getBuffer(item.storageKey);
  if (!file) return c.json({ error: "Source document file not found in storage" }, 404);
  const contentHash = createHash("sha256").update(file.data).digest("hex");

  // Normalize the MIME we carry into the corpus. The source document's stored
  // mimeType may predate upload-time normalization (a bare "pdf"), so resolve
  // it (claimed → filename → magic bytes) rather than copying a bad value
  // forward — a corpus entry with an invalid MIME would 502 on re-parse.
  const corpusMime = resolveMimeType(item.mimeType, item.filename, file.data);

  const reviewStatus = decision.reviewStatus;
  const tags = body.to ? [body.to] : [];

  // Dedup by (schemaId, contentHash). If the doc is already in the corpus,
  // append a new ground-truth version rather than duplicating the entry.
  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.corpusEntries.id })
      .from(schema.corpusEntries)
      .where(
        and(
          eq(schema.corpusEntries.schemaId, item.schemaId),
          eq(schema.corpusEntries.contentHash, contentHash),
        ),
      )
      .limit(1),
  );

  let corpusEntryId: string;
  let deduped = false;

  if (existing) {
    corpusEntryId = existing.id;
    deduped = true;
  } else {
    const safeName = item.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const corpusKey = `corpus/${tenantId}/${item.schemaId}/${Date.now()}-${safeName}`;
    await storage.put(corpusKey, file.data, { contentType: corpusMime });
    const entryValues: typeof schema.corpusEntries.$inferInsert = {
      tenantId,
      schemaId: item.schemaId,
      filename: item.filename,
      storageKey: corpusKey,
      fileSize: file.data.length,
      mimeType: corpusMime,
      contentHash,
      source: "review",
      sourceRef: item.reviewId,
      // Denormalized GT is what `validate` scores. Only populate it for
      // approved (human-gated) labels; provisional drafts stay excluded.
      groundTruthJson: decision.writeDenormalizedGt ? payload : {},
      tags,
      addedBy: principal.userId,
    };
    const [entry] = await withRLS(db, tenantId, (tx) =>
      tx.insert(schema.corpusEntries).values(entryValues).returning({ id: schema.corpusEntries.id }),
    );
    if (!entry) return c.json({ error: "Failed to create corpus entry" }, 500);
    corpusEntryId = entry.id;
  }

  // Append the ground-truth version (history is append-only via supersedesId).
  const [latestGt] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.corpusEntryGroundTruth.id })
      .from(schema.corpusEntryGroundTruth)
      .where(eq(schema.corpusEntryGroundTruth.corpusEntryId, corpusEntryId))
      .orderBy(desc(schema.corpusEntryGroundTruth.createdAt))
      .limit(1),
  );

  const [gt] = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.corpusEntryGroundTruth)
      .values({
        tenantId,
        corpusEntryId,
        schemaVersionId: item.schemaVersionId ?? null,
        payloadJson: payload,
        authoredBy: principal.userId,
        authoredViaAgent: decision.authoredViaAgent,
        reviewStatus,
        reviewedBy: provisional ? null : principal.userId,
        reviewedAt: provisional ? null : new Date(),
        supersedesId: latestGt?.id ?? null,
        notes: `Promoted from review item ${item.reviewId}`,
      })
      .returning({ id: schema.corpusEntryGroundTruth.id }),
  );
  if (!gt) return c.json({ error: "Failed to record ground truth" }, 500);

  // For a re-promoted (deduped) entry, refresh the denormalized GT too — but
  // only when approved, to preserve the provisional-excluded-from-validate rule.
  if (deduped && decision.writeDenormalizedGt) {
    await withRLS(db, tenantId, (tx) =>
      tx
        .update(schema.corpusEntries)
        .set({ groundTruthJson: payload, updatedAt: new Date() })
        .where(eq(schema.corpusEntries.id, corpusEntryId)),
    );
  }

  return c.json(
    {
      corpusEntryId,
      groundTruthId: gt.id,
      reviewStatus,
      provisional,
      deduped,
      filename: item.filename,
      fieldCount: Object.keys(payload).length,
    },
    201,
  );
});

/**
 * POST /api/review/:id/skip — no-op today.
 *
 * The dashboard tracks per-session skip state client-side so skipped items
 * don't re-appear until reload. A future deprioritization mechanism (e.g. a
 * skipped_at column) will make this server-side. The endpoint exists now so
 * the client contract is stable.
 */
review.post("/:id/skip", requires("review:act"), requireFeature("hitl_review"), async (c) => {
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
