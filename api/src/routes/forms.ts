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

/**
 * POST /api/forms/:slug/test — test coordinate extraction against an uploaded PDF.
 *
 * Accepts a PDF file, reads text at each mapped coordinate using the parse
 * service's text extraction, and returns extracted values.
 */
forms.post("/:slug/test", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  // Get the form mappings
  const [form] = await withRLS(db, tenantId, (tx) =>
    tx.select({ mappingsJson: formMappings.mappingsJson })
      .from(formMappings)
      .where(and(eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId)))
      .limit(1),
  );
  if (!form) return c.json({ error: "Form mapping not found" }, 404);

  const mappings = form.mappingsJson as Record<string, {
    page: number; x: number; y: number; w: number; h: number;
    value_type: string; sample_text: string;
  }>;

  if (!mappings || Object.keys(mappings).length === 0) {
    return c.json({ error: "No field mappings defined. Annotate the form first." }, 400);
  }

  // Get the uploaded test PDF
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "file is required (multipart form with 'file' field)" }, 400);
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  // Use the parse service to extract text at coordinates
  const parseUrl = c.get("parseUrl") as string | undefined;
  if (!parseUrl) {
    return c.json({ error: "Parse service URL not configured" }, 500);
  }

  // Build auth headers for Modal proxy (if applicable)
  const headers: Record<string, string> = {};
  const modalTokenId = process.env.MODAL_TOKEN_ID ?? process.env.MODAL_PROXY_KEY;
  const modalTokenSecret = process.env.MODAL_TOKEN_SECRET ?? process.env.MODAL_PROXY_SECRET;
  if (modalTokenId && modalTokenSecret) {
    headers["Modal-Key"] = modalTokenId;
    headers["Modal-Secret"] = modalTokenSecret;
  }

  try {
    const fd = new FormData();
    fd.append("file", new Blob([fileBuffer], { type: "application/pdf" }), file.name);
    fd.append("mappings", JSON.stringify(mappings));

    // Modal creates separate URLs per endpoint. Derive the extract-coordinates
    // URL from the parse URL by replacing the function name in the hostname.
    // e.g. trankly--koji-parse-parse-http.modal.run → trankly--koji-parse-extract-coordinates.modal.run
    let extractCoordinatesUrl: string;
    if (parseUrl.includes("modal.run")) {
      extractCoordinatesUrl = parseUrl.replace("parse-http", "extract-coordinates");
    } else {
      // Docker/local: same host, different path
      extractCoordinatesUrl = `${parseUrl}/extract-coordinates`;
    }

    const resp = await fetch(extractCoordinatesUrl, {
      method: "POST",
      body: fd,
      headers,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "Unknown error");
      return c.json({ error: `Coordinate extraction failed: ${err}` }, 502);
    }

    const result = await resp.json();
    return c.json({ data: result });
  } catch (err: any) {
    return c.json({ error: `Parse service unreachable: ${err?.message}` }, 502);
  }
});
