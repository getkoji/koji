import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getProjectId } from "../auth/middleware";
import { decrypt } from "../crypto/envelope";

/**
 * Routes for the credential→model split. Exposes the credentials a tenant
 * has configured and the models hosted under each. Pairs with the existing
 * /api/model-providers route (which still owns the create-credential flow
 * + provider-specific validation) to deliver the new "one key, many
 * models" surface in the dashboard.
 *
 * The dashboard's "Add credential" flow stays on POST /api/model-providers
 * (which dual-writes credential + first model). These routes add:
 *   - GET /api/credentials              — list credentials, each with its models
 *   - POST /api/credentials/:id/models  — attach an additional model
 *   - PATCH /api/credentials/:id/models/:modelId
 *   - DELETE /api/credentials/:id/models/:modelId
 *
 * Capability values are constrained at write time. Adding a new value
 * requires the picker UIs to opt in (chat is the safe default).
 */

const CAPABILITIES = new Set(["chat", "vision", "ocr"]);

export const credentials = new Hono<Env>();

/**
 * GET /api/credentials — list credentials with nested models.
 *
 * Returns one entry per provider_credentials row, with `models` populated
 * from tenant_models. Soft-deleted rows are filtered out.
 *
 * `hasKey` / `credentialStatus` mirror what GET /api/model-providers reports.
 * This is the list the settings page renders, and without them a credential
 * holding no key at all — or one encrypted under a rotated master key — drew
 * exactly like a working one, so "it's right there in the list" and "the
 * engine can use it" could quietly disagree.
 */
credentials.get("/", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const credRows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.providerCredentials.id,
        slug: schema.providerCredentials.slug,
        displayName: schema.providerCredentials.displayName,
        provider: schema.providerCredentials.provider,
        configJson: schema.providerCredentials.configJson,
        authJson: schema.providerCredentials.authJson,
        status: schema.providerCredentials.status,
        healthState: schema.providerCredentials.healthState,
        lastHealthCheckAt: schema.providerCredentials.lastHealthCheckAt,
        createdAt: schema.providerCredentials.createdAt,
      })
      .from(schema.providerCredentials)
      .where(sql`${schema.providerCredentials.deletedAt} IS NULL`),
  );

  const modelRows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.tenantModels.id,
        credentialId: schema.tenantModels.credentialId,
        model: schema.tenantModels.model,
        capability: schema.tenantModels.capability,
        displayName: schema.tenantModels.displayName,
        status: schema.tenantModels.status,
        createdAt: schema.tenantModels.createdAt,
      })
      .from(schema.tenantModels)
      .where(sql`${schema.tenantModels.deletedAt} IS NULL`),
  );

  const modelsByCred = new Map<string, typeof modelRows>();
  for (const m of modelRows) {
    const list = modelsByCred.get(m.credentialId) ?? [];
    list.push(m);
    modelsByCred.set(m.credentialId, list);
  }

  const masterKey = c.get("masterKey") as string | null;

  return c.json({
    data: credRows.map((cred) => {
      const auth =
        (cred.authJson as {
          key_hint?: string | null;
          key_blob?: string;
          aws_secret_access_key_blob?: string;
        } | null) ?? null;
      const cfg = (cred.configJson as Record<string, unknown> | null) ?? {};

      // Same probe as GET /api/model-providers: a stored blob that no longer
      // decrypts (rotated master key, corrupt ciphertext) is reported as
      // `invalid` rather than passing for configured.
      const hasKey = !!(auth?.key_blob || auth?.aws_secret_access_key_blob);
      let credentialStatus: "ok" | "invalid" | "none" | "no_master_key" = "none";
      if (hasKey && !masterKey) {
        credentialStatus = "no_master_key";
      } else if (hasKey && masterKey) {
        try {
          decrypt(auth!.key_blob ?? auth!.aws_secret_access_key_blob!, masterKey, tenantId);
          credentialStatus = "ok";
        } catch {
          credentialStatus = "invalid";
        }
      }

      return {
        id: cred.id,
        slug: cred.slug,
        displayName: cred.displayName,
        provider: cred.provider,
        baseUrl: (cfg.base_url as string | undefined) ?? null,
        deploymentName: (cfg.deployment_name as string | undefined) ?? null,
        apiVersion: (cfg.api_version as string | undefined) ?? null,
        awsRegion: (cfg.aws_region as string | undefined) ?? null,
        keyHint: auth?.key_hint ?? null,
        hasKey,
        credentialStatus,
        status: cred.status,
        healthState: cred.healthState,
        lastHealthCheckAt: cred.lastHealthCheckAt,
        createdAt: cred.createdAt,
        models: (modelsByCred.get(cred.id) ?? []).map((m) => ({
          id: m.id,
          model: m.model,
          capability: m.capability,
          displayName: m.displayName,
          status: m.status,
          createdAt: m.createdAt,
        })),
      };
    }),
  });
});

/**
 * POST /api/credentials/:credentialId/models — attach a model (or models)
 * to an existing credential. The credential must already exist (created
 * via POST /api/model-providers).
 *
 * Body: {
 *   model: string,
 *   capabilities?: ("chat"|"vision"|"ocr")[],   // one row per capability
 *   capability?: "chat"|"vision"|"ocr",         // legacy single-value form
 *   label?: string
 * }
 *
 * `capabilities` is preferred. A model that supports both chat and vision
 * creates two rows so the picker UIs can capability-filter without
 * per-tenant judgment ("is this model in the vision pool? yes / no").
 * Already-existing (model, capability) pairs are skipped via
 * `ON CONFLICT DO NOTHING` — sending the same payload twice is idempotent.
 */
credentials.post("/:credentialId/models", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const credentialId = c.req.param("credentialId")!;

  const body = await c.req.json<{
    model?: string;
    capability?: string;
    capabilities?: string[];
    label?: string;
  }>();

  if (!body.model || typeof body.model !== "string" || !body.model.trim()) {
    return c.json({ error: "model is required" }, 400);
  }

  const requested = Array.isArray(body.capabilities) && body.capabilities.length > 0
    ? body.capabilities
    : [body.capability ?? "chat"];
  const caps = Array.from(new Set(requested.map((c) => String(c).toLowerCase())));
  for (const cap of caps) {
    if (!CAPABILITIES.has(cap)) {
      return c.json(
        { error: `capability must be one of: ${[...CAPABILITIES].join(", ")}` },
        400,
      );
    }
  }

  // Confirm the credential exists for this tenant before inserting.
  const [cred] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.providerCredentials.id })
      .from(schema.providerCredentials)
      .where(
        and(
          eq(schema.providerCredentials.id, credentialId),
          sql`${schema.providerCredentials.deletedAt} IS NULL`,
        ),
      )
      .limit(1),
  );
  if (!cred) return c.json({ error: "Credential not found" }, 404);

  const modelName = body.model.trim();
  const label = body.label?.trim() || modelName;

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.tenantModels)
      .values(
        caps.map((capability) => ({
          tenantId,
          credentialId,
          model: modelName,
          capability,
          displayName: label,
        })),
      )
      .onConflictDoNothing()
      .returning({
        id: schema.tenantModels.id,
        model: schema.tenantModels.model,
        capability: schema.tenantModels.capability,
        displayName: schema.tenantModels.displayName,
        status: schema.tenantModels.status,
        createdAt: schema.tenantModels.createdAt,
      }),
  );

  return c.json({ data: rows }, 201);
});

/**
 * PATCH /api/credentials/:credentialId/models/:modelId — update a model's
 * label, capability, or active status. The model name itself is treated
 * as the natural key and is not patchable (delete + re-add to swap).
 */
credentials.patch("/:credentialId/models/:modelId", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const credentialId = c.req.param("credentialId")!;
  const modelId = c.req.param("modelId")!;

  const body = await c.req.json<{
    capability?: string;
    label?: string;
    status?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.capability !== undefined) {
    const cap = body.capability.toLowerCase();
    if (!CAPABILITIES.has(cap)) {
      return c.json(
        { error: `capability must be one of: ${[...CAPABILITIES].join(", ")}` },
        400,
      );
    }
    updates.capability = cap;
  }
  if (body.label !== undefined) updates.displayName = body.label.trim() || null;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      return c.json({ error: "status must be 'active' or 'disabled'" }, 400);
    }
    updates.status = body.status;
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.tenantModels)
      .set(updates)
      .where(
        and(
          eq(schema.tenantModels.id, modelId),
          eq(schema.tenantModels.credentialId, credentialId),
          sql`${schema.tenantModels.deletedAt} IS NULL`,
        ),
      )
      .returning({
        id: schema.tenantModels.id,
        model: schema.tenantModels.model,
        capability: schema.tenantModels.capability,
        displayName: schema.tenantModels.displayName,
        status: schema.tenantModels.status,
      }),
  );

  if (rows.length === 0) return c.json({ error: "Model not found" }, 404);
  return c.json(rows[0]);
});

/**
 * DELETE /api/credentials/:credentialId/models/:modelId — soft-delete a
 * model. The legacy model_endpoints row with the same id is also
 * soft-deleted so the /api/model-providers list view stays in sync.
 */
credentials.delete("/:credentialId/models/:modelId", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const credentialId = c.req.param("credentialId")!;
  const modelId = c.req.param("modelId")!;
  const now = new Date();

  const result = await withRLS(db, { tenantId, projectId: getProjectId(c) }, async (tx) => {
    const rows = await tx
      .update(schema.tenantModels)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.tenantModels.id, modelId),
          eq(schema.tenantModels.credentialId, credentialId),
          sql`${schema.tenantModels.deletedAt} IS NULL`,
        ),
      )
      .returning({ id: schema.tenantModels.id });
    if (rows.length === 0) return null;

    // tenant_models.id == model_endpoints.id for any row that originated
    // from the legacy table (backfill + every dual-writing INSERT). Mirror
    // the soft-delete so the old list view doesn't keep showing it.
    await tx
      .update(schema.modelEndpoints)
      .set({ deletedAt: now })
      .where(eq(schema.modelEndpoints.id, modelId));
    return rows[0];
  });

  if (!result) return c.json({ error: "Model not found" }, 404);
  return c.body(null, 204);
});
