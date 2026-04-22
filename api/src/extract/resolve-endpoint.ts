/**
 * Resolve a pipeline's model endpoint into the decrypted config payload
 * the extract service expects.
 *
 * The extract service accepts an optional `endpoint` block on every
 * POST /extract request (see services/extract/main.py EndpointConfig).
 * When present, it overrides env-var defaults and routes to the matching
 * provider adapter. This module does the Node-side work: look up the
 * pipeline's modelProviderId, fetch + decrypt the authJson envelope,
 * and shape a plain JSON object suitable for the wire.
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

import { eq } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { decrypt, getMasterKey } from "../crypto/envelope";

export interface ExtractEndpointPayload {
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

export async function resolveExtractEndpoint(
  db: Db,
  tenantId: string,
  modelProviderId: string | null,
): Promise<ExtractEndpointPayload | null> {
  if (!modelProviderId) return null;

  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        provider: schema.modelEndpoints.provider,
        model: schema.modelEndpoints.model,
        configJson: schema.modelEndpoints.configJson,
        authJson: schema.modelEndpoints.authJson,
      })
      .from(schema.modelEndpoints)
      .where(eq(schema.modelEndpoints.id, modelProviderId))
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

  const payload: ExtractEndpointPayload = {
    provider: endpoint.provider,
    model: endpoint.model,
  };
  if (cfg.base_url) payload.base_url = cfg.base_url;
  if (cfg.deployment_name) payload.deployment_name = cfg.deployment_name;
  if (cfg.api_version) payload.api_version = cfg.api_version;
  if (cfg.aws_region) payload.aws_region = cfg.aws_region;

  if (!auth) return payload; // endpoint with no secret (managed IAM etc.)
  if (!masterKey) {
    console.warn(
      "[resolve-endpoint] KOJI_MASTER_KEY is not set; skipping credential decryption. " +
        "Extract will fall back to env defaults.",
    );
    return null;
  }

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
