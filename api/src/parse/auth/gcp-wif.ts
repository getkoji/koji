/**
 * Keyless GCP access-token minting via Workload Identity Federation (WIF).
 *
 * **Why this exists.** Several BYO-parse providers authenticate to Google Cloud
 * with a short-lived OAuth2 access token (Google Document AI sends
 * `payload.api_key` as a `Bearer` token). Today that token is stored static in
 * the endpoint's encrypted credentials — but a ~1-hour token isn't a durable
 * production credential, and enterprise GCP orgs commonly enforce
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
 * workload to present an OIDC identity the customer's pool trusts. Two ways the
 * source token reaches us:
 *
 *   1. **Static source (`credential_source`)** — a file/URL/executable the
 *      runtime exposes (Cloudflare Workers OIDC, GKE/Cloud Run metadata, a
 *      Koji-managed identity). `ExternalAccountClient.fromJSON` reads it.
 *   2. **Dynamic source (`source: "vercel"`, oss-288)** — some runtimes expose
 *      their workload OIDC token as an **env var / function call**, not a file
 *      or URL. Vercel is the motivating case: the token comes from
 *      `getVercelOidcToken()` / `VERCEL_OIDC_TOKEN`, which `fromJSON`'s standard
 *      `credential_source` cannot consume. For these we build the client with a
 *      programmatic **`subject_token_supplier`** that returns the source token.
 *      The dashboard form (oss-291) persists `{ external_account,
 *      impersonate_service_account }` with **no `source` marker and no
 *      `credential_source`**, so the dynamic path is also **auto-detected**
 *      (oss-292): an `external_account` lacking a consumable `credential_source`
 *      takes the dynamic path without requiring an explicit `source` field. An
 *      explicit static `credential_source` always wins and is never overridden.
 *
 * For the dynamic path, source resolution is **environment-aware** so the same
 * WIF-configured endpoint is exercisable in local dev without a Vercel identity:
 *
 *   - **Prod (Vercel):** the supplier returns the Vercel workload OIDC token
 *     (`getVercelOidcToken()` preferred, `VERCEL_OIDC_TOKEN` fallback) → STS
 *     exchange → SA impersonation.
 *   - **Local dev (no Vercel token):** fall back to **Application Default
 *     Credentials** (`gcloud auth application-default login`) and mint the
 *     access token via ADC, impersonating the same target SA. This lets a
 *     developer drive the real WIF endpoint path locally.
 *
 * This OSS code is generic: the deployer (self-host) or the platform layer
 * (hosted Koji) supplies the `external_account` config + `source` that names its
 * issuer. We never encode Koji's production identity in OSS. See
 * `docs/deployments/parse.md` and the design note in the oss-282 PR for the
 * hosted source-identity decision (needs infra sign-off).
 *
 * **Failure posture.** Minting errors throw — the caller (the parse-endpoint
 * resolver) treats a throw as "credential unavailable" and falls back to the
 * default heavy provider, consistent with how it treats a decryption failure.
 */

import {
  ExternalAccountClient,
  GoogleAuth,
  Impersonated,
  type ExternalAccountClientOptions,
} from "google-auth-library";

/** Default OAuth scope — broad enough for any GCP API the provider may call. */
const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

/**
 * `source` values that mean "the workload OIDC token is exposed dynamically
 * (env var / function call), not via a file/URL `credential_source`." These
 * route to the programmatic `subject_token_supplier` path. Today that's Vercel;
 * the set is open so other env-var-token runtimes can opt in without engine
 * changes.
 */
const DYNAMIC_SOURCES = new Set(["vercel", "vercel-oidc"]);

function isDynamicSource(source: string | undefined): boolean {
  return !!source && DYNAMIC_SOURCES.has(source.toLowerCase());
}

/**
 * Decide whether to take the dynamic-source path (programmatic
 * `subject_token_supplier` + env-aware ADC fallback) instead of the static
 * `credential_source` path:
 *
 *   1. **Explicit dynamic source** (`source: "vercel"`) → always dynamic
 *      (backward compatible — the oss-288 path).
 *   2. **Explicit non-dynamic source** (any other `source` value) → respect it;
 *      use the static `credential_source` path and never auto-override (guardrail).
 *   3. **No `source` marker at all** → auto-detect. The dashboard form
 *      (oss-291) persists `wif = { external_account, impersonate_service_account }`
 *      with **neither** a `source` marker **nor** a `credential_source` — the
 *      workload OIDC token comes from the runtime env (Vercel), not the config.
 *      Such a config can't complete `fromJSON`, so when the external_account has
 *      **no consumable `credential_source`** we take the dynamic path.
 *      `mintViaDynamicSource` then uses the Vercel supplier when a Vercel OIDC
 *      token is present (hosted prod) and falls back to ADC otherwise (local
 *      dev) — so a form-configured keyless endpoint works in both.
 *
 * Static configs that DO carry a consumable `credential_source` (self-host:
 * file/url/executable/AWS) are untouched — they keep the standard fromJSON path.
 */
function shouldUseDynamicSource(settings: GcpWifSettings): boolean {
  if (isDynamicSource(settings.source)) return true;
  if (settings.source) return false; // explicit non-dynamic source → static path
  return !hasConsumableCredentialSource(settings.externalAccount);
}

/**
 * Whether the external_account config carries a source descriptor that
 * `ExternalAccountClient.fromJSON` can consume on its own — a
 * file/url/executable/AWS `credential_source`, or a programmatic
 * `subject_token_supplier` already wired into the config. The form-shaped WIF
 * config carries none of these (the workload OIDC token comes from the runtime
 * env, not the config), which is what triggers auto-detection of the dynamic
 * path. We don't validate the descriptor's full shape — `fromJSON` does that
 * authoritatively; we only check whether a usable key is present.
 */
function hasConsumableCredentialSource(ext: ExternalAccountClientOptions): boolean {
  const e = ext as unknown as Record<string, unknown>;
  if (e.subject_token_supplier ?? e.subjectTokenSupplier) return true;
  const cs = (e.credential_source ?? e.credentialSource) as
    | Record<string, unknown>
    | undefined;
  if (!cs || typeof cs !== "object") return false;
  return Boolean(cs.file ?? cs.url ?? cs.executable ?? cs.environment_id ?? cs.environmentId);
}

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
  /**
   * Optional dynamic-source marker (oss-288). When set to a recognized dynamic
   * source (e.g. `"vercel"`), the workload OIDC token is fetched programmatically
   * (env var / function call) and supplied to STS via a `subject_token_supplier`,
   * rather than read from the config's `credential_source`. Unset → the standard
   * file/URL/executable `credential_source` path (backward compatible).
   */
  source?: string;
}

/**
 * Extract WIF settings from an endpoint's (decrypted) `config_json`, or return
 * null when the endpoint isn't WIF-configured (the static-token / today path).
 *
 * Recognized shapes (in priority order):
 *   1. `config.wif = { external_account, impersonate_service_account?, scopes?,
 *      source? }` — the explicit, recommended block.
 *   2. `config.auth_method === "wif"` with a top-level `config.external_account`.
 *
 * `source` is the optional dynamic-source marker (oss-288): set it to e.g.
 * `"vercel"` when the workload OIDC token is exposed as an env var / function
 * call instead of a file/URL. When unset, the standard `credential_source`
 * path is used (backward compatible).
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
        asString(w.source),
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
        asString(config.source),
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
  source: string | undefined,
): GcpWifSettings {
  return {
    externalAccount,
    ...(impersonateServiceAccount ? { impersonateServiceAccount } : {}),
    ...(scopes ? { scopes } : {}),
    ...(source ? { source } : {}),
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

  // Dynamic source (oss-288/292): the workload OIDC token is exposed as an env
  // var / function call (Vercel), not a file/URL. Engaged either by an explicit
  // `source: "vercel"` marker OR auto-detected when a form-shaped config has no
  // consumable `credential_source` (see {@link shouldUseDynamicSource}). The
  // dynamic path uses a programmatic supplier with an env-aware local-dev ADC
  // fallback. Otherwise: the standard file/URL/executable `credential_source`
  // path via fromJSON (backward compat).
  const minted = shouldUseDynamicSource(settings)
    ? await mintViaDynamicSource(settings, scopes)
    : await mintViaCredentialSource(settings, scopes);

  tokenCache.set(cacheKey, { token: minted.token, expiresAt: minted.expiresAt });
  return minted.token;
}

interface MintedToken {
  token: string;
  /** Epoch ms at which the minted token expires. */
  expiresAt: number;
}

/** Compute an absolute expiry, falling back when the client reports none. */
function expiresAtFrom(expiry: number | null | undefined): number {
  const now = Date.now();
  return typeof expiry === "number" && expiry > now ? expiry : now + FALLBACK_LIFETIME_MS;
}

/**
 * Standard path: the `external_account` config carries a file/URL/executable
 * `credential_source`. `ExternalAccountClient.fromJSON` handles the full
 * OIDC → STS → (optional) SA impersonation exchange. Scopes are passed via the
 * config so they apply to both the STS exchange and the impersonated request.
 */
async function mintViaCredentialSource(
  settings: GcpWifSettings,
  scopes: string[],
): Promise<MintedToken> {
  const options = withImpersonation(settings);
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
  return { token, expiresAt: expiresAtFrom(client.credentials?.expiry_date) };
}

/**
 * Dynamic-source path (oss-288). Resolve the workload OIDC token from the
 * environment and branch:
 *   - **Vercel token present (prod):** build an `ExternalAccountClient` (an
 *     `IdentityPoolClient`) with a `subject_token_supplier` that returns the
 *     Vercel token, then run the standard STS → impersonation exchange.
 *   - **No Vercel token (local dev):** fall back to ADC so the same WIF-
 *     configured endpoint is exercisable without a Vercel identity.
 */
async function mintViaDynamicSource(
  settings: GcpWifSettings,
  scopes: string[],
): Promise<MintedToken> {
  const subjectToken = await resolveVercelOidcToken();

  if (subjectToken) {
    // PROD: feed the Vercel OIDC token to STS via a programmatic supplier.
    // `subject_token_supplier` and `credential_source` are mutually exclusive,
    // so strip any configured credential_source before building the client.
    const base = withImpersonation(settings) as unknown as Record<string, unknown>;
    const { credential_source: _cs, credentialSource: _csCamel, ...rest } = base;
    void _cs;
    void _csCamel;

    const client = ExternalAccountClient.fromJSON({
      ...(rest as unknown as ExternalAccountClientOptions),
      subject_token_supplier: { getSubjectToken: async () => subjectToken },
      scopes,
    });
    if (!client) {
      throw new Error(
        "gcp-wif: Vercel-source external_account config did not yield an " +
          "ExternalAccountClient (check `type`, `audience`, `subject_token_type`, `token_url`)",
      );
    }
    client.scopes = scopes;

    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error("gcp-wif: token exchange returned no access token");
    }
    console.info(
      `[gcp-wif] minted token via Vercel workload OIDC (source=${settings.source ?? "auto-detected"})`,
    );
    return { token, expiresAt: expiresAtFrom(client.credentials?.expiry_date) };
  }

  // LOCAL DEV: no Vercel OIDC token → mint via Application Default Credentials.
  return mintViaAdc(settings, scopes);
}

/**
 * Local-dev fallback: mint an access token via Application Default Credentials
 * (`gcloud auth application-default login`). When a target SA is configured we
 * impersonate it (the dev's ADC identity needs Token Creator on it), exercising
 * the same impersonation target the prod path uses; otherwise the ADC identity's
 * own token is returned.
 */
async function mintViaAdc(settings: GcpWifSettings, scopes: string[]): Promise<MintedToken> {
  const auth = new GoogleAuth({ scopes });
  const sourceClient = await auth.getClient();

  const target = settings.impersonateServiceAccount;
  const client = target
    ? new Impersonated({
        sourceClient,
        targetPrincipal: target,
        targetScopes: scopes,
        lifetime: 3600,
      })
    : sourceClient;

  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error("gcp-wif: ADC fallback returned no access token");
  }
  console.info(
    `[gcp-wif] minted token via local ADC fallback (no Vercel OIDC token present)` +
      (target ? `, impersonating ${target}` : ""),
  );
  return { token, expiresAt: expiresAtFrom(client.credentials?.expiry_date) };
}

/**
 * Resolve the Vercel workload OIDC token. Prefers `@vercel/functions/oidc`'s
 * `getVercelOidcToken()` (reads the request context on Fluid/Functions and
 * falls back to `VERCEL_OIDC_TOKEN` itself), then the raw env var for builds
 * that don't bundle `@vercel/functions` (e.g. self-host). Returns undefined
 * when neither yields a token — the signal to use the local ADC fallback.
 *
 * Exported so the WIF self-serve identity endpoint (`wif-identity.ts`) can
 * decode the *same* token Koji presents to STS and surface its iss/aud/sub to
 * the dashboard — keeping the "what to trust" values and the minting path on a
 * single source of truth.
 */
export async function resolveVercelOidcToken(): Promise<string | undefined> {
  try {
    const mod = await import("@vercel/functions/oidc");
    const fn = (mod as { getVercelOidcToken?: () => string | Promise<string> })
      .getVercelOidcToken;
    if (typeof fn === "function") {
      const raw = fn();
      const tok =
        raw && typeof (raw as Promise<string>).then === "function" ? await raw : raw;
      if (typeof tok === "string" && tok.length > 0) return tok;
    }
  } catch {
    // @vercel/functions absent, or no Vercel request context → fall through.
  }
  const env = process.env.VERCEL_OIDC_TOKEN;
  return typeof env === "string" && env.length > 0 ? env : undefined;
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
  const fingerprint =
    `${typeof audience === "string" ? audience : ""}` +
    `|${settings.impersonateServiceAccount ?? ""}` +
    `|${settings.source ?? ""}`;
  return `${id}::${fingerprint}`;
}

/** Test-only: clear the module token cache. */
export function _clearGcpTokenCache(): void {
  tokenCache.clear();
}
