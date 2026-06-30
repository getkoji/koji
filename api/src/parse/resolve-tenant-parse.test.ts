/**
 * resolveTenantParse tests (oss-274 / PB-10).
 *
 * Covers the three load-bearing properties of per-tenant parse resolution:
 *  - DORMANT: no active endpoint, or an endpoint with no registered driver,
 *    resolves to null → the factory falls back to the default heavy provider.
 *  - Pin honored: a pipeline-pinned `parseProviderId` is the id queried.
 *  - Kind: the resolved provider carries its output class (markdown |
 *    structured) so doc-type routing can pick the right SmartParse slot.
 *
 * @koji/db, the driver registry, and envelope crypto are mocked so the test is
 * a pure unit test of the resolution control flow (no DB, no decryption).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseProvider } from "./provider";

// ── Mock drizzle-orm condition builders to capture the queried id ────────────
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
}));

// ── Mock @koji/db: withRLS just runs the callback against a fake query tx ────
const resultQueue: unknown[][] = [];
let capturedWheres: any[] = [];
const tx = {
  select: () => tx,
  from: () => tx,
  where: (cond: unknown) => {
    capturedWheres.push(cond);
    return tx;
  },
  limit: () => Promise.resolve(resultQueue.shift() ?? []),
};
vi.mock("@koji/db", () => ({
  withRLS: (_db: unknown, _tenant: unknown, fn: (t: typeof tx) => unknown) => fn(tx),
  schema: {
    parseEndpoints: {
      id: "id",
      provider: "provider",
      model: "model",
      configJson: "configJson",
      authJson: "authJson",
      status: "status",
    },
  },
}));

// ── Mock the driver registry + crypto ────────────────────────────────────────
vi.mock("./drivers", () => ({
  createParseDriver: vi.fn(),
  parseDriverKind: vi.fn(),
}));
vi.mock("../crypto/envelope", () => ({
  decrypt: vi.fn(() => "decrypted"),
  getMasterKey: vi.fn(() => "master-key"),
}));

// ── Mock the keyless WIF helper (oss-282) ────────────────────────────────────
// Default: not WIF (readGcpWifConfig → null) so the existing static-token tests
// are unaffected. WIF cases opt in by overriding the return value.
vi.mock("./auth/gcp-wif", () => ({
  readGcpWifConfig: vi.fn(() => null),
  mintGcpAccessToken: vi.fn(async () => "minted-wif-token"),
  gcpWifCacheKey: vi.fn(() => "cache-key"),
}));

import { resolveTenantParse, resolveTenantParseProvider } from "./resolve-tenant-parse";
import { createParseDriver, parseDriverKind } from "./drivers";
import { readGcpWifConfig, mintGcpAccessToken } from "./auth/gcp-wif";

const mockCreateDriver = vi.mocked(createParseDriver);
const mockDriverKind = vi.mocked(parseDriverKind);
const mockReadWif = vi.mocked(readGcpWifConfig);
const mockMintToken = vi.mocked(mintGcpAccessToken);

const stubProvider: ParseProvider = { parse: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  capturedWheres = [];
  // Re-establish defaults cleared by clearAllMocks.
  mockReadWif.mockReturnValue(null);
  mockMintToken.mockResolvedValue("minted-wif-token");
});

describe("resolveTenantParse — dormant paths", () => {
  it("returns null when no active parse endpoint exists (no pin)", async () => {
    resultQueue.push([]); // pickActiveParseEndpoint → no row
    const resolved = await resolveTenantParse({} as any, "tenant_1");
    expect(resolved).toBeNull();
    expect(mockCreateDriver).not.toHaveBeenCalled();
  });

  it("returns null when the pinned endpoint is not found", async () => {
    resultQueue.push([]); // resolveParseEndpoint → no row
    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_missing",
    });
    expect(resolved).toBeNull();
  });

  it("returns null when an endpoint exists but no driver is registered", async () => {
    resultQueue.push([
      { id: "pe_1", provider: "mistral-ocr", model: "m", configJson: {}, authJson: { key_blob: "b" } },
    ]);
    mockCreateDriver.mockReturnValue(null); // dormant registry
    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_1",
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the endpoint has no auth (half-configured)", async () => {
    resultQueue.push([
      { id: "pe_1", provider: "mistral-ocr", model: "m", configJson: {}, authJson: null },
    ]);
    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_1",
    });
    expect(resolved).toBeNull();
    expect(mockCreateDriver).not.toHaveBeenCalled();
  });
});

describe("resolveTenantParse — pin + kind", () => {
  it("honors the pinned parseProviderId (queries that exact id)", async () => {
    resultQueue.push([
      { id: "pe_pinned", provider: "google-docai", model: "layout", configJson: {}, authJson: { key_blob: "b" } },
    ]);
    mockCreateDriver.mockReturnValue(stubProvider);
    mockDriverKind.mockReturnValue("structured");

    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_pinned",
    });

    expect(resolved).toMatchObject({ provider: stubProvider, kind: "structured" });
    // The id captured in the WHERE clause is the pin we passed.
    const idWhere = capturedWheres.find((w) => w?.op === "eq" && w?.col === "id");
    expect(idWhere?.val).toBe("pe_pinned");
  });

  it("returns kind=markdown for a markdown-output driver", async () => {
    resultQueue.push([
      { id: "pe_1", provider: "mistral-ocr", model: "m", configJson: {}, authJson: { key_blob: "b" } },
    ]);
    mockCreateDriver.mockReturnValue(stubProvider);
    mockDriverKind.mockReturnValue("markdown");

    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_1",
    });

    expect(resolved?.kind).toBe("markdown");
    expect(mockDriverKind).toHaveBeenCalledWith("mistral-ocr");
  });
});

describe("resolveTenantParse — keyless WIF path (oss-282)", () => {
  const wifSettings = {
    externalAccount: { type: "external_account", audience: "//aud" } as any,
    impersonateServiceAccount: "docai@proj.iam.gserviceaccount.com",
  };

  it("mints a fresh token for a WIF endpoint with NO stored auth", async () => {
    // Keyless: authJson is null, but config_json carries the WIF block.
    resultQueue.push([
      {
        id: "pe_wif",
        provider: "google-docai",
        model: "ocr",
        configJson: { wif: {} },
        authJson: null,
      },
    ]);
    mockReadWif.mockReturnValue(wifSettings);
    let seenPayload: any;
    mockCreateDriver.mockImplementation((p: any) => {
      seenPayload = p;
      return stubProvider;
    });
    mockDriverKind.mockReturnValue("structured");

    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_wif",
    });

    expect(resolved).toMatchObject({ provider: stubProvider, kind: "structured" });
    expect(mockMintToken).toHaveBeenCalledTimes(1);
    // The minted token rides in api_key, so the driver stays credential-agnostic.
    expect(seenPayload.api_key).toBe("minted-wif-token");
  });

  it("uses WIF even when stored auth is also present (WIF wins)", async () => {
    resultQueue.push([
      {
        id: "pe_both",
        provider: "google-docai",
        model: "ocr",
        configJson: { wif: {} },
        authJson: { key_blob: "static-blob" },
      },
    ]);
    mockReadWif.mockReturnValue(wifSettings);
    let seenPayload: any;
    mockCreateDriver.mockImplementation((p: any) => {
      seenPayload = p;
      return stubProvider;
    });
    mockDriverKind.mockReturnValue("structured");

    await resolveTenantParse({} as any, "tenant_1", { parseProviderId: "pe_both" });
    expect(seenPayload.api_key).toBe("minted-wif-token");
  });

  it("returns null when WIF minting fails (falls back to default provider)", async () => {
    resultQueue.push([
      {
        id: "pe_wif_fail",
        provider: "google-docai",
        model: "ocr",
        configJson: { wif: {} },
        authJson: null,
      },
    ]);
    mockReadWif.mockReturnValue(wifSettings);
    mockMintToken.mockRejectedValue(new Error("STS exchange failed"));

    const resolved = await resolveTenantParse({} as any, "tenant_1", {
      parseProviderId: "pe_wif_fail",
    });
    expect(resolved).toBeNull();
    expect(mockCreateDriver).not.toHaveBeenCalled();
  });
});

describe("resolveTenantParseProvider — back-compat shim", () => {
  it("returns just the provider instance", async () => {
    resultQueue.push([
      { id: "pe_1", provider: "mistral-ocr", model: "m", configJson: {}, authJson: { key_blob: "b" } },
    ]);
    mockCreateDriver.mockReturnValue(stubProvider);
    mockDriverKind.mockReturnValue("markdown");

    const provider = await resolveTenantParseProvider({} as any, "tenant_1", {
      parseProviderId: "pe_1",
    });
    expect(provider).toBe(stubProvider);
  });

  it("returns null when nothing resolves", async () => {
    resultQueue.push([]);
    const provider = await resolveTenantParseProvider({} as any, "tenant_1");
    expect(provider).toBeNull();
  });
});
