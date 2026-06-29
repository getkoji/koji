/**
 * Keyless GCP access-token minting via Workload Identity Federation (WIF).
 *
 * **Why this exists.** Several BYO-parse providers authenticate to Google Cloud
 * with a short-lived OAuth2 access token (Google Document AI sends
 * `payload.api_key` as a `Bearer` token). Today that token is stored static in
 * the endpoint's encrypted credentials — but a ~1-hour token isn't a durable
 * production credential, and enterprises (e.g. Superkey's GCP org) enforce
 * `iam.disableServiceAccountKeyCreation`, so a downloaded service-account JSON
 * key isn't an option either. The enterprise-correct pattern is **keyless
 * Workload Identity Federation**: the hosted workload presents its own OIDC
 * identity, a customer-owned WIF pool trusts that identity, and Google's STS
 * exchanges it for a short-lived federated token that then impersonates a
 * target service account.
 *
 * **What this module does.** Given a WIF settings blob (a standard Google
 * `external_account` credential config + an optional impersonation target), it
 * mints a fresh access token at call time and **caches it until near-expiry**,
 * refreshing only when the cached token is within the refresh skew of expiring.
 * It never mints per request. The OIDC→STS→impersonation exchange and refresh
 * are delegated entirely to `google-auth-library`'s {@link ExternalAccountClient}
 * — we do NOT hand-roll the STS token exchange.
 *
 * **Provider-agnostic by design.** This is a GCP-credential helper, not a
 * Document-AI helper: it mints a `cloud-platform`-scoped token (override via
 * `scopes`) that works for any GCP API, so any GCP-based parse provider can use
 * it. It inspects no document fields or domains — it stays inside the
 * engine-generic rule.
 *
 * **The hosted source identity is NOT baked in here.** WIF requires the
 * workload to present an OIDC identity the customer's pool trusts. That source
 * identity is driven entirely by the `credential_source` of the supplied
 * `external_account` config (a file/URL/executable the runtime exposes —
 * Cloudflare Workers OIDC, Vercel OIDC, or a Koji-managed identity). This OSS
 * code is generic: the deployer (self-host) or the platform layer (hosted Koji)
 * supplies the `external_account` config that names its issuer. We never encode
 * Koji's production identity in OSS. See `docs/deployments/parse.md` and the
 * design note in the oss-282 PR for the hosted source-identity decision (needs
 * infra sign-off).
 *
 * **Failure posture.** Minting errors throw — the caller (the parse-endpoint
 * resolver) treats a throw as "credential unavailable" and falls back to the
 * default heavy provider, consistent with how it treats a decryption failure.
 */

import { ExternalAccountClient, type ExternalAccountClientOptions } from "google-auth-library";

/** Default OAuth scope — broad enough for any GCP API the provider may call. */
const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

/**
 * Re-mint when the cached token is within this many ms of expiry. A generous
 * skew (5 min) absorbs clock drift and request latency so an in-flight call
 * never carries a token that expires mid-request.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Fallback token lifetime (ms) when the auth client doesn't report an
 * `expiry_date`. Google access tokens are ~1h; we under-estimate to 55 min so
 * we refresh early rather than risk a stale token.
 */
const FALLBACK_LIFETIME_MS = 55 * 60 * 1000;

/**
 * WIF settings resolved from an endpoint's `config_json`. The
 * `externalAccount` blob is the *standard* Google external-account credential
 * config (the same JSON you'd otherwise point `GOOGLE_APPLICATION_CREDENTIALS`
 * at) — it is keyless by design: it references the workload's OIDC token
 * source, not a downloaded secret.
 */
export interface GcpWifSettings {
  /** Standard Google `external_account` credential config (type: external_account). */
  externalAccount: ExternalAccountClientOptions;
  /**
   * Service account to impersonate. Used to derive
   * `service_account_impersonation_url` when the external-account config
   * doesn't already carry one.
   */
  impersonateServiceAccount?: string;
  /** OAuth scopes for the minted token. Defaults to cloud-platform. */
  scopes?: string[];
}

/**
 * Extract WIF settings from an endpoint's (decrypted) `config_json`, or return
 * null when the endpoint isn't WIF-configured (the static-token / today path).
 *
 * Recognized shapes (in priority order):
 *   1. `config.wif = { external_account, impersonate_service_account?, scopes? }`
 *      — the explicit, recommended block.
 *   2. `config.auth_method === "wif"` with a top-level `config.external_account`.
 *
 * A config carrying neither is not WIF → returns null so the resolver keeps
 * using the static token. This is what makes WIF *additive*: existing
 * static-token endpoints have no WIF block and are untouched.
 */
export function readGcpWifConfig(
  config: Record<string, unknown> | undefined | null,
): GcpWifSettings | null {
  if (!config || typeof config !== "object") return null;

  // Shape 1: explicit `wif` block.
  const wifBlock = config.wif;
  if (wifBlock && typeof wifBlock === "object") {
    const w = wifBlock as Record<string, unknown>;
    const ext = w.external_account ?? w.externalAccount;
    if (isExternalAccountConfig(ext)) {
      return buildSettings(
        ext,
        asString(w.impersonate_service_account ?? w.impersonateServiceAccount),
        asStringArray(w.scopes),
      );
    }
  }

  // Shape 2: `auth_method: "wif"` + top-level external_account.
  if (config.auth_method === "wif" || config.authMethod === "wif") {
    const ext = config.external_account ?? config.externalAccount;
    if (isExternalAccountConfig(ext)) {
      return buildSettings(
        ext,
        asString(config.impersonate_service_account ?? config.impersonateServiceAccount),
        asStringArray(config.scopes),
      );
    }
  }

  return null;
}

/**
 * A valid external-account config is an object whose `type` is
 * `external_account`. We don't validate the full shape — `google-auth-library`
 * does that authoritatively when the client is built.
 */
function isExternalAccountConfig(v: unknown): v is ExternalAccountClientOptions {
  return (
    !!v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).type === "external_account"
  );
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === "string" && s.length > 0);
  return out.length > 0 ? out : undefined;
}

function buildSettings(
  externalAccount: ExternalAccountClientOptions,
  impersonateServiceAccount: string | undefined,
  scopes: string[] | undefined,
): GcpWifSettings {
  return {
    externalAccount,
    ...(impersonateServiceAccount ? { impersonateServiceAccount } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Token cache — keyed per logical credential so we mint once and refresh on a
// near-expiry boundary, never per request.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Mint (or return a cached) short-lived GCP access token for a WIF credential.
 *
 * @param cacheKey  Stable identity for this credential (e.g. the
 *                  `parse_endpoints` row id). Token reuse + refresh are scoped
 *                  to this key. Callers SHOULD fold the config fingerprint into
 *                  the key so a config change forces a fresh mint
 *                  (see {@link gcpWifCacheKey}).
 * @param settings  Resolved WIF settings (from {@link readGcpWifConfig}).
 * @returns         A valid bearer access token.
 * @throws          When the external-account client can't be built or the
 *                  STS / impersonation exchange fails.
 */
export async function mintGcpAccessToken(
  cacheKey: string,
  settings: GcpWifSettings,
): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt - REFRESH_SKEW_MS) {
    return cached.token;
  }

  const scopes = settings.scopes && settings.scopes.length > 0 ? settings.scopes : DEFAULT_SCOPES;
  const options = withImpersonation(settings);

  // ExternalAccountClient handles the full OIDC → STS → (optional) SA
  // impersonation exchange. We pass scopes via the config so they apply to both
  // the STS exchange and the impersonated-token request.
  const client = ExternalAccountClient.fromJSON({ ...options, scopes });
  if (!client) {
    throw new Error(
      "gcp-wif: external_account config did not yield an ExternalAccountClient " +
        "(check `type`, `audience`, `subject_token_type`, `token_url`, `credential_source`)",
    );
  }
  client.scopes = scopes;

  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("gcp-wif: token exchange returned no access token");
  }

  const expiry = client.credentials?.expiry_date;
  const expiresAt = typeof expiry === "number" && expiry > now ? expiry : now + FALLBACK_LIFETIME_MS;
  tokenCache.set(cacheKey, { token, expiresAt });

  return token;
}

/**
 * Inject `service_account_impersonation_url` from a bare target SA when the
 * external-account config doesn't already specify one. If the config carries
 * its own impersonation URL (the standard authored form), it wins and the
 * explicit target is ignored.
 */
function withImpersonation(settings: GcpWifSettings): ExternalAccountClientOptions {
  const ext = settings.externalAccount;
  if (ext.service_account_impersonation_url || !settings.impersonateServiceAccount) {
    return ext;
  }
  const sa = settings.impersonateServiceAccount;
  return {
    ...ext,
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
      `${encodeURIComponent(sa)}:generateAccessToken`,
  };
}

/**
 * Build a cache key that changes when the credential's identity OR its config
 * changes, so rotating the WIF config forces a fresh mint instead of serving a
 * token minted under the old config.
 */
export function gcpWifCacheKey(endpointId: string | undefined, settings: GcpWifSettings): string {
  const id = endpointId ?? "no-endpoint";
  const audience = (settings.externalAccount as unknown as Record<string, unknown>).audience;
  const fingerprint = `${typeof audience === "string" ? audience : ""}|${settings.impersonateServiceAccount ?? ""}`;
  return `${id}::${fingerprint}`;
}

/** Test-only: clear the module token cache. */
export function _clearGcpTokenCache(): void {
  tokenCache.clear();
}
