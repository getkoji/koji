/**
 * DAG-runner per-tenant parse resolution tests (oss-284).
 *
 * The DAG/pipeline runner must resolve the tenant's BYO parse provider the same
 * way `handleIngestionProcess` and build mode do — honoring a pipeline-pinned
 * `parse_provider_id`, falling back to the default provider when nothing is
 * configured (dormant-until-configured), and keying the parse cache under the
 * resolved provider's fingerprint (oss-298).
 *
 * `resolveTenantParse` is mocked so this is a pure unit test of the runner's
 * resolution control flow (no DB, no decryption, no driver registry).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseProvider } from "../parse/provider";
import type { ResolvedTenantParse } from "../parse/resolve-tenant-parse";
import type { ParseConfig } from "../parse/factory";
import { DEFAULT_PARSE_FINGERPRINT } from "../parse/cache-fingerprint";

// Mock the tenant-parse resolver so we control what the runner "finds".
const resolveTenantParseMock = vi.fn<
  (db: unknown, tenantId: string, opts: { parseProviderId: string | null }) => Promise<ResolvedTenantParse | null>
>();
vi.mock("../parse/resolve-tenant-parse", () => ({
  resolveTenantParse: (db: unknown, tenantId: string, opts: { parseProviderId: string | null }) =>
    resolveTenantParseMock(db, tenantId, opts),
}));

import { resolveDagParse } from "./dag-runner";

const dockerConfig: ParseConfig = { backend: "docker", dockerUrl: "http://parse:8000" };
const defaultProvider: ParseProvider = {
  parse: async () => ({ markdown: "default", pages: 1, ocr_skipped: false, engine: "docling" }),
};
const tenantProvider: ParseProvider = {
  parse: async () => ({ markdown: "tenant", pages: 1, ocr_skipped: false, engine: "mistral-ocr" }),
};

beforeEach(() => {
  resolveTenantParseMock.mockReset();
  // Skip the chunk wrapper so the rebuilt provider is the SmartParseProvider.
  process.env.KOJI_CHUNK_PARSE_THRESHOLD = "0";
});

describe("resolveDagParse — dormant-until-configured", () => {
  it("returns the EXACT default provider + default fingerprint when no parseConfig", async () => {
    const { provider, fingerprint } = await resolveDagParse(
      {} as never,
      "tenant_1",
      defaultProvider,
      null,
    );
    expect(provider).toBe(defaultProvider); // identity — zero behavior change
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    // With no parseConfig the runner must not even attempt resolution.
    expect(resolveTenantParseMock).not.toHaveBeenCalled();
  });

  it("returns the default provider when the tenant has no parse endpoint", async () => {
    resolveTenantParseMock.mockResolvedValue(null);
    const { provider, fingerprint } = await resolveDagParse(
      {} as never,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );
    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    expect(resolveTenantParseMock).toHaveBeenCalledWith({}, "tenant_1", { parseProviderId: null });
  });

  it("falls back to the default provider when resolution throws", async () => {
    resolveTenantParseMock.mockRejectedValue(new Error("boom"));
    const { provider, fingerprint } = await resolveDagParse(
      {} as never,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );
    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
  });
});

describe("resolveDagParse — configured provider", () => {
  it("rebuilds a non-default provider + provider-aware fingerprint when one resolves", async () => {
    resolveTenantParseMock.mockResolvedValue({
      provider: tenantProvider,
      kind: "markdown",
      providerSlug: "mistral-ocr",
      endpointId: "pe_42",
      endpointUpdatedAt: "2026-06-27T00:00:00.000Z",
    });
    const { provider, fingerprint } = await resolveDagParse(
      {} as never,
      "tenant_1",
      defaultProvider,
      dockerConfig,
    );
    expect(provider).not.toBe(defaultProvider); // a fresh wrapper around the tenant provider
    expect(typeof provider.parse).toBe("function");
    expect(fingerprint).not.toBe(DEFAULT_PARSE_FINGERPRINT); // keyed under the resolved provider
  });

  it("honors a pipeline-pinned parse_provider_id", async () => {
    resolveTenantParseMock.mockResolvedValue({ provider: tenantProvider, kind: "structured" });
    await resolveDagParse({} as never, "tenant_1", defaultProvider, dockerConfig, "pe_42");
    expect(resolveTenantParseMock).toHaveBeenCalledWith({}, "tenant_1", { parseProviderId: "pe_42" });
  });
});
