import { Hono } from "hono";
import { eq, and, sql, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { encrypt, decrypt, getMasterKey, keyHint } from "../crypto/envelope";

function requireMasterKey(): string {
  const key = getMasterKey();
  if (!key) {
    throw new Error("KOJI_MASTER_KEY is not set. Cannot encrypt model provider credentials.");
  }
  return key;
}

export const modelProviders = new Hono<Env>();

/**
 * GET /api/model-providers — list active model endpoints.
 * Never returns decrypted credentials.
 */
modelProviders.get("/", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.modelEndpoints.id,
        slug: schema.modelEndpoints.slug,
        displayName: schema.modelEndpoints.displayName,
        provider: schema.modelEndpoints.provider,
        model: schema.modelEndpoints.model,
        configJson: schema.modelEndpoints.configJson,
        authJson: schema.modelEndpoints.authJson,
        status: schema.modelEndpoints.status,
        lastHealthCheckAt: schema.modelEndpoints.lastHealthCheckAt,
        createdAt: schema.modelEndpoints.createdAt,
      })
      .from(schema.modelEndpoints)
      .where(sql`deleted_at IS NULL`)
  );

  return c.json({
    data: rows.map((r) => {
      const auth = r.authJson as { key_hint?: string } | null;
      return {
        id: r.id,
        slug: r.slug,
        displayName: r.displayName,
        provider: r.provider,
        model: r.model,
        baseUrl: (r.configJson as { base_url?: string })?.base_url ?? null,
        keyHint: auth?.key_hint ?? null,
        hasKey: !!auth?.key_hint,
        status: r.status,
        lastHealthCheckAt: r.lastHealthCheckAt,
        createdAt: r.createdAt,
      };
    }),
  });
});

/**
 * POST /api/model-providers — create a new model endpoint.
 * Encrypts credentials immediately; never echoes them back.
 */
modelProviders.post("/", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const masterKey = requireMasterKey();

  const body = await c.req.json<{
    name: string;
    slug: string;
    provider: string;
    model: string;
    base_url?: string;
    credentials?: string | Record<string, string>;
  }>();

  if (!body.name || !body.slug || !body.provider || !body.model) {
    return c.json({ error: "name, slug, provider, and model are required" }, 400);
  }

  const configJson: Record<string, unknown> = {};
  if (body.base_url) configJson.base_url = body.base_url;

  let authJson: Record<string, string> | null = null;
  if (body.credentials) {
    const credStr = typeof body.credentials === "string"
      ? body.credentials
      : JSON.stringify(body.credentials);
    const hint = typeof body.credentials === "string"
      ? keyHint(body.credentials)
      : keyHint(JSON.stringify(body.credentials));

    authJson = {
      encrypted_key: encrypt(credStr, masterKey, tenantId),
      key_hint: hint,
    };
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.modelEndpoints)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.name,
        provider: body.provider,
        model: body.model,
        configJson,
        authJson,
        createdBy: principal.userId,
      })
      .returning({
        id: schema.modelEndpoints.id,
        slug: schema.modelEndpoints.slug,
        displayName: schema.modelEndpoints.displayName,
        provider: schema.modelEndpoints.provider,
        model: schema.modelEndpoints.model,
        status: schema.modelEndpoints.status,
        createdAt: schema.modelEndpoints.createdAt,
      })
  );

  const row = rows[0]!;
  return c.json({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    provider: row.provider,
    model: row.model,
    keyHint: authJson?.key_hint ?? null,
    hasKey: !!authJson,
    status: row.status,
    createdAt: row.createdAt,
  }, 201);
});

/**
 * PATCH /api/model-providers/:id — update an endpoint.
 * If credentials provided, re-encrypts. Otherwise preserves existing.
 */
modelProviders.patch("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey();

  const body = await c.req.json<{
    name?: string;
    model?: string;
    base_url?: string;
    credentials?: string | Record<string, string>;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.model) updates.model = body.model;

  // Update base_url in configJson if provided
  if (body.base_url !== undefined) {
    const [existing] = await withRLS(db, tenantId, (tx) =>
      tx.select({ configJson: schema.modelEndpoints.configJson })
        .from(schema.modelEndpoints)
        .where(eq(schema.modelEndpoints.id, endpointId))
        .limit(1)
    );
    const config = (existing?.configJson as Record<string, unknown>) ?? {};
    config.base_url = body.base_url;
    updates.configJson = config;
  }

  // Re-encrypt credentials if provided
  if (body.credentials) {
    const credStr = typeof body.credentials === "string"
      ? body.credentials
      : JSON.stringify(body.credentials);
    const hint = typeof body.credentials === "string"
      ? keyHint(body.credentials)
      : keyHint(JSON.stringify(body.credentials));

    updates.authJson = {
      encrypted_key: encrypt(credStr, masterKey, tenantId),
      key_hint: hint,
    };
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.modelEndpoints)
      .set(updates)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .returning({
        id: schema.modelEndpoints.id,
        slug: schema.modelEndpoints.slug,
        displayName: schema.modelEndpoints.displayName,
        provider: schema.modelEndpoints.provider,
        model: schema.modelEndpoints.model,
        status: schema.modelEndpoints.status,
      })
  );

  if (rows.length === 0) {
    return c.json({ error: "Model provider not found" }, 404);
  }

  return c.json(rows[0]);
});

/**
 * DELETE /api/model-providers/:id — soft-delete an endpoint.
 */
modelProviders.delete("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.modelEndpoints)
      .set({ deletedAt: new Date() })
      .where(eq(schema.modelEndpoints.id, endpointId))
  );

  return c.body(null, 204);
});

/**
 * POST /api/model-providers/:id/rotate — rotate credentials.
 * Accepts new plaintext credentials, encrypts and replaces.
 */
modelProviders.post("/:id/rotate", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey();

  const body = await c.req.json<{
    credentials: string | Record<string, string>;
  }>();

  if (!body.credentials) {
    return c.json({ error: "credentials are required" }, 400);
  }

  const credStr = typeof body.credentials === "string"
    ? body.credentials
    : JSON.stringify(body.credentials);
  const hint = typeof body.credentials === "string"
    ? keyHint(body.credentials)
    : keyHint(JSON.stringify(body.credentials));

  const authJson = {
    encrypted_key: encrypt(credStr, masterKey, tenantId),
    key_hint: hint,
  };

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.modelEndpoints)
      .set({ authJson, updatedAt: new Date() })
      .where(eq(schema.modelEndpoints.id, endpointId))
      .returning({ id: schema.modelEndpoints.id })
  );

  if (rows.length === 0) {
    return c.json({ error: "Model provider not found" }, 404);
  }

  return c.json({ ok: true, keyHint: hint });
});

/**
 * POST /api/model-providers/:id/fetch-models — fetch available models
 * from this provider using its stored (encrypted) credentials.
 *
 * Returns the list of models found. Does NOT auto-add to catalog —
 * the client sends the selected models to POST /api/model-catalog/bulk.
 */
modelProviders.post("/:id/fetch-models", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey();

  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        provider: schema.modelEndpoints.provider,
        authJson: schema.modelEndpoints.authJson,
        configJson: schema.modelEndpoints.configJson,
      })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1)
  );

  if (!endpoint) {
    return c.json({ error: "Provider not found" }, 404);
  }

  const auth = endpoint.authJson as { encrypted_key?: string } | null;
  if (!auth?.encrypted_key) {
    return c.json({ error: "Provider has no credentials configured" }, 400);
  }

  const credStr = decrypt(auth.encrypted_key, masterKey, tenantId);
  let apiKey: string;
  try {
    const parsed = JSON.parse(credStr);
    apiKey = parsed.api_key ?? parsed.apiKey ?? credStr;
  } catch {
    apiKey = credStr;
  }

  const config = endpoint.configJson as { base_url?: string } | null;
  const provider = endpoint.provider;

  let models: Array<{ id: string; name: string; context?: number }> = [];

  try {
    if (provider === "openai" || provider === "azure-openai") {
      const baseUrl = config?.base_url ?? "https://api.openai.com/v1";
      const resp = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        return c.json({ error: `Provider returned ${resp.status}` }, 502);
      }
      const data = await resp.json() as { data: Array<{ id: string }> };
      models = data.data
        .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o") || m.id.includes("embed"))
        .map((m) => ({ id: m.id, name: m.id }));
    } else if (provider === "anthropic") {
      models = [
        { id: "claude-opus-4-20250514", name: "Claude Opus 4", context: 200000 },
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", context: 200000 },
        { id: "claude-haiku-4-20250514", name: "Claude Haiku 4", context: 200000 },
      ];
    } else if (provider === "ollama") {
      const baseUrl = config?.base_url ?? "http://localhost:11434";
      const resp = await fetch(`${baseUrl}/api/tags`);
      if (!resp.ok) {
        return c.json({ error: `Ollama returned ${resp.status}` }, 502);
      }
      const data = await resp.json() as { models: Array<{ name: string }> };
      models = (data.models ?? []).map((m) => ({ id: m.name, name: m.name }));
    } else {
      return c.json({ error: `Automatic model fetching is not supported for "${provider}". Add models manually in the catalog.` }, 400);
    }
  } catch (err: unknown) {
    return c.json({ error: `Failed to fetch: ${err instanceof Error ? err.message : "unknown error"}` }, 502);
  }

  return c.json({ data: models, provider });
});
