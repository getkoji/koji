/**
 * gcp-wif dynamic-source tests (oss-288).
 *
 * Covers the programmatic `subject_token_supplier` path that wires Vercel's
 * workload OIDC token (exposed as an env var / `getVercelOidcToken()`, NOT a
 * file/url) into the WIF exchange, plus its env-aware local-dev ADC fallback:
 *
 *   - readGcpWifConfig surfaces the `source` marker (both config shapes).
 *   - Vercel prod path: supplier returns the Vercel OIDC token, credential_source
 *     is stripped (supplier + credential_source are mutually exclusive), the SA
 *     impersonation URL is preserved, and the exchanged token is returned.
 *   - VERCEL_OIDC_TOKEN env var works when getVercelOidcToken() yields nothing.
 *   - Local fallback: with no Vercel token, mints via ADC (GoogleAuth) and
 *     impersonates the target SA when configured.
 *
 * google-auth-library and @vercel/functions/oidc are fully mocked — pure unit
 * tests of the branch/control flow, no network, no real OIDC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mutable test state (mutated per-test to drive each branch) ───────────────
const state = vi.hoisted(() => ({
  stsToken: "sts-tok",
  vercelToken: "vercel-oidc-tok" as string | undefined,
  vercelThrows: false,
}));

// ── Mock google-auth-library ────────────────────────────────────────────────
const m = vi.hoisted(() => {
  const fromJSON = vi.fn((opts: Record<string, unknown>) => ({
    scopes: undefined as unknown,
    _opts: opts,
    credentials: { expiry_date: undefined as number | undefined },
    getAccessToken: vi.fn(async () => ({ token: state.stsToken })),
  }));
  const adcGetAccessToken = vi.fn(async () => ({ token: "adc-tok" }));
  const googleAuthCtor = vi.fn();
  const impersonatedGetAccessToken = vi.fn(async () => ({ token: "imp-tok" }));
  const impersonatedCtor = vi.fn();
  return { fromJSON, adcGetAccessToken, googleAuthCtor, impersonatedGetAccessToken, impersonatedCtor };
});

vi.mock("google-auth-library", () => {
  const adcClient = {
    getAccessToken: m.adcGetAccessToken,
    credentials: { expiry_date: Date.now() + 60 * 60 * 1000 },
    scopes: undefined as unknown,
  };
  class GoogleAuth {
    constructor(opts: unknown) {
      m.googleAuthCtor(opts);
    }
    async getClient() {
      return adcClient;
    }
  }
  class Impersonated {
    credentials = { expiry_date: Date.now() + 60 * 60 * 1000 };
    getAccessToken = m.impersonatedGetAccessToken;
    constructor(opts: unknown) {
      m.impersonatedCtor(opts);
    }
  }
  return {
    ExternalAccountClient: { fromJSON: (opts: Record<string, unknown>) => m.fromJSON(opts) },
    GoogleAuth,
    Impersonated,
  };
});

// ── Mock @vercel/functions/oidc ─────────────────────────────────────────────
vi.mock("@vercel/functions/oidc", () => ({
  getVercelOidcToken: vi.fn(async () => {
    if (state.vercelThrows) throw new Error("no request context");
    return state.vercelToken;
  }),
}));

const { fromJSON, googleAuthCtor, impersonatedCtor } = m;

import { readGcpWifConfig, mintGcpAccessToken, _clearGcpTokenCache } from "./gcp-wif";

const externalAccount = {
  type: "external_account",
  audience:
    "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/koji/providers/oidc",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://sts.googleapis.com/v1/token",
  credential_source: { file: "/var/run/oidc/token" },
};

beforeEach(() => {
  vi.clearAllMocks();
  _clearGcpTokenCache();
  state.stsToken = "sts-tok";
  state.vercelToken = "vercel-oidc-tok";
  state.vercelThrows = false;
  delete process.env.VERCEL_OIDC_TOKEN;
});

describe("readGcpWifConfig — source marker", () => {
  it("parses `source` from the explicit wif block", () => {
    const s = readGcpWifConfig({
      wif: { external_account: externalAccount, source: "vercel" },
    });
    expect(s).not.toBeNull();
    expect(s!.source).toBe("vercel");
  });

  it("parses `source` from the auth_method:wif top-level shape", () => {
    const s = readGcpWifConfig({
      auth_method: "wif",
      external_account: externalAccount,
      source: "vercel",
    });
    expect(s!.source).toBe("vercel");
  });

  it("leaves source undefined for a static credential_source config", () => {
    const s = readGcpWifConfig({ wif: { external_account: externalAccount } });
    expect(s!.source).toBeUndefined();
  });
});

describe("mintGcpAccessToken — Vercel prod path", () => {
  it("supplies the Vercel OIDC token, strips credential_source, keeps impersonation", async () => {
    const token = await mintGcpAccessToken("ep_vercel", {
      externalAccount,
      source: "vercel",
      impersonateServiceAccount: "docai@proj.iam.gserviceaccount.com",
    });
    expect(token).toBe("sts-tok");
    expect(fromJSON).toHaveBeenCalledTimes(1);

    const opts = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    // credential_source must be removed (mutually exclusive with supplier).
    expect(opts.credential_source).toBeUndefined();
    // A programmatic subject_token_supplier is wired in.
    const supplier = opts.subject_token_supplier as {
      getSubjectToken: () => Promise<string>;
    };
    expect(supplier).toBeTruthy();
    await expect(supplier.getSubjectToken()).resolves.toBe("vercel-oidc-tok");
    // Impersonation URL derived from the bare target SA is preserved.
    expect(opts.service_account_impersonation_url).toBe(
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
        "docai%40proj.iam.gserviceaccount.com:generateAccessToken",
    );
    // ADC fallback was NOT used.
    expect(googleAuthCtor).not.toHaveBeenCalled();
    expect(impersonatedCtor).not.toHaveBeenCalled();
  });

  it("falls back to VERCEL_OIDC_TOKEN env var when getVercelOidcToken yields nothing", async () => {
    state.vercelToken = undefined;
    process.env.VERCEL_OIDC_TOKEN = "env-oidc-tok";
    const token = await mintGcpAccessToken("ep_env", { externalAccount, source: "vercel" });
    expect(token).toBe("sts-tok");
    const opts = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    const supplier = opts.subject_token_supplier as { getSubjectToken: () => Promise<string> };
    await expect(supplier.getSubjectToken()).resolves.toBe("env-oidc-tok");
    expect(googleAuthCtor).not.toHaveBeenCalled();
  });

  it("caches the minted token across calls (no re-exchange)", async () => {
    const settings = { externalAccount, source: "vercel" };
    const a = await mintGcpAccessToken("ep_cache_v", settings);
    state.stsToken = "sts-tok-2";
    const b = await mintGcpAccessToken("ep_cache_v", settings);
    expect(a).toBe("sts-tok");
    expect(b).toBe("sts-tok");
    expect(fromJSON).toHaveBeenCalledTimes(1);
  });
});

describe("mintGcpAccessToken — local ADC fallback", () => {
  it("mints via ADC + impersonates the target SA when no Vercel token present", async () => {
    state.vercelThrows = true; // getVercelOidcToken() unavailable (local dev)
    const token = await mintGcpAccessToken("ep_local", {
      externalAccount,
      source: "vercel",
      impersonateServiceAccount: "docai@proj.iam.gserviceaccount.com",
    });
    expect(token).toBe("imp-tok");
    // Did NOT use the STS supplier exchange.
    expect(fromJSON).not.toHaveBeenCalled();
    // Used ADC + impersonation.
    expect(googleAuthCtor).toHaveBeenCalledTimes(1);
    expect(impersonatedCtor).toHaveBeenCalledTimes(1);
    const impOpts = impersonatedCtor.mock.calls[0]![0] as Record<string, unknown>;
    expect(impOpts.targetPrincipal).toBe("docai@proj.iam.gserviceaccount.com");
  });

  it("mints via raw ADC (no impersonation) when no target SA is configured", async () => {
    state.vercelThrows = true;
    const token = await mintGcpAccessToken("ep_local_noimp", {
      externalAccount,
      source: "vercel",
    });
    expect(token).toBe("adc-tok");
    expect(googleAuthCtor).toHaveBeenCalledTimes(1);
    expect(impersonatedCtor).not.toHaveBeenCalled();
    expect(fromJSON).not.toHaveBeenCalled();
  });
});

describe("mintGcpAccessToken — backward compatibility", () => {
  it("uses the standard credential_source path (no source) without a supplier", async () => {
    const token = await mintGcpAccessToken("ep_static", { externalAccount });
    expect(token).toBe("sts-tok");
    const opts = fromJSON.mock.calls[0]![0] as Record<string, unknown>;
    // credential_source preserved, NO supplier injected.
    expect(opts.credential_source).toEqual({ file: "/var/run/oidc/token" });
    expect(opts.subject_token_supplier).toBeUndefined();
    expect(googleAuthCtor).not.toHaveBeenCalled();
  });
});
