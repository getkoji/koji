/**
 * Resolve a pipeline's model endpoint into a decrypted provider config.
 *
 * Looks up the pipeline's modelProviderId, fetches + decrypts the authJson
 * envelope, and returns a ready-to-use LLM provider instance. Used by the
 * in-process extraction pipeline to route LLM calls to the correct endpoint.
 *
 * Reads from the credential→model split: `tenant_models` holds the model
 * name and `provider_credentials` holds the encrypted key + connection
 * config. The backfill migration (0020) gave each old `model_endpoints`
 * row a `tenant_models` row with the **same id**, so existing
 * `pipeline.modelProviderId` references resolve unchanged.
 *
 * Returns null when:
 *   - The pipeline has no modelProviderId set (fall through to env-var
 *     default on the extract side — used by seed data, early adopters
 *     on the dev cluster that didn't configure BYO yet).
 *   - The endpoint exists but has no authJson, or auth decryption fails
 *     (the caller surfaces the error through the trace; we log and
 *     return null so the extract call can at least attempt with env
 *     defaults instead of a hard 500).
 */

import { eq, and } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { decrypt, getMasterKey } from "../crypto/envelope";
import { createProvider } from "./providers";
import type { ModelProvider } from "./providers";
import { wrapProviderWithHealthTracking } from "./endpoint-health";

export interface ExtractEndpointPayload {
  /**
   * UUID of the source `tenant_models` row (== legacy `model_endpoints.id`),
   * when this payload originated from a tenant-configured model. Health
   * tracking attaches to the underlying credential; the env-var fallback
   * path leaves this undefined.
   */
  endpoint_id?: string;
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  // Azure-specific
  deployment_name?: string;
  api_version?: string;
  // Bedrock-specific
  aws_region?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
}

/**
 * Pick the first active tenant model whose credential is also active.
 * Optional `preferModel` narrows by model name (e.g. "gpt-4o-mini"). Returns
 * the `tenant_models.id` or null when nothing matches. Used by extract.ts
 * fallback paths that need an endpoint id without a pipeline context.
 */
export async function pickActiveTenantModel(
  db: Db,
  tenantId: string,
  preferModel: string | null,
): Promise<string | null> {
  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.tenantModels.id, model: schema.tenantModels.model })
      .from(schema.tenantModels)
      .innerJoin(
        schema.providerCredentials,
        eq(schema.providerCredentials.id, schema.tenantModels.credentialId),
      )
      .where(
        and(
          eq(schema.tenantModels.status, "active"),
          eq(schema.providerCredentials.status, "active"),
        ),
      ),
  );
  if (!preferModel) return rows[0]?.id ?? null;

  // Match by model name, tolerating a `provider/` prefix on either side — so
  // `openai/gpt-4o` matches a stored `gpt-4o` (and vice versa). Without this the
  // exact-string match missed prefixed names, silently fell back to an env-key
  // provider, and returned an empty extraction. Dated snapshots (`gpt-4o-2024-…`)
  // still require an exactly-configured model — a genuinely different model
  // shouldn't be silently aliased to its base.
  const stripPrefix = (m: string) => (m.includes("/") ? m.slice(m.indexOf("/") + 1) : m);
  const want = stripPrefix(preferModel);
  const match = rows.find((r) => r.model === preferModel || stripPrefix(r.model) === want);
  return match?.id ?? null;
}

export async function resolveExtractEndpoint(
  db: Db,
  tenantId: string,
  modelProviderId: string | null,
): Promise<ExtractEndpointPayload | null> {
  if (!modelProviderId) return null;

  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.tenantModels.id,
        provider: schema.providerCredentials.provider,
        model: schema.tenantModels.model,
        configJson: schema.providerCredentials.configJson,
        authJson: schema.providerCredentials.authJson,
      })
      .from(schema.tenantModels)
      .innerJoin(
        schema.providerCredentials,
        eq(schema.providerCredentials.id, schema.tenantModels.credentialId),
      )
      .where(eq(schema.tenantModels.id, modelProviderId))
      .limit(1),
  );

  if (!endpoint) return null;

  // configJson is the plaintext shape (base_url, deployment_name,
  // api_version, aws_region, etc.). The provider adapter decides
  // which fields apply.
  const cfg = (endpoint.configJson ?? {}) as {
    base_url?: string;
    deployment_name?: string;
    api_version?: string;
    aws_region?: string;
  };

  // authJson stores the encrypted secret alongside a plaintext key_hint
  // for UI display. The encrypted blob lives under `key_blob`
  // (OpenAI/Azure/Anthropic/Ollama) or `aws_secret_access_key_blob` +
  // `aws_session_token_blob` for Bedrock.
  type AuthBlob = {
    key_hint?: string;
    key_blob?: string;
    aws_access_key_id?: string;
    aws_secret_access_key_blob?: string;
    aws_session_token_blob?: string;
  };
  const auth = (endpoint.authJson ?? null) as AuthBlob | null;
  const masterKey = getMasterKey();

  // No auth configured for this endpoint. We DO NOT send a partial
  // payload — the Python adapter treats `provider=openai` etc. as a
  // full config and rejects it with `openai endpoint requires api_key`
  // if credentials are missing, which then retries the entire
  // extraction in a tight loop (the error is not transient). Returning
  // null puts us on the env-var fallback path (OPENAI_API_KEY /
  // ANTHROPIC_API_KEY from the extract container's environment), which
  // is the historic default and what the seed pipelines expect.
  if (!auth) return null;
  if (!masterKey) {
    console.warn(
      "[resolve-endpoint] KOJI_MASTER_KEY is not set; skipping credential decryption. " +
        "Extract will fall back to env defaults.",
    );
    return null;
  }

  const payload: ExtractEndpointPayload = {
    endpoint_id: endpoint.id,
    provider: endpoint.provider,
    model: endpoint.model,
  };
  if (cfg.base_url) payload.base_url = cfg.base_url;
  if (cfg.deployment_name) payload.deployment_name = cfg.deployment_name;
  if (cfg.api_version) payload.api_version = cfg.api_version;
  if (cfg.aws_region) payload.aws_region = cfg.aws_region;

  try {
    if (endpoint.provider === "bedrock") {
      if (auth.aws_access_key_id) payload.aws_access_key_id = auth.aws_access_key_id;
      if (auth.aws_secret_access_key_blob) {
        payload.aws_secret_access_key = decrypt(
          auth.aws_secret_access_key_blob,
          masterKey,
          tenantId,
        );
      }
      if (auth.aws_session_token_blob) {
        payload.aws_session_token = decrypt(auth.aws_session_token_blob, masterKey, tenantId);
      }
    } else if (auth.key_blob) {
      payload.api_key = decrypt(auth.key_blob, masterKey, tenantId);
    }
  } catch (err) {
    console.warn(
      `[resolve-endpoint] failed to decrypt credentials for endpoint ${modelProviderId}: `,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  return payload;
}

/**
 * Resolve the tenant's active model endpoint and return a ready-to-use
 * ModelProvider. This is the standard way to get an LLM provider for
 * build-time features (schema agent, form test, extract preview, etc.)
 * that don't have a pipeline context.
 *
 * Looks up the first active model endpoint for the tenant, decrypts
 * credentials, and creates the provider. Falls back to env-var defaults
 * (KOJI_EXTRACT_MODEL / OPENAI_API_KEY) if no endpoint is configured.
 *
 * Optionally accepts a specific modelProviderId to use instead of the
 * tenant's default.
 */
export async function resolveTenantProvider(
  db: Db,
  tenantId: string,
  opts?: {
    /** Use a specific endpoint by ID (e.g. from a pipeline's modelProviderId) */
    modelProviderId?: string | null;
    /** Prefer this model string — filters active endpoints by model name */
    preferModel?: string | null;
  },
): Promise<{ provider: ModelProvider; model: string }> {
  let endpointPayload: ExtractEndpointPayload | null = null;

  try {
    if (opts?.modelProviderId) {
      endpointPayload = await resolveExtractEndpoint(db, tenantId, opts.modelProviderId);
    } else {
      const found = await pickActiveTenantModel(db, tenantId, opts?.preferModel ?? null);
      if (found) endpointPayload = await resolveExtractEndpoint(db, tenantId, found);
    }
  } catch {}

  const model = endpointPayload?.model || process.env.KOJI_EXTRACT_MODEL || "gpt-4o-mini";
  const rawProvider = createProvider(model, endpointPayload);
  // Wrap in health-tracking when we have a tenant-configured endpoint to
  // attribute results to. Env-var fallback (no endpoint_id) returns the
  // raw provider — there's no row to record health against.
  const provider = wrapProviderWithHealthTracking(rawProvider, db, endpointPayload?.endpoint_id);
  return { provider, model };
}
