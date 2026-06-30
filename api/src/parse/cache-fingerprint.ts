/**
 * Parse-cache provider fingerprint (oss-298).
 *
 * The parse cache is keyed by `(tenantId, fileHash, providerFingerprint)`. The
 * fingerprint captures the identity of the resolved parse provider so that
 * switching providers — or editing a provider's output-affecting config —
 * busts the cache instead of returning the previous provider's stale markdown.
 *
 * Bug it fixes: with a `(tenantId, fileHash)`-only key, re-running a doc after
 * configuring/switching a parse provider returned the OLD provider's cached
 * markdown (e.g. Google Doc AI configured, but the cache still served the
 * earlier docling parse → bad extraction).
 */

import crypto from "node:crypto";

import type { ResolvedTenantParse } from "./resolve-tenant-parse";

/** Stable fingerprint for the system default heavy provider (no BYO endpoint). */
export const DEFAULT_PARSE_FINGERPRINT = "default";

/**
 * Stable fingerprint of a resolved parse provider for cache keying.
 *
 * Captures what affects parse output:
 *   - the provider slug,
 *   - the source endpoint id, and
 *   - the endpoint's `updatedAt` (so editing the endpoint's config re-parses).
 *
 * Returns {@link DEFAULT_PARSE_FINGERPRINT} when no tenant endpoint resolved
 * (the system default heavy provider is used unchanged).
 */
export function parseCacheFingerprint(resolved: ResolvedTenantParse | null): string {
  if (!resolved || !resolved.endpointId) return DEFAULT_PARSE_FINGERPRINT;
  return [resolved.providerSlug ?? "", resolved.endpointId, resolved.endpointUpdatedAt ?? ""].join(":");
}

/**
 * Path-safe suffix for the cache storage key derived from a fingerprint.
 *
 * The default fingerprint maps to an empty suffix so default-provider entries
 * keep the historical `cache/<tenant>/<fileHash>.json` storage key (old blobs
 * remain readable). Non-default fingerprints get a short content hash so two
 * providers parsing the same file don't overwrite each other's blob.
 */
export function fingerprintStorageSuffix(fingerprint: string): string {
  if (fingerprint === DEFAULT_PARSE_FINGERPRINT) return "";
  return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

/**
 * Build the cache storage key for a (tenant, fileHash, fingerprint) tuple.
 * Default provider → `cache/<tenant>/<fileHash>.json`; otherwise
 * `cache/<tenant>/<fileHash>.<suffix>.json`.
 */
export function parseCacheStorageKey(
  tenantId: string,
  fileHash: string,
  fingerprint: string,
): string {
  const suffix = fingerprintStorageSuffix(fingerprint);
  return suffix
    ? `cache/${tenantId}/${fileHash}.${suffix}.json`
    : `cache/${tenantId}/${fileHash}.json`;
}
