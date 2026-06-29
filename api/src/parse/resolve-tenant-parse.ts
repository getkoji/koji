/**
 * Resolve a tenant's BYO parse endpoint into a ready-to-use ParseProvider.
 *
 * Parallel to `extract/resolve-endpoint.ts` (`resolveTenantProvider`). Looks
 * up the tenant's active `parse_endpoints` row (or a pipeline-pinned
 * `parseProviderId`), decrypts the `auth_json` envelope at call time via
 * `crypto/envelope`, and hands the decrypted config to the driver registry.
 *
 * Returns null when:
 *   - The tenant has no active parse endpoint configured.
 *   - The endpoint exists but has no `auth_json`, or decryption fails.
 *   - No driver is registered for the endpoint's provider (the current state
 *     for every provider — drivers land in later waves).
 *
 * A null return is the safe, dormant path: the parse factory falls back to
 * the system default heavy provider (docling sidecar / Modal), so production
 * behavior is unchanged until both a driver and a configured endpoint exist.
 */

import { and, eq } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Db } from "@koji/db";
import { decrypt, getMasterKey } from "../crypto/envelope";
import type { ParseProvider } from "./provider";
import { createParseDriver, parseDriverKind, type ParseDriverKind } from "./drivers";

export interface ParseEndpointPayload {
  /** UUID of the source `parse_endpoints` row (for health attribution later). */
  endpoint_id?: string;
  /** Provider slug, e.g. "mistral-ocr", "azure-document-intel", "textract". */
  provider: string;
  /** Provider model/processor, e.g. "mistral-ocr-latest", "prebuilt-layout". */
  model?: string;
  /** Decrypted API key (when the provider authenticates with a single key). */
  api_key?: string;
  /** Optional API base URL override (from config_json). */
  base_url?: string;
  /** Optional cloud region (Textract / Document AI). */
  region?: string;
  /**
   * Full plaintext config_json blob. Drivers read provider-specific fields
   * (project id, processor id, endpoint host, etc.) from here.
   */
  config?: Record<string, unknown>;
}

type ParseConfigBlob = {
  base_url?: string;
  region?: string;
  [key: string]: unknown;
};

type ParseAuthBlob = {
  key_hint?: string;
  key_blob?: string;
};

/**
 * Pick the first active, non-deleted parse endpoint for a tenant. Optional
 * `preferProvider` narrows by provider slug. Returns the `parse_endpoints.id`
 * or null when nothing matches.
 */
export async function pickActiveParseEndpoint(
  db: Db,
  tenantId: string,
  preferProvider: string | null,
): Promise<string | null> {
  const conditions = [eq(schema.parseEndpoints.status, "active")];
  if (preferProvider) {
    conditions.push(eq(schema.parseEndpoints.provider, preferProvider));
  }
  const [row] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.parseEndpoints.id })
      .from(schema.parseEndpoints)
      .where(and(...conditions))
      .limit(1),
  );
  return row?.id ?? null;
}

/**
 * Resolve a specific `parse_endpoints` row into a decrypted payload. Returns
 * null when the row is missing, has no auth, or decryption fails.
 */
export async function resolveParseEndpoint(
  db: Db,
  tenantId: string,
  parseProviderId: string | null,
): Promise<ParseEndpointPayload | null> {
  if (!parseProviderId) return null;

  const [endpoint] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.parseEndpoints.id,
        provider: schema.parseEndpoints.provider,
        model: schema.parseEndpoints.model,
        configJson: schema.parseEndpoints.configJson,
        authJson: schema.parseEndpoints.authJson,
      })
      .from(schema.parseEndpoints)
      .where(eq(schema.parseEndpoints.id, parseProviderId))
      .limit(1),
  );

  if (!endpoint) return null;

  const cfg = (endpoint.configJson ?? {}) as ParseConfigBlob;
  const auth = (endpoint.authJson ?? null) as ParseAuthBlob | null;

  // No credentials → can't call the vendor. Return null so the factory uses
  // the default heavy provider rather than a half-configured driver.
  if (!auth) return null;

  const masterKey = getMasterKey();
  if (!masterKey) {
    console.warn(
      "[resolve-tenant-parse] KOJI_MASTER_KEY is not set; skipping parse " +
        "credential decryption. Falling back to the default heavy provider.",
    );
    return null;
  }

  const payload: ParseEndpointPayload = {
    endpoint_id: endpoint.id,
    provider: endpoint.provider,
    model: endpoint.model,
    config: cfg,
  };
  if (cfg.base_url) payload.base_url = cfg.base_url;
  if (cfg.region) payload.region = cfg.region;

  try {
    if (auth.key_blob) {
      payload.api_key = decrypt(auth.key_blob, masterKey, tenantId);
    }
  } catch (err) {
    console.warn(
      `[resolve-tenant-parse] failed to decrypt credentials for parse endpoint ` +
        `${parseProviderId}: `,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  return payload;
}

/** A resolved tenant parse provider plus its output class (PB-10 routing). */
export interface ResolvedTenantParse {
  provider: ParseProvider;
  /**
   * Output class of the provider's driver. `markdown` providers fill the
   * `heavy` slot (text-heavy docs); `structured` providers fill the
   * `structured` slot so `SmartParseProvider` can route table-heavy docs to
   * them (PB-10). See `drivers.ts#parseDriverKind`.
   */
  kind: ParseDriverKind;
}

/**
 * Resolve the tenant's parse provider into a ready-to-use ParseProvider plus
 * its output class, or null when none is configured / no driver exists.
 *
 * The result feeds `createParseProvider`'s `tenantHeavy` (markdown) or
 * `tenantStructured` (structured) slot. A null return is the dormant path: the
 * factory falls back to the system default heavy provider and doc-type routing
 * stays off, so production behavior is unchanged until both a driver and a
 * configured endpoint exist.
 */
export async function resolveTenantParse(
  db: Db,
  tenantId: string,
  opts?: {
    /** Use a specific endpoint by id (e.g. a pipeline's pinned parseProviderId). */
    parseProviderId?: string | null;
    /** Prefer this provider slug — filters active endpoints by provider. */
    preferProvider?: string | null;
  },
): Promise<ResolvedTenantParse | null> {
  let payload: ParseEndpointPayload | null = null;

  try {
    if (opts?.parseProviderId) {
      payload = await resolveParseEndpoint(db, tenantId, opts.parseProviderId);
    } else {
      const found = await pickActiveParseEndpoint(db, tenantId, opts?.preferProvider ?? null);
      if (found) payload = await resolveParseEndpoint(db, tenantId, found);
    }
  } catch (err) {
    console.warn(
      "[resolve-tenant-parse] parse endpoint resolution failed; using default: ",
      err instanceof Error ? err.message : err,
    );
  }

  if (!payload) return null;
  const provider = createParseDriver(payload);
  if (!provider) return null;
  return { provider, kind: parseDriverKind(payload.provider) };
}

/**
 * Back-compat shim: resolve just the provider instance (no kind). Kept for the
 * `byo-parse-providers.md` documented API; new callers that route by content
 * type should use {@link resolveTenantParse}. Returns null when none is
 * configured / no driver exists.
 */
export async function resolveTenantParseProvider(
  db: Db,
  tenantId: string,
  opts?: {
    parseProviderId?: string | null;
    preferProvider?: string | null;
  },
): Promise<ParseProvider | null> {
  const resolved = await resolveTenantParse(db, tenantId, opts);
  return resolved?.provider ?? null;
}
