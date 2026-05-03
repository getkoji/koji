/**
 * Form mappings — coordinate-based field locations for fixed-layout PDFs.
 *
 * Each form mapping links to a schema and stores PDF coordinates where each
 * field appears. When a matching document comes in, fields are extracted by
 * reading text at those coordinates — no LLM, no parsing, sub-second.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../env";

const { formMappings, schemas: schemasTable } = schema;

function getTenantId(c: any): string { return c.get("tenantId"); }
function getPrincipal(c: any): { userId: string } { return c.get("principal"); }
function requires(perm: string) {
  return async (c: any, next: any) => {
    const grants = c.get("grants") as Set<string>;
    if (!grants?.has(perm)) return c.json({ error: `Missing permission: ${perm}` }, 403);
    await next();
  };
}

async function withRLS<T>(db: any, tenantId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  const { withRLS: rls } = await import("@koji/db");
  return rls(db, tenantId, fn);
}

export const forms = new Hono<Env>();

/**
 * GET /api/forms?schema=<schemaSlug> — list form mappings for a schema.
 */
forms.get("/", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const schemaSlug = c.req.query("schema");

  if (!schemaSlug) {
    return c.json({ error: "schema query param is required" }, 400);
  }

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schemasTable.id })
      .from(schemasTable)
      .where(eq(schemasTable.slug, schemaSlug))
      .limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: formMappings.id,
      slug: formMappings.slug,
      displayName: formMappings.displayName,
      description: formMappings.description,
      samplePageCount: formMappings.samplePageCount,
      mappingsJson: formMappings.mappingsJson,
      fingerprintJson: formMappings.fingerprintJson,
      version: formMappings.version,
      status: formMappings.status,
      createdAt: formMappings.createdAt,
    })
      .from(formMappings)
      .where(and(
        eq(formMappings.schemaId, s.id),
        eq(formMappings.tenantId, tenantId),
      ))
      .orderBy(desc(formMappings.createdAt)),
  );

  const data = rows.map((r) => ({
    ...r,
    fieldCount: r.mappingsJson && typeof r.mappingsJson === "object"
      ? Object.keys(r.mappingsJson as object).length
      : 0,
  }));

  return c.json({ data });
});

/**
 * POST /api/forms — create a new form mapping.
 */
forms.post("/", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const storage = c.get("storage");

  const body = await c.req.parseBody();
  const schemaSlug = body.schema_slug as string;
  const displayName = body.display_name as string;
  const slug = body.slug as string;
  const file = body.file;

  if (!schemaSlug || !displayName || !slug) {
    return c.json({ error: "schema_slug, display_name, and slug are required" }, 400);
  }

  const [s] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: schemasTable.id })
      .from(schemasTable)
      .where(eq(schemasTable.slug, schemaSlug))
      .limit(1),
  );
  if (!s) return c.json({ error: "Schema not found" }, 404);

  let sampleStorageKey: string | null = null;
  let samplePageCount: number | null = null;

  if (file instanceof File) {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    sampleStorageKey = `forms/${tenantId}/${s.id}/${Date.now()}-${file.name}`;
    await storage.put(sampleStorageKey, fileBuffer, {
      contentType: file.type || "application/pdf",
    });
    // TODO: extract page count from PDF
  }

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.insert(formMappings).values({
      tenantId,
      schemaId: s.id,
      slug,
      displayName,
      sampleStorageKey,
      samplePageCount,
      createdBy: principal.userId,
    }).returning(),
  );

  return c.json(row, 201);
});

/**
 * GET /api/forms/:slug — get form mapping detail.
 */
forms.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.select()
      .from(formMappings)
      .where(and(
        eq(formMappings.slug, slug),
        eq(formMappings.tenantId, tenantId),
      ))
      .limit(1),
  );

  if (!row) return c.json({ error: "Form mapping not found" }, 404);
  return c.json(row);
});

/**
 * PATCH /api/forms/:slug — update mappings, name, status.
 */
forms.patch("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req.json<{
    display_name?: string;
    description?: string;
    mappings_json?: Record<string, unknown>;
    fingerprint_json?: Record<string, unknown>;
    status?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.mappings_json) {
    updates.mappingsJson = body.mappings_json;
    // Bump version when mappings change
    updates.version = schema.formMappings.version; // Will be incremented below
  }
  if (body.fingerprint_json) updates.fingerprintJson = body.fingerprint_json;
  if (body.status) updates.status = body.status;

  // Fetch current version to bump
  const [current] = await withRLS(db, tenantId, (tx) =>
    tx.select({ id: formMappings.id, version: formMappings.version })
      .from(formMappings)
      .where(and(eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId)))
      .limit(1),
  );
  if (!current) return c.json({ error: "Form mapping not found" }, 404);

  if (body.mappings_json) {
    updates.version = current.version + 1;
  }

  const [updated] = await withRLS(db, tenantId, (tx) =>
    tx.update(formMappings)
      .set(updates)
      .where(eq(formMappings.id, current.id))
      .returning(),
  );

  return c.json(updated);
});

/**
 * DELETE /api/forms/:slug — soft delete.
 */
forms.delete("/:slug", requires("schema:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  await withRLS(db, tenantId, (tx) =>
    tx.update(formMappings)
      .set({ deletedAt: new Date() })
      .where(and(eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId))),
  );

  return c.json({ ok: true });
});

/**
 * GET /api/forms/:slug/sample-url — get signed URL for the sample PDF.
 */
forms.get("/:slug/sample-url", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const storage = c.get("storage");
  const slug = c.req.param("slug")!;

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.select({ sampleStorageKey: formMappings.sampleStorageKey })
      .from(formMappings)
      .where(and(eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId)))
      .limit(1),
  );

  if (!row?.sampleStorageKey) return c.json({ error: "No sample PDF" }, 404);

  const url = await storage.getSignedUrl(row.sampleStorageKey, 3600);
  return c.json({ url });
});
