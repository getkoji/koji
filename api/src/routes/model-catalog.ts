import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId } from "../auth/middleware";
// No encryption needed here — credentials are passed inline for fetch
// and never stored by this route

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
 * POST /api/model-catalog/fetch — query a provider's API for available
 * models using inline credentials. The key is used for the fetch only
 * and is never stored. Returns the model list for the UI to present
 * as checkboxes — nothing is inserted until the user confirms via /bulk.
 */
modelCatalog.post("/fetch", requires("endpoint:write"), async (c) => {
  const body = await c.req.json<{
    provider: string;
    api_key?: string;
    base_url?: string;
  }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }

  const provider = body.provider;
  const apiKey = body.api_key ?? "";

  let models: Array<{ id: string; name: string; context?: number }> = [];

  try {
    if (provider === "openai" || provider === "azure-openai") {
      if (!apiKey) {
        return c.json({ error: "API key is required for OpenAI" }, 400);
      }
      const baseUrl = body.base_url ?? "https://api.openai.com/v1";
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
      if (!apiKey) {
        return c.json({ error: "API key is required for Anthropic" }, 400);
      }
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (!resp.ok) {
        return c.json({ error: `Anthropic returned ${resp.status}` }, 502);
      }
      const data = await resp.json() as { data: Array<{ id: string; display_name: string; type: string }> };
      models = (data.data ?? [])
        .filter((m) => m.type === "model")
        .map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
    } else if (provider === "ollama") {
      const baseUrl = body.base_url ?? "http://localhost:11434";
      const resp = await fetch(`${baseUrl}/api/tags`);
      if (!resp.ok) {
        return c.json({ error: `Ollama returned ${resp.status}` }, 502);
      }
      const data = await resp.json() as { models: Array<{ name: string }> };
      models = (data.models ?? []).map((m) => ({ id: m.name, name: m.name }));
    } else {
      return c.json({ error: `Automatic model fetching is not supported for "${provider}". Add models manually.` }, 400);
    }
  } catch (err: unknown) {
    return c.json({ error: `Failed to fetch: ${err instanceof Error ? err.message : "unknown error"}` }, 502);
  }

  return c.json({ data: models, provider });
});

/**
 * POST /api/model-catalog/bulk — add multiple models at once.
 * Used after fetching from a provider — the UI sends the selected models.
 */
modelCatalog.post("/bulk", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const body = await c.req.json<{
    provider: string;
    models: Array<{ id: string; name: string; context?: number }>;
  }>();

  if (!body.provider || !body.models?.length) {
    return c.json({ error: "provider and models are required" }, 400);
  }

  let added = 0;
  for (const m of body.models) {
    await withRLS(db, tenantId, (tx) =>
      tx
        .insert(schema.modelCatalog)
        .values({
          tenantId,
          provider: body.provider,
          modelId: m.id,
          displayName: m.name,
          contextWindow: m.context ?? null,
          source: "api",
        })
        .onConflictDoNothing()
    );
    added++;
  }

  return c.json({ ok: true, added });
});
