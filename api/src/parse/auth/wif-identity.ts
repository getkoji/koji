/**
 * Deployment OIDC identity for keyless-WIF self-serve setup.
 *
 * **Why this exists.** To trust Koji's running workload in a customer-owned
 * Google Workload Identity Pool, the customer must configure their OIDC provider
 * with the *exact* identity Koji presents to Google's STS — the token's `iss`
 * (issuer), `aud` (audience), and `sub` (subject). Historically these were
 * handed to each customer by hand ("ask Koji for the issuer/audience values").
 * This module lets the dashboard surface them live instead, so WIF setup is
 * self-serve.
 *
 * **Single source of truth.** The values come from the deployment's OWN
 * workload OIDC token — the very token `gcp-wif.ts` presents during the STS
 * exchange (`resolveVercelOidcToken()` → `getVercelOidcToken()` /
 * `VERCEL_OIDC_TOKEN`). We decode its payload (read-only — we do NOT verify a
 * signature; it's our own token, surfaced for display) and report iss/aud/sub.
 * Because it reads the live token, it is correct for the hosted platform with
 * **nothing hardcoded** — no team slug, project id, or issuer literal lives in
 * source.
 *
 * **Self-host / non-Vercel.** A self-hosted deployment that federates with a
 * different OIDC issuer (its own platform's identity) has no Vercel token. For
 * those, three optional env overrides let the operator surface the right values
 * to their own users:
 *
 *   - `KOJI_WIF_ISSUER`   — the `iss` the deployment's tokens carry
 *   - `KOJI_WIF_AUDIENCE` — the `aud` the deployment's tokens carry
 *   - `KOJI_WIF_SUBJECT`  — the `sub` the deployment's tokens carry
 *
 * When neither a token nor overrides are present (e.g. local dev), the endpoint
 * reports `available: false` so the UI can explain the values aren't resolvable
 * in this environment and link to the manual guide.
 *
 * Engine-generic: this inspects no document fields or domains — it's a
 * deployment-identity helper.
 */

import { resolveVercelOidcToken } from "./gcp-wif";

/** The OIDC identity a customer must trust in their WIF pool/provider. */
export interface WifIdentity {
  /** True when iss/aud/sub were resolvable in this environment. */
  available: boolean;
  /**
   * Where the values came from:
   *   - `"vercel-oidc"` — decoded from the live Vercel workload OIDC token.
   *   - `"configured"`  — supplied via KOJI_WIF_* env overrides (self-host).
   *   - `"none"`        — not resolvable here (no token, no overrides).
   */
  source: "vercel-oidc" | "configured" | "none";
  /** OIDC issuer (`iss`) — the OIDC provider's issuer URI in the WIF pool. */
  issuer: string | null;
  /** OIDC audience (`aud`) — the provider's allowed audience. */
  audience: string | null;
  /** OIDC subject (`sub`) — pin this in the provider's attribute condition. */
  subject: string | null;
}

/**
 * Runtime-agnostic base64url decode (Node 18+ and Cloudflare Workers both
 * expose `atob` + `TextDecoder`). Returns the decoded UTF-8 string, or null on
 * malformed input.
 */
function base64UrlDecode(segment: string): string | null {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's payload claims without verifying its signature. We only read
 * our own deployment's token to display its iss/aud/sub, so verification adds
 * nothing — the token never grants access here. Returns null when the input
 * isn't a well-formed JWT.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Normalize a JWT `aud` claim (string | string[]) to a single display string. */
function normalizeAudience(aud: unknown): string | null {
  if (typeof aud === "string" && aud.length > 0) return aud;
  if (Array.isArray(aud)) {
    const strs = aud.filter((a): a is string => typeof a === "string" && a.length > 0);
    return strs.length > 0 ? strs.join(", ") : null;
  }
  return null;
}

function envOverride(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Resolve the deployment's OIDC identity (iss/aud/sub) for WIF self-serve setup.
 *
 * Order:
 *   1. Live workload OIDC token (hosted / Vercel) → decode iss/aud/sub.
 *   2. KOJI_WIF_* env overrides (self-host with a non-Vercel issuer).
 *   3. Otherwise `available: false`.
 */
export async function resolveWifIdentity(): Promise<WifIdentity> {
  const token = await resolveVercelOidcToken();
  if (token) {
    const claims = decodeJwtClaims(token);
    if (claims) {
      const issuer = typeof claims.iss === "string" ? claims.iss : null;
      const subject = typeof claims.sub === "string" ? claims.sub : null;
      const audience = normalizeAudience(claims.aud);
      if (issuer || subject || audience) {
        return { available: true, source: "vercel-oidc", issuer, audience, subject };
      }
    }
  }

  const issuer = envOverride("KOJI_WIF_ISSUER");
  const audience = envOverride("KOJI_WIF_AUDIENCE");
  const subject = envOverride("KOJI_WIF_SUBJECT");
  if (issuer || audience || subject) {
    return { available: true, source: "configured", issuer, audience, subject };
  }

  return { available: false, source: "none", issuer: null, audience: null, subject: null };
}
