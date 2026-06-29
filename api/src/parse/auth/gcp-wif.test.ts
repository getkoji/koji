/**
 * gcp-wif tests (oss-282).
 *
 * Covers the keyless Workload Identity Federation token helper:
 *   - readGcpWifConfig recognizes WIF configs (both shapes) and ignores
 *     static-token configs (backward compatibility).
 *   - mintGcpAccessToken mints via google-auth-library's ExternalAccountClient
 *     (mocked — no live STS exchange), and CACHES until near-expiry (no
 *     per-request minting), re-minting once the cached token nears expiry.
 *   - service_account_impersonation_url is injected from a bare target SA only
 *     when the external-account config doesn't already carry one.
 *
 * google-auth-library is fully mocked so this is a pure unit test of the
 * caching / config / impersonation control flow — no network, no real OIDC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock google-auth-library: ExternalAccountClient.fromJSON → fake client ───
let fakeToken = "tok-1";
let fakeExpiry: number | undefined = Date.now() + 60 * 60 * 1000;
let returnNullClient = false;
const getAccessToken = vi.fn(async () => ({ token: fakeToken }));
const fromJSON = vi.fn((opts: Record<string, unknown>) => {
  if (returnNullClient) return null;
  return {
    // The helper assigns `.scopes`; capture the json it was built from.
    scopes: undefined as unknown,
    _opts: opts,
    credentials: { get expiry_date() { return fakeExpiry; } },
    getAccessToken,
  };
});
vi.mock("google-auth-library", () => ({
  ExternalAccountClient: { fromJSON: (opts: Record<string, unknown>) => fromJSON(opts) },
}));

import {
  readGcpWifConfig,
  mintGcpAccessToken,
  gcpWifCacheKey,
  _clearGcpTokenCache,
} from "./gcp-wif";

const externalAccount = {
  type: "external_account",
  audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/koji/providers/oidc",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://sts.googleapis.com/v1/token",
  credential_source: { file: "/var/run/oidc/token" },
};

beforeEach(() => {
  vi.clearAllMocks();
  _clearGcpTokenCache();
  fakeToken = "tok-1";
  fakeExpiry = Date.now() + 60 * 60 * 1000;
  returnNullClient = false;
});

describe("readGcpWifConfig", () => {
  it("returns null for a static-token config (backward compatible)", () => {
    expect(readGcpWifConfig({ project_id: "p", processor_id: "x" })).toBeNull();
    expect(readGcpWifConfig({})).toBeNull();
    expect(readGcpWifConfig(undefined)).toBeNull();
  });

  it("returns null when auth_method is wif but no external_account is present", () => {
    expect(readGcpWifConfig({ auth_method: "wif" })).toBeNull();
  });

  it("parses the explicit `wif` block with target SA + scopes", () => {
    const settings = readGcpWifConfig({
      wif: {
        external_account: externalAccount,
        impersonate_service_account: "docai@proj.iam.gserviceaccount.com",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    });
    expect(settings).not.toBeNull();
    expect(settings!.externalAccount).toEqual(externalAccount);
    expect(settings!.impersonateServiceAccount).toBe("docai@proj.iam.gserviceaccount.com");
    expect(settings!.scopes).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
  });

  it("parses auth_method:wif + top-level external_account", () => {
    const settings = readGcpWifConfig({
      auth_method: "wif",
      external_account: externalAccount,
      impersonate_service_account: "sa@proj.iam.gserviceaccount.com",
    });
    expect(settings).not.toBeNull();
    expect(settings!.externalAccount).toEqual(externalAccount);
    expect(settings!.impersonateServiceAccount).toBe("sa@proj.iam.gserviceaccount.com");
  });
});

describe("mintGcpAccessToken — minting", () => {
  it("mints a token via ExternalAccountClient and sets scopes", async () => {
    const settings = { externalAccount };
    const token = await mintGcpAccessToken("ep_1", settings);
    expect(token).toBe("tok-1");
    expect(fromJSON).toHaveBeenCalledTimes(1);
    // Default scope applied when none configured.
    const builtWith = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    expect(builtWith.scopes).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
  });

  it("passes configured scopes through to the client", async () => {
    await mintGcpAccessToken("ep_scope", {
      externalAccount,
      scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
    });
    const builtWith = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    expect(builtWith.scopes).toEqual(["https://www.googleapis.com/auth/devstorage.read_write"]);
  });

  it("injects service_account_impersonation_url from a bare target SA", async () => {
    await mintGcpAccessToken("ep_imp", {
      externalAccount,
      impersonateServiceAccount: "docai@proj.iam.gserviceaccount.com",
    });
    const builtWith = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    expect(builtWith.service_account_impersonation_url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
        "docai%40proj.iam.gserviceaccount.com:generateAccessToken",
    );
  });

  it("does not override an impersonation URL already in the config", async () => {
    const withUrl = {
      ...externalAccount,
      service_account_impersonation_url: "https://example.test/already-set",
    };
    await mintGcpAccessToken("ep_imp2", {
      externalAccount: withUrl,
      impersonateServiceAccount: "ignored@proj.iam.gserviceaccount.com",
    });
    const builtWith = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    expect(builtWith.service_account_impersonation_url).toBe("https://example.test/already-set");
  });

  it("throws when the external_account config yields no client", async () => {
    returnNullClient = true;
    await expect(mintGcpAccessToken("ep_bad", { externalAccount })).rejects.toThrow(
      /ExternalAccountClient/,
    );
  });

  it("throws when the exchange returns no token", async () => {
    getAccessToken.mockResolvedValueOnce({ token: undefined as unknown as string });
    await expect(mintGcpAccessToken("ep_empty", { externalAccount })).rejects.toThrow(
      /no access token/,
    );
  });
});

describe("mintGcpAccessToken — caching + refresh", () => {
  it("reuses the cached token within the validity window (no re-mint)", async () => {
    const settings = { externalAccount };
    const a = await mintGcpAccessToken("ep_cache", settings);
    fakeToken = "tok-2"; // would change if it re-minted
    const b = await mintGcpAccessToken("ep_cache", settings);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1"); // served from cache
    expect(fromJSON).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the cached token is within the refresh skew of expiry", async () => {
    const settings = { externalAccount };
    // First mint: token expires in 2 minutes — inside the 5-minute refresh skew.
    fakeExpiry = Date.now() + 2 * 60 * 1000;
    const a = await mintGcpAccessToken("ep_refresh", settings);
    expect(a).toBe("tok-1");
    // Second call: cached token is within skew → re-mint.
    fakeToken = "tok-2";
    fakeExpiry = Date.now() + 60 * 60 * 1000;
    const b = await mintGcpAccessToken("ep_refresh", settings);
    expect(b).toBe("tok-2");
    expect(fromJSON).toHaveBeenCalledTimes(2);
  });

  it("keys the cache separately per endpoint", async () => {
    const settings = { externalAccount };
    await mintGcpAccessToken("ep_a", settings);
    fakeToken = "tok-b";
    const b = await mintGcpAccessToken("ep_b", settings);
    expect(b).toBe("tok-b");
    expect(fromJSON).toHaveBeenCalledTimes(2);
  });
});

describe("gcpWifCacheKey", () => {
  it("changes when the audience or target SA changes", () => {
    const base = { externalAccount, impersonateServiceAccount: "a@x.iam" };
    const k1 = gcpWifCacheKey("ep_1", base);
    const k2 = gcpWifCacheKey("ep_1", { ...base, impersonateServiceAccount: "b@x.iam" });
    const k3 = gcpWifCacheKey("ep_1", {
      ...base,
      externalAccount: { ...externalAccount, audience: "//other" },
    });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
