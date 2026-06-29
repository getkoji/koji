/**
 * wif-identity tests (oss-293).
 *
 * Covers the WIF self-serve identity resolver:
 *   - decodeJwtClaims reads a JWT payload (no signature verification) and
 *     rejects malformed input.
 *   - resolveWifIdentity surfaces iss/aud/sub from the deployment's own workload
 *     OIDC token (VERCEL_OIDC_TOKEN), normalizes an array `aud`, falls back to
 *     KOJI_WIF_* env overrides for self-host, and reports unavailable when
 *     neither is present.
 *
 * No network, no real OIDC — we craft tokens locally. `resolveVercelOidcToken`
 * (from gcp-wif) reads `VERCEL_OIDC_TOKEN` when `@vercel/functions` yields no
 * request-context token, which is the path exercised here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// wif-identity imports gcp-wif, which statically imports google-auth-library.
// We never exercise the GCP client here (only the env-var token path), so stub
// it to keep this a pure unit test independent of the heavy auth library.
vi.mock("google-auth-library", () => ({
  ExternalAccountClient: { fromJSON: () => null },
  GoogleAuth: class {},
  Impersonated: class {},
}));

// Neutralize the ambient Vercel request-context token: a dev machine linked to
// a Vercel project exposes a live OIDC token via getVercelOidcToken(), which
// would shadow the VERCEL_OIDC_TOKEN env var these tests set. Force the supplier
// to fall back to the env var so the token source is fully deterministic.
vi.mock("@vercel/functions/oidc", () => ({
  getVercelOidcToken: () => undefined,
}));

import { decodeJwtClaims, resolveWifIdentity } from "./wif-identity";

/** Build an unsigned JWT (header.payload.sig) with the given claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.signature`;
}

const WIF_ENV = [
  "VERCEL_OIDC_TOKEN",
  "KOJI_WIF_ISSUER",
  "KOJI_WIF_AUDIENCE",
  "KOJI_WIF_SUBJECT",
] as const;

describe("decodeJwtClaims", () => {
  it("decodes a JWT payload", () => {
    const token = makeJwt({ iss: "https://oidc.example.com/team", sub: "abc" });
    expect(decodeJwtClaims(token)).toMatchObject({
      iss: "https://oidc.example.com/team",
      sub: "abc",
    });
  });

  it("returns null for malformed input", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
    expect(decodeJwtClaims("")).toBeNull();
    expect(decodeJwtClaims("header.%%%.sig")).toBeNull();
    // A decodable middle segment that isn't JSON → null.
    expect(decodeJwtClaims(`header.${Buffer.from("plain text").toString("base64url")}.sig`)).toBeNull();
  });
});

describe("resolveWifIdentity", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of WIF_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of WIF_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("surfaces iss/aud/sub from the deployment OIDC token", async () => {
    process.env.VERCEL_OIDC_TOKEN = makeJwt({
      iss: "https://oidc.vercel.com/acme",
      aud: "https://vercel.com/acme",
      sub: "owner:acme:project:koji:environment:production",
    });
    const id = await resolveWifIdentity();
    expect(id).toEqual({
      available: true,
      source: "vercel-oidc",
      issuer: "https://oidc.vercel.com/acme",
      audience: "https://vercel.com/acme",
      subject: "owner:acme:project:koji:environment:production",
    });
  });

  it("normalizes an array audience to a joined string", async () => {
    process.env.VERCEL_OIDC_TOKEN = makeJwt({
      iss: "https://issuer",
      aud: ["aud-a", "aud-b"],
      sub: "s",
    });
    const id = await resolveWifIdentity();
    expect(id.audience).toBe("aud-a, aud-b");
  });

  it("falls back to KOJI_WIF_* env overrides for self-host", async () => {
    process.env.KOJI_WIF_ISSUER = "https://self-host-issuer";
    process.env.KOJI_WIF_AUDIENCE = "self-host-aud";
    process.env.KOJI_WIF_SUBJECT = "self-host-sub";
    const id = await resolveWifIdentity();
    expect(id).toEqual({
      available: true,
      source: "configured",
      issuer: "https://self-host-issuer",
      audience: "self-host-aud",
      subject: "self-host-sub",
    });
  });

  it("reports unavailable when no token and no overrides are present", async () => {
    const id = await resolveWifIdentity();
    expect(id).toEqual({
      available: false,
      source: "none",
      issuer: null,
      audience: null,
      subject: null,
    });
  });
});
