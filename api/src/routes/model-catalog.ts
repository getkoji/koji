import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";
import { decrypt, getMasterKey } from "../crypto/envelope";

export const modelCatalog = new Hono<Env>();

/**
 * GET /api/model-catalog — list all models in the catalog.
 * Optional ?provider= filter.
 */
modelCatalog.get("/", requires("endpoint:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const providerFilter = c.req.query("provider");

  const rows = await withRLS(db, tenantId, (tx) => {
    let q = tx
      .select({
        id: schema.modelCatalog.id,
        provider: schema.modelCatalog.provider,
        modelId: schema.modelCatalog.modelId,
        displayName: schema.modelCatalog.displayName,
        contextWindow: schema.modelCatalog.contextWindow,
        supportsVision: schema.modelCatalog.supportsVision,
        source: schema.modelCatalog.source,
        createdAt: schema.modelCatalog.createdAt,
      })
      .from(schema.modelCatalog)
      .orderBy(schema.modelCatalog.provider, schema.modelCatalog.displayName);

    if (providerFilter) {
      q = q.where(eq(schema.modelCatalog.provider, providerFilter)) as typeof q;
    }

    return q;
  });

  return c.json({ data: rows });
});

/**
 * POST /api/model-catalog — add a model to the catalog manually.
 */
modelCatalog.post("/", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const body = await c.req.json<{
    provider: string;
    model_id: string;
    display_name: string;
    context_window?: number;
    supports_vision?: boolean;
  }>();

  if (!body.provider || !body.model_id || !body.display_name) {
    return c.json({ error: "provider, model_id, and display_name are required" }, 400);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .insert(schema.modelCatalog)
      .values({
        tenantId,
        provider: body.provider,
        modelId: body.model_id,
        displayName: body.display_name,
        contextWindow: body.context_window ?? null,
        supportsVision: body.supports_vision ? "true" : "false",
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [schema.modelCatalog.tenantId, schema.modelCatalog.provider, schema.modelCatalog.modelId],
        set: {
          displayName: body.display_name,
          contextWindow: body.context_window ?? null,
          supportsVision: body.supports_vision ? "true" : "false",
        },
      })
      .returning()
  );

  return c.json(rows[0], 201);
});

/**
 * DELETE /api/model-catalog/:id — remove a model from the catalog.
 */
modelCatalog.delete("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const modelId = c.req.param("id")!;

  await withRLS(db, tenantId, (tx) =>
    tx.delete(schema.modelCatalog).where(eq(schema.modelCatalog.id, modelId))
  );

  return c.body(null, 204);
});

/**
 * POST /api/model-catalog/fetch — fetch available models from a
 * provider's API using stored credentials from a model endpoint.
 *
 * Currently supports OpenAI and Anthropic.
 */
modelCatalog.post("/fetch", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const body = await c.req.json<{ endpoint_id: string }>();
  if (!body.endpoint_id) {
    return c.json({ error: "endpoint_id is required" }, 400);
  }

  // Load the endpoint to get credentials
  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        provider: schema.modelEndpoints.provider,
        authJson: schema.modelEndpoints.authJson,
        configJson: schema.modelEndpoints.configJson,
      })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, body.endpoint_id))
      .limit(1)
  );

  if (!endpoint) {
    return c.json({ error: "Endpoint not found" }, 404);
  }

  const auth = endpoint.authJson as { encrypted_key?: string } | null;
  if (!auth?.encrypted_key) {
    return c.json({ error: "Endpoint has no credentials configured" }, 400);
  }

  const masterKey = getMasterKey();
  if (!masterKey) {
    return c.json({ error: "KOJI_MASTER_KEY is not set" }, 500);
  }

  const credStr = decrypt(auth.encrypted_key, masterKey, tenantId);
  // Credentials can be a plain string (API key) or JSON object
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
        return c.json({ error: `Provider returned ${resp.status}: ${await resp.text()}` }, 502);
      }
      const data = await resp.json() as { data: Array<{ id: string }> };
      models = data.data
        .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o") || m.id.includes("embed"))
        .map((m) => ({ id: m.id, name: m.id }));
    } else if (provider === "anthropic") {
      // Anthropic doesn't have a /models endpoint — use known models
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
      return c.json({ error: `Automatic model fetching is not supported for provider "${provider}". Add models manually.` }, 400);
    }
  } catch (err: unknown) {
    return c.json({ error: `Failed to fetch models: ${err instanceof Error ? err.message : "unknown error"}` }, 502);
  }

  // Upsert into catalog
  let added = 0;
  for (const m of models) {
    await withRLS(db, tenantId, (tx) =>
      tx
        .insert(schema.modelCatalog)
        .values({
          tenantId,
          provider,
          modelId: m.id,
          displayName: m.name,
          contextWindow: m.context ?? null,
          source: "api",
        })
        .onConflictDoNothing()
    );
    added++;
  }

  return c.json({ ok: true, fetched: models.length, provider });
});
