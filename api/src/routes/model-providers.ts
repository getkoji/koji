import type { Context } from "hono";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";

function requireMasterKey(c: Context<Env>): string {
  const key = c.get("masterKey");
  if (!key) {
    throw new Error("KOJI_MASTER_KEY is not set. Cannot encrypt model provider credentials.");
  }
  return key;
}

export const modelProviders = new Hono<Env>();

/**
 * Shape of the configJson column for a model endpoint.
 * All fields are plaintext — the non-secret parts of the provider config.
 * The exact subset used depends on the provider (see field matrix in the
 * settings page / tests / docs).
 */
type ConfigJson = {
  base_url?: string;
  // Azure OpenAI
  deployment_name?: string;
  api_version?: string;
  // AWS Bedrock
  aws_region?: string;
};

/**
 * Shape of the authJson column for a model endpoint.
 *
 * For non-Bedrock providers: `{ key_hint, key_blob }` where `key_blob`
 * is the encrypted API key.
 *
 * For Bedrock: the access key id is plaintext (not a secret on its
 * own — it's an identifier like a username), the secret access key and
 * optional session token are encrypted. `key_hint` is derived from the
 * access key id for UI display.
 *
 * This must stay in sync with `resolve-endpoint.ts`, which decrypts the
 * stored fields for the extract path.
 */
type AuthJson = {
  key_hint?: string;
  // Non-Bedrock
  key_blob?: string;
  // Bedrock
  aws_access_key_id?: string;
  aws_secret_access_key_blob?: string;
  aws_session_token_blob?: string;
};

/**
 * Validate POST body against the provider's required fields.
 * Returns an error string or null.
 *
 * Exported for unit tests.
 */
export function validateCreatePayload(body: {
  provider: string;
  base_url?: string;
  deployment_name?: string;
  api_version?: string;
  aws_region?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  api_key?: string;
}): string | null {
  const { provider } = body;
  switch (provider) {
    case "openai":
    case "anthropic":
    case "custom":
      // base_url is optional for openai/anthropic (providers have defaults);
      // custom can run without credentials in rare self-hosted setups.
      return null;
    case "azure-openai":
      if (!body.base_url) return "base_url is required for azure-openai (e.g. https://{resource}.openai.azure.com)";
      if (!body.deployment_name) return "deployment_name is required for azure-openai";
      if (!body.api_version) return "api_version is required for azure-openai (e.g. 2024-02-15-preview)";
      return null;
    case "ollama":
      if (!body.base_url) return "base_url is required for ollama (e.g. http://localhost:11434)";
      return null;
    case "bedrock":
      if (!body.aws_region) return "aws_region is required for bedrock (e.g. us-east-1)";
      if (!body.aws_access_key_id) return "aws_access_key_id is required for bedrock";
      if (!body.aws_secret_access_key) return "aws_secret_access_key is required for bedrock";
      return null;
    default:
      return null;
  }
}

/**
 * Build configJson from the request body, keeping only the fields that
 * apply to the given provider.
 *
 * Exported for unit tests.
 */
export function buildConfigJson(provider: string, body: {
  base_url?: string;
  deployment_name?: string;
  api_version?: string;
  aws_region?: string;
}): ConfigJson {
  const cfg: ConfigJson = {};
  if (provider === "bedrock") {
    if (body.aws_region) cfg.aws_region = body.aws_region;
    return cfg;
  }
  if (body.base_url) cfg.base_url = body.base_url;
  if (provider === "azure-openai") {
    if (body.deployment_name) cfg.deployment_name = body.deployment_name;
    if (body.api_version) cfg.api_version = body.api_version;
  }
  return cfg;
}

/**
 * Build authJson for a create/update, encrypting secrets per the
 * provider shape. Returns null when the caller didn't supply any
 * credentials (e.g. ollama without auth).
 *
 * Exported for unit tests.
 */
export function buildAuthJson(
  provider: string,
  body: {
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
  },
  masterKey: string,
  tenantId: string,
): AuthJson | null {
  if (provider === "bedrock") {
    if (!body.aws_access_key_id || !body.aws_secret_access_key) return null;
    const auth: AuthJson = {
      key_hint: keyHint(body.aws_access_key_id),
      aws_access_key_id: body.aws_access_key_id,
      aws_secret_access_key_blob: encrypt(body.aws_secret_access_key, masterKey, tenantId),
    };
    if (body.aws_session_token) {
      auth.aws_session_token_blob = encrypt(body.aws_session_token, masterKey, tenantId);
    }
    return auth;
  }

  // Single-key providers.
  if (!body.api_key) return null;
  return {
    key_hint: keyHint(body.api_key),
    key_blob: encrypt(body.api_key, masterKey, tenantId),
  };
}

/**
 * Public-facing (non-secret) view of the configJson column, suitable
 * for surfacing in the list / detail response. Caller should still
 * only pass through fields relevant to the provider.
 */
function publicConfig(provider: string, cfg: ConfigJson | null | undefined): {
  baseUrl: string | null;
  deploymentName: string | null;
  apiVersion: string | null;
  awsRegion: string | null;
} {
  const c = cfg ?? {};
  return {
    baseUrl: provider === "bedrock" ? null : c.base_url ?? null,
    deploymentName: provider === "azure-openai" ? c.deployment_name ?? null : null,
    apiVersion: provider === "azure-openai" ? c.api_version ?? null : null,
    awsRegion: provider === "bedrock" ? c.aws_region ?? null : null,
  };
}

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
      const auth = r.authJson as AuthJson | null;
      const cfg = r.configJson as ConfigJson | null;
      const pub = publicConfig(r.provider, cfg);
      return {
        id: r.id,
        slug: r.slug,
        displayName: r.displayName,
        provider: r.provider,
        model: r.model,
        baseUrl: pub.baseUrl,
        deploymentName: pub.deploymentName,
        apiVersion: pub.apiVersion,
        awsRegion: pub.awsRegion,
        keyHint: auth?.key_hint ?? null,
        hasKey: !!(auth?.key_blob || auth?.aws_secret_access_key_blob),
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
 *
 * Per-provider required fields (see field matrix in the settings page):
 *   - openai / anthropic / custom: nothing strictly required beyond name+provider
 *   - azure-openai: base_url + deployment_name + api_version
 *   - ollama: base_url
 *   - bedrock: aws_region + aws_access_key_id + aws_secret_access_key
 */
modelProviders.post("/", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const masterKey = requireMasterKey(c);

  const body = await c.req.json<{
    name: string;
    slug: string;
    provider: string;
    model: string;
    // Non-secret config
    base_url?: string;
    deployment_name?: string;
    api_version?: string;
    aws_region?: string;
    // Secrets
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
  }>();

  if (!body.name || !body.slug || !body.provider) {
    return c.json({ error: "name, slug, and provider are required" }, 400);
  }

  if (!body.model || body.model.trim() === "") {
    return c.json({ error: "model is required — specify a model ID (e.g. gpt-4o-mini, claude-sonnet-4-20250514)" }, 400);
  }

  // Reject bare provider names used as model IDs — must be a specific model.
  const bareProviders = ["openai", "anthropic", "azure-openai", "bedrock", "ollama", "custom"];
  if (bareProviders.includes(body.model.trim().toLowerCase())) {
    return c.json({ error: "model must be a specific model ID (e.g. gpt-4o-mini), not a provider name" }, 400);
  }

  const validationError = validateCreatePayload(body);
  if (validationError) return c.json({ error: validationError }, 400);

  const configJson = buildConfigJson(body.provider, body);
  const authJson = buildAuthJson(body.provider, body, masterKey, tenantId);

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
  const pub = publicConfig(row.provider, configJson);
  return c.json({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    provider: row.provider,
    model: row.model,
    baseUrl: pub.baseUrl,
    deploymentName: pub.deploymentName,
    apiVersion: pub.apiVersion,
    awsRegion: pub.awsRegion,
    keyHint: authJson?.key_hint ?? null,
    hasKey: !!(authJson?.key_blob || authJson?.aws_secret_access_key_blob),
    status: row.status,
    createdAt: row.createdAt,
  }, 201);
});

/**
 * PATCH /api/model-providers/:id — update an endpoint.
 *
 * Any provider-specific non-secret field may be patched; we merge into
 * the existing configJson. Secrets are re-encrypted if supplied (see
 * POST /:id/rotate for credential-only updates).
 */
modelProviders.patch("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey(c);

  const body = await c.req.json<{
    name?: string;
    model?: string;
    base_url?: string;
    deployment_name?: string;
    api_version?: string;
    aws_region?: string;
    // Secret re-entry (full replace)
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
  }>();

  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      provider: schema.modelEndpoints.provider,
      configJson: schema.modelEndpoints.configJson,
      authJson: schema.modelEndpoints.authJson,
    })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1)
  );
  if (!existing) return c.json({ error: "Model provider not found" }, 404);

  const provider = existing.provider;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.model) updates.model = body.model;

  // Merge configJson. We only touch the keys the client sent; missing
  // keys retain their existing values. Passing an empty string clears.
  const cfg: ConfigJson = {
    ...((existing.configJson as ConfigJson | null) ?? {}),
  };
  let configTouched = false;
  if (body.base_url !== undefined) {
    if (body.base_url) cfg.base_url = body.base_url;
    else delete cfg.base_url;
    configTouched = true;
  }
  if (body.deployment_name !== undefined) {
    if (body.deployment_name) cfg.deployment_name = body.deployment_name;
    else delete cfg.deployment_name;
    configTouched = true;
  }
  if (body.api_version !== undefined) {
    if (body.api_version) cfg.api_version = body.api_version;
    else delete cfg.api_version;
    configTouched = true;
  }
  if (body.aws_region !== undefined) {
    if (body.aws_region) cfg.aws_region = body.aws_region;
    else delete cfg.aws_region;
    configTouched = true;
  }
  if (configTouched) updates.configJson = cfg;

  // Re-encrypt credentials if the caller sent any. For Bedrock the
  // caller must send the full trio (access key id + secret); for
  // single-key providers the caller sends api_key.
  if (provider === "bedrock") {
    if (body.aws_access_key_id || body.aws_secret_access_key || body.aws_session_token) {
      if (!body.aws_access_key_id || !body.aws_secret_access_key) {
        return c.json({
          error: "PATCH with Bedrock credentials requires both aws_access_key_id and aws_secret_access_key",
        }, 400);
      }
      updates.authJson = buildAuthJson(provider, body, masterKey, tenantId);
    }
  } else if (body.api_key) {
    updates.authJson = buildAuthJson(provider, body, masterKey, tenantId);
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

  if (rows.length === 0) return c.json({ error: "Model provider not found" }, 404);
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
 *
 * For single-key providers (openai/anthropic/azure-openai/ollama/custom),
 * accepts `{ api_key }` and replaces the encrypted blob.
 *
 * For Bedrock, accepts `{ aws_access_key_id, aws_secret_access_key,
 * aws_session_token? }` and re-encrypts the secret pair. The access
 * key id is stored plaintext (it's an identifier, not a secret).
 */
modelProviders.post("/:id/rotate", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey(c);

  const [existing] = await withRLS(db, tenantId, (tx) =>
    tx.select({
      provider: schema.modelEndpoints.provider,
    })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1)
  );
  if (!existing) return c.json({ error: "Model provider not found" }, 404);

  const body = await c.req.json<{
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
  }>();

  let authJson: AuthJson | null;
  if (existing.provider === "bedrock") {
    if (!body.aws_access_key_id || !body.aws_secret_access_key) {
      return c.json({
        error: "Bedrock rotation requires aws_access_key_id and aws_secret_access_key (aws_session_token is optional).",
      }, 400);
    }
    authJson = buildAuthJson(existing.provider, body, masterKey, tenantId);
  } else {
    if (!body.api_key) {
      return c.json({ error: "api_key is required" }, 400);
    }
    authJson = buildAuthJson(existing.provider, body, masterKey, tenantId);
  }

  if (!authJson) {
    return c.json({ error: "Could not build credentials" }, 400);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.modelEndpoints)
      .set({ authJson, updatedAt: new Date() })
      .where(eq(schema.modelEndpoints.id, endpointId))
      .returning({ id: schema.modelEndpoints.id })
  );

  if (rows.length === 0) return c.json({ error: "Model provider not found" }, 404);
  return c.json({ ok: true, keyHint: authJson.key_hint ?? null });
});

/**
 * POST /api/model-providers/:id/fetch-models — fetch available models
 * from this provider using its stored (encrypted) credentials.
 *
 * Returns the list of models found. Does NOT auto-add to catalog —
 * the client sends the selected models to POST /api/model-catalog/bulk.
 *
 * Only supports providers with list-models HTTP endpoints: openai,
 * azure-openai, anthropic, ollama. Bedrock doesn't have a first-party
 * list-models REST call (would require the AWS SDK + SigV4) — users
 * add Bedrock models manually in the catalog for v1.
 */
modelProviders.post("/:id/fetch-models", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const masterKey = requireMasterKey(c);

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

  const provider = endpoint.provider;
  const config = endpoint.configJson as ConfigJson | null;

  if (provider === "bedrock") {
    return c.json({
      error: "Automatic model fetching is not supported for bedrock. Add models manually in the catalog.",
    }, 400);
  }

  const auth = endpoint.authJson as AuthJson | null;
  const needsKey = provider !== "ollama";
  if (needsKey && !auth?.key_blob) {
    return c.json({ error: "Provider has no credentials configured" }, 400);
  }

  let apiKey = "";
  if (auth?.key_blob) {
    const credStr = decrypt(auth.key_blob, masterKey, tenantId);
    try {
      const parsed = JSON.parse(credStr);
      apiKey = parsed.api_key ?? parsed.apiKey ?? credStr;
    } catch {
      apiKey = credStr;
    }
  }

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
