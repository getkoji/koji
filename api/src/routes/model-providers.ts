import type { Context } from "hono";
import { Hono } from "hono";
import { and, eq, ne, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";
import { encrypt, decrypt, keyHint } from "../crypto/envelope";

/**
 * Derive the provider_credentials.id for a given model_endpoints.id, matching
 * the deterministic md5 formula used by the 0020 backfill migration. Mirrors
 * the SQL `md5('cred:' || id::text)::uuid` so writes that originate from this
 * route stay consistent with rows the migration created.
 */
export function deriveCredentialId(endpointId: string): string {
  const h = crypto.createHash("md5").update(`cred:${endpointId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Whether the caller may create, edit, or delete a workspace-shared credential
 * (one with a NULL project_id). A shared credential is reachable from every
 * project, so changing it reaches beyond whatever project the request is
 * scoped to — restrict that to callers who aren't themselves confined to a
 * subset of projects. `accessibleProjectIds` is null for an unrestricted
 * member or an all-access API key, and a Set for anyone narrowed to specific
 * projects (see auth/middleware.ts stage 2.5).
 */
export const SHARED_MUTATION_DENIED =
  "This credential is shared with every project. Only a member with access to all projects can change it.";

export function canManageShared(c: Context<Env>): boolean {
  return c.get("accessibleProjectIds") === null;
}

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
  /**
   * Context window, in tokens, the models on this credential honor. Optional —
   * each provider adapter has its own default. The extraction budgeter splits
   * prompts against this number, so declaring it matters most where the default
   * is wrong: a local model whose window is smaller than the hosted default, or
   * a large-window model you want used fully.
   */
  context_tokens?: number;
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
  context_tokens?: number;
  deployment_name?: string;
  api_version?: string;
  aws_region?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  api_key?: string;
}): string | null {
  const { provider } = body;
  const hasApiKey = !!body.api_key?.trim();
  switch (provider) {
    case "openai":
    case "anthropic":
      // base_url is optional (both providers have defaults), but the key is
      // not: a hosted provider without one stores a credential that lists
      // fine and fails at call time with an upstream 401. Rejecting here is
      // what keeps "configured" and "usable" the same thing.
      if (!hasApiKey) return `api_key is required for ${provider}`;
      return null;
    case "custom":
      // custom can run without credentials in rare self-hosted setups.
      return null;
    case "azure-openai":
      if (!body.base_url) return "base_url is required for azure-openai (e.g. https://{resource}.openai.azure.com)";
      if (!body.deployment_name) return "deployment_name is required for azure-openai";
      if (!body.api_version) return "api_version is required for azure-openai (e.g. 2024-02-15-preview)";
      if (!hasApiKey) return "api_key is required for azure-openai";
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
 * Coerce a client-supplied `context_tokens` into a usable window, or undefined.
 * Zero/negative/non-finite values are dropped rather than stored: a bad number
 * here would silently shrink every prompt the engine builds for this endpoint.
 *
 * Exported for unit tests.
 */
export function normalizeContextTokens(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

/**
 * Build configJson from the request body, keeping only the fields that
 * apply to the given provider.
 *
 * Exported for unit tests.
 */
export function buildConfigJson(provider: string, body: {
  base_url?: string;
  context_tokens?: number;
  deployment_name?: string;
  api_version?: string;
  aws_region?: string;
}): ConfigJson {
  const cfg: ConfigJson = {};
  const ctx = normalizeContextTokens(body.context_tokens);
  if (provider === "bedrock") {
    if (body.aws_region) cfg.aws_region = body.aws_region;
    if (ctx !== undefined) cfg.context_tokens = ctx;
    return cfg;
  }
  if (body.base_url) cfg.base_url = body.base_url;
  if (ctx !== undefined) cfg.context_tokens = ctx;
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
  contextTokens: number | null;
  deploymentName: string | null;
  apiVersion: string | null;
  awsRegion: string | null;
} {
  const c = cfg ?? {};
  return {
    baseUrl: provider === "bedrock" ? null : c.base_url ?? null,
    contextTokens: c.context_tokens ?? null,
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({
        id: schema.modelEndpoints.id,
        projectId: schema.modelEndpoints.projectId,
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

  const masterKey = c.get("masterKey") as string | null;

  return c.json({
    data: rows.map((r) => {
      const auth = r.authJson as AuthJson | null;
      const cfg = r.configJson as ConfigJson | null;
      const pub = publicConfig(r.provider, cfg);

      // Test if stored credentials can actually be decrypted with the
      // current master key. Surfaces "invalid" when the key has rotated
      // or the blob is corrupt — saves users from debugging silent
      // extraction failures.
      let credentialStatus: "ok" | "invalid" | "none" | "no_master_key" = "none";
      const hasBlob = !!(auth?.key_blob || auth?.aws_secret_access_key_blob);
      if (hasBlob && !masterKey) {
        credentialStatus = "no_master_key";
      } else if (hasBlob && masterKey) {
        try {
          const blob = auth!.key_blob ?? auth!.aws_secret_access_key_blob!;
          decrypt(blob, masterKey, tenantId);
          credentialStatus = "ok";
        } catch {
          credentialStatus = "invalid";
        }
      }

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
        // NULL project_id = shared with every project in the workspace.
        scope: r.projectId === null ? "all" : "project",
        hasKey: hasBlob,
        credentialStatus,
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
    context_tokens?: number;
    deployment_name?: string;
    api_version?: string;
    aws_region?: string;
    // Secrets
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
    // Optional: which capabilities the first model should be registered
    // for. Defaults to ["chat"] when omitted (single-row dual-write).
    capabilities?: string[];
    /**
     * Who can use this credential. `project` (default) confines it to the
     * request's project; `all` stores a NULL project_id, sharing it with every
     * project in the workspace. A project-scoped credential of the same
     * provider overrides a shared one for that project.
     */
    scope?: "project" | "all";
  }>();

  if (!body.name || !body.slug || !body.provider) {
    return c.json({ error: "name, slug, and provider are required" }, 400);
  }

  if (body.scope && body.scope !== "project" && body.scope !== "all") {
    return c.json({ error: 'scope must be "project" or "all"' }, 400);
  }
  const shared = body.scope === "all";
  // Sharing a credential hands it to projects the caller may not belong to,
  // so only a member who can already reach every project may create one.
  if (shared && !canManageShared(c)) {
    return c.json(
      { error: "Only a member with access to every project can share a credential across projects." },
      403,
    );
  }

  if (!body.model || body.model.trim() === "") {
    return c.json({ error: "model is required — specify a model ID (e.g. gpt-4o-mini, claude-sonnet-4-20250514)" }, 400);
  }

  const VALID_CAPS = new Set(["chat", "vision", "ocr"]);
  const firstModelCaps = Array.isArray(body.capabilities) && body.capabilities.length > 0
    ? Array.from(new Set(body.capabilities.map((c) => String(c).toLowerCase())))
    : ["chat"];
  for (const cap of firstModelCaps) {
    if (!VALID_CAPS.has(cap)) {
      return c.json(
        { error: `capability must be one of: ${[...VALID_CAPS].join(", ")}` },
        400,
      );
    }
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

  // The dashboard derives the slug from the display name, so "add a credential
  // with a name this scope already uses" hit the unique index and surfaced as a
  // raw 500 with a SQL dump in it. Answer it as the conflict it is.
  //
  // Scope-aware on purpose: a shared `openai` and a project-scoped `openai` are
  // allowed to coexist — that pair IS the override. Only a collision within the
  // same scope is a conflict.
  const targetProjectId = shared ? null : requireProjectId(c);
  const [clash] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.modelEndpoints.id })
      .from(schema.modelEndpoints)
      .where(
        and(
          eq(schema.modelEndpoints.slug, body.slug),
          targetProjectId === null
            ? sql`project_id IS NULL`
            : eq(schema.modelEndpoints.projectId, targetProjectId),
          sql`deleted_at IS NULL`,
        ),
      )
      .limit(1),
  );
  if (clash) {
    return c.json(
      {
        error: shared
          ? `A credential named “${body.name}” is already shared with all projects.`
          : `A credential named “${body.name}” already exists in this project.`,
      },
      409,
    );
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.modelEndpoints)
      .values({
        tenantId,
        projectId: targetProjectId,
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

  // Dual-write into the split tables so the new resolve path (tenant_models
  // → provider_credentials) sees this endpoint. IDs are derived to match
  // the 0020 backfill convention so a row created here looks identical to
  // one the migration would have produced.
  const credentialId = deriveCredentialId(row.id);
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, async (tx) => {
    await tx
      .insert(schema.providerCredentials)
      .values({
        id: credentialId,
        tenantId,
        projectId: targetProjectId,
        slug: body.slug,
        displayName: body.name,
        provider: body.provider,
        configJson,
        authJson,
        createdBy: principal.userId,
      })
      .onConflictDoNothing();
    // First-model rows. The legacy model_endpoints row id is reused as
    // tenant_models.id for the FIRST capability so existing FKs
    // (pipelines.model_provider_id) keep resolving. Additional capability
    // rows get fresh ids — they're only addressed via the picker UIs.
    const [first, ...extra] = firstModelCaps;
    await tx
      .insert(schema.tenantModels)
      .values({
        id: row.id,
        tenantId,
        credentialId,
        model: body.model,
        capability: first!,
        slug: body.slug,
        displayName: body.name,
      })
      .onConflictDoNothing();
    if (extra.length > 0) {
      await tx
        .insert(schema.tenantModels)
        .values(
          extra.map((capability) => ({
            tenantId,
            credentialId,
            model: body.model,
            capability,
            displayName: body.name,
          })),
        )
        .onConflictDoNothing();
    }
  });
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
    scope: targetProjectId === null ? "all" : "project",
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
    context_tokens?: number;
    deployment_name?: string;
    api_version?: string;
    aws_region?: string;
    // Secret re-entry (full replace)
    api_key?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    aws_session_token?: string;
    /**
     * Re-scope an existing credential: "all" shares it with every project,
     * "project" pulls it back to the current one. Omitted leaves scope alone.
     * This is the only way to share a credential that already holds a key —
     * the key can't be read back, so recreating it in the other scope would
     * mean the user re-typing a secret they may no longer have.
     */
    scope?: "project" | "all";
  }>();

  if (body.scope && body.scope !== "project" && body.scope !== "all") {
    return c.json({ error: 'scope must be "project" or "all"' }, 400);
  }

  const [existing] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      provider: schema.modelEndpoints.provider,
      slug: schema.modelEndpoints.slug,
      projectId: schema.modelEndpoints.projectId,
      configJson: schema.modelEndpoints.configJson,
      authJson: schema.modelEndpoints.authJson,
    })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1)
  );
  if (!existing) return c.json({ error: "Model provider not found" }, 404);
  if (existing.projectId === null && !canManageShared(c)) {
    return c.json({ error: SHARED_MUTATION_DENIED }, 403);
  }

  const provider = existing.provider;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) updates.displayName = body.name;
  if (body.model) updates.model = body.model;

  // Scope change. Sharing reaches every project, so it needs the same
  // authority creating a shared credential does; un-sharing pins the
  // credential to the project the request is scoped to.
  let newProjectId: string | null | undefined;
  if (body.scope) {
    const wantShared = body.scope === "all";
    const isShared = existing.projectId === null;
    if (wantShared !== isShared) {
      if (wantShared && !canManageShared(c)) {
        return c.json(
          { error: "Only a member with access to every project can share a credential across projects." },
          403,
        );
      }
      newProjectId = wantShared ? null : requireProjectId(c);
      // The target scope has its own one-slug-per-scope index; a collision
      // there would otherwise surface as a raw constraint violation.
      const [clash] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
        tx
          .select({ id: schema.modelEndpoints.id })
          .from(schema.modelEndpoints)
          .where(
            and(
              eq(schema.modelEndpoints.slug, existing.slug),
              ne(schema.modelEndpoints.id, endpointId),
              newProjectId === null
                ? sql`project_id IS NULL`
                : eq(schema.modelEndpoints.projectId, newProjectId),
              sql`deleted_at IS NULL`,
            ),
          )
          .limit(1),
      );
      if (clash) {
        return c.json(
          {
            error: wantShared
              ? `A credential named “${existing.slug}” is already shared with all projects.`
              : `A credential named “${existing.slug}” already exists in this project.`,
          },
          409,
        );
      }
      updates.projectId = newProjectId;
    }
  }

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
  if (body.context_tokens !== undefined) {
    const ctx = normalizeContextTokens(body.context_tokens);
    if (ctx !== undefined) cfg.context_tokens = ctx;
    else delete cfg.context_tokens;
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

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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

  // Mirror to the split tables. Connection-shaped fields go to the
  // credential; model-shaped fields go to the tenant_model.
  const credentialId = deriveCredentialId(endpointId);
  const credentialUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) credentialUpdates.displayName = body.name;
  // The credential row is what resolution actually reads, so its project_id
  // is the one that decides reach — keep the two in lock-step.
  if (newProjectId !== undefined) credentialUpdates.projectId = newProjectId;
  if (configTouched) credentialUpdates.configJson = cfg;
  if (updates.authJson) credentialUpdates.authJson = updates.authJson;
  const modelUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name) modelUpdates.displayName = body.name;
  if (body.model) modelUpdates.model = body.model;

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, async (tx) => {
    if (Object.keys(credentialUpdates).length > 1) {
      await tx
        .update(schema.providerCredentials)
        .set(credentialUpdates)
        .where(eq(schema.providerCredentials.id, credentialId));
    }
    if (Object.keys(modelUpdates).length > 1) {
      await tx
        .update(schema.tenantModels)
        .set(modelUpdates)
        .where(eq(schema.tenantModels.id, endpointId));
    }
  });

  return c.json(rows[0]);
});

/**
 * DELETE /api/model-providers/:id — soft-delete an endpoint.
 */
modelProviders.delete("/:id", requires("endpoint:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const endpointId = c.req.param("id")!;
  const now = new Date();
  const credentialId = deriveCredentialId(endpointId);

  const [target] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ projectId: schema.modelEndpoints.projectId })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1),
  );
  if (!target) return c.json({ error: "Model provider not found" }, 404);
  // Deleting a shared credential takes it away from every project, so it needs
  // the same reach the caller would need to have created it.
  if (target.projectId === null && !canManageShared(c)) {
    return c.json({ error: SHARED_MUTATION_DENIED }, 403);
  }

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, async (tx) => {
    await tx
      .update(schema.modelEndpoints)
      .set({ deletedAt: now })
      .where(eq(schema.modelEndpoints.id, endpointId));
    // Every model on the credential, not just the one that reuses the legacy
    // endpoint id. A credential created with capabilities ["chat","vision"]
    // has a second row with a fresh id; keying the delete on `id = endpointId`
    // left that row alive and pointing at a deleted credential.
    await tx
      .update(schema.tenantModels)
      .set({ deletedAt: now })
      .where(eq(schema.tenantModels.credentialId, credentialId));
    await tx
      .update(schema.providerCredentials)
      .set({ deletedAt: now })
      .where(eq(schema.providerCredentials.id, credentialId));
  });

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

  const [existing] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx.select({
      provider: schema.modelEndpoints.provider,
      projectId: schema.modelEndpoints.projectId,
    })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, endpointId))
      .limit(1)
  );
  if (!existing) return c.json({ error: "Model provider not found" }, 404);
  if (existing.projectId === null && !canManageShared(c)) {
    return c.json({ error: SHARED_MUTATION_DENIED }, 403);
  }

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

  const now = new Date();
  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.modelEndpoints)
      .set({ authJson, updatedAt: now })
      .where(eq(schema.modelEndpoints.id, endpointId))
      .returning({ id: schema.modelEndpoints.id })
  );

  if (rows.length === 0) return c.json({ error: "Model provider not found" }, 404);

  // Mirror to the credential — auth lives there in the split shape.
  const credentialId = deriveCredentialId(endpointId);
  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.providerCredentials)
      .set({ authJson, updatedAt: now })
      .where(eq(schema.providerCredentials.id, credentialId)),
  );

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

  const [endpoint] = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
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
