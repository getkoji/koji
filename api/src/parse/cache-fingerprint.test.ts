import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARSE_FINGERPRINT,
  parseCacheFingerprint,
  fingerprintStorageSuffix,
  parseCacheStorageKey,
} from "./cache-fingerprint";
import type { ResolvedTenantParse } from "./resolve-tenant-parse";

// Minimal ResolvedTenantParse stub — only the fingerprint fields matter here.
function resolved(over: Partial<ResolvedTenantParse>): ResolvedTenantParse {
  return {
    provider: {} as ResolvedTenantParse["provider"],
    kind: "markdown",
    providerSlug: "google-docai",
    endpointId: "ep-1",
    endpointUpdatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("parseCacheFingerprint", () => {
  it("returns the default fingerprint when no tenant endpoint resolved", () => {
    expect(parseCacheFingerprint(null)).toBe(DEFAULT_PARSE_FINGERPRINT);
  });

  it("returns the default fingerprint when the resolved provider has no endpoint id", () => {
    expect(parseCacheFingerprint(resolved({ endpointId: undefined }))).toBe(
      DEFAULT_PARSE_FINGERPRINT,
    );
  });

  it("is stable for the same provider/endpoint/updatedAt (cache hit)", () => {
    const a = parseCacheFingerprint(resolved({}));
    const b = parseCacheFingerprint(resolved({}));
    expect(a).toBe(b);
  });

  it("differs when the provider slug differs (different provider ⇒ re-parse)", () => {
    const a = parseCacheFingerprint(resolved({ providerSlug: "google-docai" }));
    const b = parseCacheFingerprint(resolved({ providerSlug: "mistral-ocr" }));
    expect(a).not.toBe(b);
  });

  it("differs when the endpoint id differs (different endpoint ⇒ re-parse)", () => {
    const a = parseCacheFingerprint(resolved({ endpointId: "ep-1" }));
    const b = parseCacheFingerprint(resolved({ endpointId: "ep-2" }));
    expect(a).not.toBe(b);
  });

  it("differs when the endpoint updatedAt differs (config edit ⇒ re-parse)", () => {
    const a = parseCacheFingerprint(resolved({ endpointUpdatedAt: "2026-06-01T00:00:00.000Z" }));
    const b = parseCacheFingerprint(resolved({ endpointUpdatedAt: "2026-06-02T00:00:00.000Z" }));
    expect(a).not.toBe(b);
  });

  it("differs from the default fingerprint for any real provider", () => {
    expect(parseCacheFingerprint(resolved({}))).not.toBe(DEFAULT_PARSE_FINGERPRINT);
  });
});

describe("fingerprintStorageSuffix", () => {
  it("maps the default fingerprint to an empty suffix (legacy storage key)", () => {
    expect(fingerprintStorageSuffix(DEFAULT_PARSE_FINGERPRINT)).toBe("");
  });

  it("produces a stable, short, distinct suffix for distinct fingerprints", () => {
    const fpA = parseCacheFingerprint(resolved({ providerSlug: "google-docai" }));
    const fpB = parseCacheFingerprint(resolved({ providerSlug: "mistral-ocr" }));
    const sA = fingerprintStorageSuffix(fpA);
    const sB = fingerprintStorageSuffix(fpB);
    expect(sA).toHaveLength(16);
    expect(sA).toBe(fingerprintStorageSuffix(fpA)); // stable
    expect(sA).not.toBe(sB);
  });
});

describe("parseCacheStorageKey", () => {
  it("keeps the legacy key for the default fingerprint", () => {
    expect(parseCacheStorageKey("t1", "abc", DEFAULT_PARSE_FINGERPRINT)).toBe(
      "cache/t1/abc.json",
    );
  });

  it("namespaces the key by fingerprint suffix for real providers", () => {
    const fp = parseCacheFingerprint(resolved({}));
    const key = parseCacheStorageKey("t1", "abc", fp);
    expect(key).toMatch(/^cache\/t1\/abc\.[0-9a-f]{16}\.json$/);
    expect(key).not.toBe("cache/t1/abc.json");
  });

  it("gives the same file a different key under a different provider (re-parse)", () => {
    const keyA = parseCacheStorageKey("t1", "abc", parseCacheFingerprint(resolved({ endpointId: "ep-1" })));
    const keyB = parseCacheStorageKey("t1", "abc", parseCacheFingerprint(resolved({ endpointId: "ep-2" })));
    expect(keyA).not.toBe(keyB);
  });
});
