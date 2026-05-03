/**
 * Form mappings — coordinate-based field locations for fixed-layout PDFs.
 *
 * Each form mapping links to a schema and stores PDF coordinates where each
 * field appears. When a matching document comes in, fields are extracted by
 * reading text at those coordinates — no LLM, no parsing, sub-second.
 */

import { Hono } from "hono";
import { eq, and, desc, isNull } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { formExtractToResult, fieldsNeedingLlm } from "../extract/form-extract";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { generateFingerprint } from "../extract/form-match";
import { resolveExtractEndpoint } from "../extract/resolve-endpoint";

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

/** Resolve schema ID from the ?schema= query param. Required on all endpoints. */
async function resolveSchemaId(c: any, db: any, tenantId: string): Promise<string | null> {
  const schemaSlug = c.req.query("schema");
  if (!schemaSlug) return null;
  const [s] = await withRLS(db, tenantId, (tx: any) =>
    tx.select({ id: schemasTable.id })
      .from(schemasTable)
      .where(eq(schemasTable.slug, schemaSlug))
      .limit(1),
  );
  return s?.id ?? null;
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
        isNull(formMappings.deletedAt),
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
 * GET /api/forms/:slug?schema=<schemaSlug> — get form mapping detail.
 */
forms.get("/:slug", requires("schema:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const schemaId = await resolveSchemaId(c, db, tenantId);

  const conditions = [
    eq(formMappings.slug, slug),
    eq(formMappings.tenantId, tenantId),
    isNull(formMappings.deletedAt),
  ];
  if (schemaId) conditions.push(eq(formMappings.schemaId, schemaId));

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.select()
      .from(formMappings)
      .where(and(...conditions))
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
  const schemaId = await resolveSchemaId(c, db, tenantId);
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
    updates.version = schema.formMappings.version;
  }
  if (body.fingerprint_json) updates.fingerprintJson = body.fingerprint_json;
  if (body.status) updates.status = body.status;

  const conditions: any[] = [eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId), isNull(formMappings.deletedAt)];
  if (schemaId) conditions.push(eq(formMappings.schemaId, schemaId));

  const [current] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      id: formMappings.id,
      version: formMappings.version,
      sampleStorageKey: formMappings.sampleStorageKey,
    })
      .from(formMappings)
      .where(and(...conditions))
      .limit(1),
  );
  if (!current) return c.json({ error: "Form mapping not found" }, 404);

  if (body.mappings_json) {
    updates.version = current.version + 1;
  }

  // Auto-generate fingerprint when activating a form mapping
  if (body.status === "active" && current.sampleStorageKey) {
    try {
      const storage = c.get("storage");
      const parseProvider = c.get("parseProvider") as any;
      if (parseProvider?.extractCoordinates) {
        // Use coordinate extraction to get page 1 text (just a small region)
        // Actually simpler: fetch the PDF and use the parse provider to get text
        const blob = await storage.getBuffer(current.sampleStorageKey);
        if (blob) {
          const parseResult = await parseProvider.parse({
            filename: "sample.pdf",
            mimeType: "application/pdf",
            fileBuffer: blob.data,
          });
          const fingerprint = generateFingerprint(parseResult.markdown.slice(0, 3000));
          updates.fingerprintJson = fingerprint;
          console.log(`[forms] generated fingerprint for ${slug}: ${fingerprint.keywords.length} keywords`);
        }
      }
    } catch (err) {
      console.warn(`[forms] fingerprint generation failed for ${slug}:`, err);
      // Non-fatal — the form mapping still activates
    }
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
  const schemaId = await resolveSchemaId(c, db, tenantId);

  const conditions: any[] = [eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId)];
  if (schemaId) conditions.push(eq(formMappings.schemaId, schemaId));

  await withRLS(db, tenantId, (tx) =>
    tx.delete(formMappings).where(and(...conditions)),
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
  const schemaId = await resolveSchemaId(c, db, tenantId);

  const conditions: any[] = [eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId), isNull(formMappings.deletedAt)];
  if (schemaId) conditions.push(eq(formMappings.schemaId, schemaId));

  const [row] = await withRLS(db, tenantId, (tx) =>
    tx.select({ sampleStorageKey: formMappings.sampleStorageKey })
      .from(formMappings)
      .where(and(...conditions))
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
  const schemaId = await resolveSchemaId(c, db, tenantId);

  const conditions: any[] = [eq(formMappings.slug, slug), eq(formMappings.tenantId, tenantId), isNull(formMappings.deletedAt)];
  if (schemaId) conditions.push(eq(formMappings.schemaId, schemaId));

  const [form] = await withRLS(db, tenantId, (tx) =>
    tx.select({ mappingsJson: formMappings.mappingsJson })
      .from(formMappings)
      .where(and(...conditions))
      .limit(1),
  );
  if (!form) return c.json({ error: "Form mapping not found" }, 404);

  const mappings = form.mappingsJson as Record<string, {
    page: number; x: number; y: number; w: number; h: number;
    mapping_type?: string; value_type: string; sample_text: string;
    llm_prompt?: string; target_fields?: string[];
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

  // Use the parse provider's extractCoordinates method (handles auth for Modal/Docker)
  const parseProvider = c.get("parseProvider") as any;
  if (!parseProvider?.extractCoordinates) {
    return c.json({ error: "Parse provider does not support coordinate extraction" }, 500);
  }

  // Also fetch the schema definition for normalization/validation
  const [schemaRow] = schemaId ? await withRLS(db, tenantId, (tx) =>
    tx.select({
      draftYaml: schemasTable.draftYaml,
    }).from(schemasTable)
      .where(eq(schemasTable.id, schemaId))
      .limit(1),
  ) : [null];

  try {
    const coordResult = await parseProvider.extractCoordinates({
      fileBuffer,
      mappings,
    });

    if (coordResult.warning) {
      return c.json({ data: coordResult });
    }

    // Handle llm_interpret regions — read text at coordinates, then ask LLM
    // to parse it into the target schema fields.
    // LLM regions use synthetic keys (__llm_*) so they don't collide with
    // direct field mappings.
    const llmRegions = Object.entries(mappings).filter(([, m]) => m.mapping_type === "llm_interpret");
    const llmDebug: Record<string, unknown> = {};
    if (llmRegions.length > 0) {
      const { provider } = await resolveTenantProvider(db, tenantId);

      // Parse schema YAML to get field descriptions for the prompt
      let schemaFields: Record<string, { type?: string; extraction_guidance?: string; required?: boolean }> = {};
      if (schemaRow?.draftYaml) {
        try {
          const { parse: parseYaml } = await import("yaml");
          const parsed = parseYaml(schemaRow.draftYaml);
          schemaFields = (parsed?.fields ?? {}) as typeof schemaFields;
        } catch { /* ignore parse errors */ }
      }

      for (const [regionKey, mapping] of llmRegions) {
        const rawText = coordResult.extracted[regionKey]?.value;
        if (!rawText) continue;

        const targetFields = mapping.target_fields ?? [];
        if (targetFields.length === 0) continue;

        const userPrompt = mapping.llm_prompt?.trim() || "";

        // Build field descriptions so the LLM knows what each field means
        const fieldDescriptions = targetFields.map((f) => {
          const spec = schemaFields[f];
          const parts = [`  "${f}"`];
          if (spec?.type) parts.push(`(type: ${spec.type})`);
          if (spec?.extraction_guidance) parts.push(`— ${spec.extraction_guidance}`);
          if (spec?.required) parts.push("[required]");
          return parts.join(" ");
        }).join("\n");

        const prompt = `You are extracting structured data from a region of a PDF form.

The raw text from this region:
"""
${rawText}
"""

Extract values for these fields:
${fieldDescriptions}

${userPrompt ? `Additional instructions: ${userPrompt}\n` : ""}Return a JSON object with exactly these keys: ${JSON.stringify(targetFields)}
Each value should be a string, number, or null if not found. Return ONLY valid JSON, no explanation.`;

        try {
          const llmResponse = await provider.generate(prompt, true);
          console.log(`[forms/test] LLM region ${regionKey} raw response:`, llmResponse);
          const parsed = JSON.parse(llmResponse);

          // Write LLM results into coordResult under the target field names
          for (const tf of targetFields) {
            if (parsed[tf] !== undefined) {
              coordResult.extracted[tf] = {
                value: parsed[tf],
                page: coordResult.extracted[regionKey]?.page,
              };
            } else {
              console.log(`[forms/test] LLM did not return field "${tf}" — keys returned: ${Object.keys(parsed).join(", ")}`);
            }
          }
        } catch (err) {
          console.error(`[forms/test] LLM interpret failed for region ${regionKey}:`, err);
          // LLM call failed — write error on each target field
          for (const tf of targetFields) {
            coordResult.extracted[tf] = {
              value: null,
              error: `LLM interpretation failed: ${(err as Error)?.message ?? "unknown"}`,
            };
          }
        }

        // Always remove the synthetic region key from results
        delete coordResult.extracted[regionKey];
      }
    }

    // If we have a schema, run through the normalize → validate pipeline
    if (schemaRow?.draftYaml) {
      try {
        const { parse: parseYaml } = await import("yaml");
        const schemaDef = parseYaml(schemaRow.draftYaml);
        const extractionResult = formExtractToResult(coordResult.extracted, schemaDef);
        const needsLlm = fieldsNeedingLlm(extractionResult, schemaDef);

        return c.json({
          data: {
            ...extractionResult,
            coordinate_results: coordResult.extracted,
            needs_llm: needsLlm,
            has_text_layer: coordResult.has_text_layer,
          },
        });
      } catch {
        // Schema parse failed — return raw coordinate results
      }
    }

    return c.json({ data: coordResult });
  } catch (err: any) {
    return c.json({ error: `Coordinate extraction failed: ${err?.message}` }, 502);
  }
});
