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

import { and, eq, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { RlsScope } from "@koji/db";
import type { Db } from "@koji/db";
import { decrypt, getMasterKey } from "../crypto/envelope";
import type { ParseProvider } from "./provider";
import { createParseDriver, parseDriverKind, type ParseDriverKind } from "./drivers";
import { readGcpWifConfig, mintGcpAccessToken, gcpWifCacheKey } from "./auth/gcp-wif";

export interface ParseEndpointPayload {
  /** UUID of the source `parse_endpoints` row (for health attribution later). */
  endpoint_id?: string;
  /**
   * ISO timestamp of the source endpoint's last update. Part of the parse-cache
   * fingerprint so editing an endpoint's output-affecting config busts the
   * cache (oss-298).
   */
  endpoint_updated_at?: string;
  /** Provider slug, e.g. "mistral-ocr", "azure-document-intel", "textract". */
  provider: string;
  /** Provider model/processor, e.g. "mistral-ocr-latest", "prebuilt-layout". */
  model?: string;
  /**
   * Bearer credential the driver authenticates with. Either:
   *   - the decrypted static API key / access token (single-key providers, and
   *     the today path for GCP providers that take a ready access token), or
   *   - a **freshly minted, short-lived** access token when the endpoint is
   *     configured for keyless Workload Identity Federation (see
   *     `auth/gcp-wif.ts`). Minting + caching happen in the resolver so the
   *     driver stays credential-agnostic — it just receives a ready token.
   */
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
 *
 * Delete stamps `deleted_at` and leaves `status` alone, so the `deleted_at IS
 * NULL` arm is what makes a deleted endpoint actually stop being picked —
 * without it the first row the planner returned could be one the user had
 * thrown away. Ordering by `created_at` makes the pick deterministic.
 */
export async function pickActiveParseEndpoint(
  db: Db,
  scope: RlsScope,
  preferProvider: string | null,
): Promise<string | null> {
  const conditions = [
    eq(schema.parseEndpoints.status, "active"),
    isNull(schema.parseEndpoints.deletedAt),
  ];
  if (preferProvider) {
    conditions.push(eq(schema.parseEndpoints.provider, preferProvider));
  }
  const [row] = await withRLS(db, scope, (tx) =>
    tx
      .select({ id: schema.parseEndpoints.id })
      .from(schema.parseEndpoints)
      .where(and(...conditions))
      .orderBy(schema.parseEndpoints.createdAt, schema.parseEndpoints.id)
      .limit(1),
  );
  return row?.id ?? null;
}

/**
 * Resolve a specific `parse_endpoints` row into a ready-to-use payload.
 *
 * Two credential shapes are supported, both yielding a ready bearer token in
 * `payload.api_key` so drivers stay credential-agnostic:
 *
 *   - **Static** (today's path): decrypt the stored `auth_json` key/token.
 *     Needs `KOJI_MASTER_KEY`.
 *   - **Keyless WIF**: the endpoint's `config_json` carries a Google
 *     `external_account` credential config (see `auth/gcp-wif.ts`). The token
 *     is minted fresh via Workload Identity Federation and cached until
 *     near-expiry — no stored secret, no master key required. This is the
 *     enterprise path for orgs that block service-account-key creation.
 *
 * Returns null when the row is missing, carries neither credential shape, or
 * the credential can't be produced (decryption / minting failure) — the safe,
 * dormant path that falls back to the default heavy provider.
 */
export async function resolveParseEndpoint(
  db: Db,
  scope: RlsScope,
  parseProviderId: string | null,
): Promise<ParseEndpointPayload | null> {
  if (!parseProviderId) return null;
  const tenantId = typeof scope === "string" ? scope : scope.tenantId;

  const [endpoint] = await withRLS(db, scope, (tx) =>
    tx
      .select({
        id: schema.parseEndpoints.id,
        provider: schema.parseEndpoints.provider,
        model: schema.parseEndpoints.model,
        configJson: schema.parseEndpoints.configJson,
        authJson: schema.parseEndpoints.authJson,
        updatedAt: schema.parseEndpoints.updatedAt,
      })
      .from(schema.parseEndpoints)
      .where(
        and(
          eq(schema.parseEndpoints.id, parseProviderId),
          isNull(schema.parseEndpoints.deletedAt),
        ),
      )
      .limit(1),
  );

  // A pipeline pinned to a deleted parse endpoint resolves to nothing, so the
  // factory falls back to the default heavy provider rather than keeping a
  // deleted vendor credential in service.
  if (!endpoint) return null;

  const cfg = (endpoint.configJson ?? {}) as ParseConfigBlob;
  const auth = (endpoint.authJson ?? null) as ParseAuthBlob | null;

  // Keyless WIF is configured in (non-secret) config_json, so an endpoint can
  // be fully valid with no auth_json at all. Detect it before the
  // "no credentials" guard.
  const wif = readGcpWifConfig(cfg);

  // No credential of either kind → can't call the vendor. Return null so the
  // factory uses the default heavy provider rather than a half-configured one.
  if (!auth && !wif) return null;

  const payload: ParseEndpointPayload = {
    endpoint_id: endpoint.id,
    endpoint_updated_at: endpoint.updatedAt?.toISOString(),
    provider: endpoint.provider,
    model: endpoint.model,
    config: cfg,
  };
  if (cfg.base_url) payload.base_url = cfg.base_url;
  if (cfg.region) payload.region = cfg.region;

  if (wif) {
    // Keyless path: mint a short-lived access token via Workload Identity
    // Federation. Cached until near-expiry inside gcp-wif (not per request).
    // No master key needed — there is no stored secret to decrypt.
    try {
      payload.api_key = await mintGcpAccessToken(gcpWifCacheKey(endpoint.id, wif), wif);
    } catch (err) {
      console.warn(
        `[resolve-tenant-parse] failed to mint WIF access token for parse endpoint ` +
          `${parseProviderId}: `,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    return payload;
  }

  // Static path (today): decrypt the stored key/token. Requires the master key.
  const masterKey = getMasterKey();
  if (!masterKey) {
    console.warn(
      "[resolve-tenant-parse] KOJI_MASTER_KEY is not set; skipping parse " +
        "credential decryption. Falling back to the default heavy provider.",
    );
    return null;
  }

  try {
    if (auth!.key_blob) {
      payload.api_key = decrypt(auth!.key_blob, masterKey, tenantId);
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
  /** Provider slug of the resolved endpoint (for the parse-cache fingerprint). */
  providerSlug?: string;
  /** Source `parse_endpoints.id` (for the parse-cache fingerprint). */
  endpointId?: string;
  /** Source endpoint's `updatedAt` ISO string (for the parse-cache fingerprint). */
  endpointUpdatedAt?: string;
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
  scope: RlsScope,
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
      payload = await resolveParseEndpoint(db, scope, opts.parseProviderId);
    } else {
      const found = await pickActiveParseEndpoint(db, scope, opts?.preferProvider ?? null);
      if (found) payload = await resolveParseEndpoint(db, scope, found);
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
  return {
    provider,
    kind: parseDriverKind(payload.provider),
    providerSlug: payload.provider,
    endpointId: payload.endpoint_id,
    endpointUpdatedAt: payload.endpoint_updated_at,
  };
}

/**
 * Back-compat shim: resolve just the provider instance (no kind). Kept for the
 * `byo-parse-providers.md` documented API; new callers that route by content
 * type should use {@link resolveTenantParse}. Returns null when none is
 * configured / no driver exists.
 */
export async function resolveTenantParseProvider(
  db: Db,
  scope: RlsScope,
  opts?: {
    parseProviderId?: string | null;
    preferProvider?: string | null;
  },
): Promise<ParseProvider | null> {
  const resolved = await resolveTenantParse(db, scope, opts);
  return resolved?.provider ?? null;
}
