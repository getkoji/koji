/**
 * Build/test-mode parse-provider resolution (oss-299).
 *
 * The build page parses through `POST /api/extract/run`. Before oss-299 that
 * path always used the system default parse provider (docling), so testing a
 * configured BYO endpoint (Google/Mistral/etc.) silently parsed with docling —
 * violating "test mode must match production".
 *
 * `resolveBuildParse` is the helper the route now uses to resolve the tenant's
 * parse provider the same way the production ingestion path does
 * (`resolveTenantParse` + `buildEffectiveParseProvider`). These tests pin:
 *   1. configured endpoint → build mode uses THAT provider + a provider-aware
 *      cache fingerprint (not the default), and
 *   2. dormant fallback → no endpoint / no parseConfig / resolution error all
 *      return the EXACT default provider + the default fingerprint, byte-for-byte
 *      identical to before BYO parse.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// resolveTenantParse hits the DB; mock it so we can drive the resolution result.
vi.mock("../parse/resolve-tenant-parse", () => ({
  resolveTenantParse: vi.fn(),
}));

import { resolveBuildParse } from "./extract";
import { resolveTenantParse } from "../parse/resolve-tenant-parse";
import { DEFAULT_PARSE_FINGERPRINT } from "../parse/cache-fingerprint";
import type { ParseConfig } from "../parse/factory";
import type { ParseProvider } from "../parse/provider";
import type { ResolvedTenantParse } from "../parse/resolve-tenant-parse";

const mockResolveTenantParse = vi.mocked(resolveTenantParse);

const dockerConfig: ParseConfig = { backend: "docker", dockerUrl: "http://parse:8000" };
const defaultProvider: ParseProvider = {
  parse: async () => ({ markdown: "default", pages: 0, ocr_skipped: false, engine: "docling" }),
};
const tenantProvider: ParseProvider = {
  parse: async () => ({ markdown: "byo", pages: 0, ocr_skipped: false, engine: "docling" }),
};
const fakeDb = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Skip the chunk wrapper so the rebuilt provider is the bare SmartParseProvider.
  process.env.KOJI_CHUNK_PARSE_THRESHOLD = "0";
});

describe("resolveBuildParse — configured endpoint (test == production)", () => {
  it("uses the tenant's resolved provider (not the default) when an endpoint resolves", async () => {
    const resolved: ResolvedTenantParse = {
      provider: tenantProvider,
      kind: "markdown",
      providerSlug: "google-docai",
      endpointId: "pe_42",
      endpointUpdatedAt: "2026-06-29T00:00:00.000Z",
    };
    mockResolveTenantParse.mockResolvedValue(resolved);

    const { provider, fingerprint } = await resolveBuildParse(
      fakeDb,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );

    // A fresh provider was built around the tenant's BYO provider — NOT default.
    expect(provider).not.toBe(defaultProvider);
    expect(typeof provider.parse).toBe("function");
    // Provider-aware cache key (oss-298) — keyed under the resolved endpoint.
    expect(fingerprint).toBe("google-docai:pe_42:2026-06-29T00:00:00.000Z");
    expect(fingerprint).not.toBe(DEFAULT_PARSE_FINGERPRINT);
  });

  it("forwards a pipeline-pinned parse_provider_id to resolveTenantParse", async () => {
    mockResolveTenantParse.mockResolvedValue(null);

    await resolveBuildParse(fakeDb, "tenant_1", defaultProvider, dockerConfig, "pe_pinned");

    expect(mockResolveTenantParse).toHaveBeenCalledWith(fakeDb, "tenant_1", {
      parseProviderId: "pe_pinned",
    });
  });
});

describe("resolveBuildParse — dormant-until-configured fallback", () => {
  it("returns the EXACT default provider + default fingerprint when no endpoint resolves", async () => {
    mockResolveTenantParse.mockResolvedValue(null);

    const { provider, fingerprint } = await resolveBuildParse(
      fakeDb,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );

    expect(provider).toBe(defaultProvider); // identity — zero behavior change
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    expect(mockResolveTenantParse).toHaveBeenCalledWith(fakeDb, "tenant_1", {
      parseProviderId: null,
    });
  });

  it("returns the default provider and skips resolution when parseConfig is null", async () => {
    const { provider, fingerprint } = await resolveBuildParse(
      fakeDb,
      "tenant_1",
      defaultProvider,
      null,
    );

    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    // No parseConfig → no way to rebuild → never touch the DB.
    expect(mockResolveTenantParse).not.toHaveBeenCalled();
  });

  it("falls back to the default provider when resolution throws", async () => {
    mockResolveTenantParse.mockRejectedValue(new Error("decrypt failed"));

    const { provider, fingerprint } = await resolveBuildParse(
      fakeDb,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );

    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
  });
});
