/**
 * HTTP-layer test for GET /api/parse-providers/wif-identity (oss-293).
 *
 * Verifies the self-serve trust endpoint is wired into the router, gated by
 * `endpoint:read`, and returns the deployment's decoded OIDC identity. The
 * resolution logic itself is unit-tested in parse/auth/wif-identity.test.ts;
 * here we confirm the route + auth contract the dashboard depends on.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import type { Permission } from "../auth/roles";

// gcp-wif (imported transitively) statically imports google-auth-library; stub
// it so the test doesn't require the heavy lib. And neutralize any ambient
// Vercel request-context token so the VERCEL_OIDC_TOKEN env var is the source.
vi.mock("google-auth-library", () => ({
  ExternalAccountClient: { fromJSON: () => null },
  GoogleAuth: class {},
  Impersonated: class {},
}));
vi.mock("@vercel/functions/oidc", () => ({ getVercelOidcToken: () => undefined }));

import { parseProviders } from "./parse-providers";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
}

/** Mount the router behind a middleware that injects the given grants. */
function appWithGrants(grants: Permission[]) {
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("grants", new Set(grants));
    await next();
  });
  app.route("/", parseProviders);
  return app;
}

describe("GET /parse-providers/wif-identity", () => {
  it("returns the decoded deployment OIDC identity with endpoint:read", async () => {
    const prev = process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL_OIDC_TOKEN = makeJwt({
      iss: "https://oidc.vercel.com/acme",
      aud: "https://vercel.com/acme",
      sub: "owner:acme:project:koji:environment:production",
    });
    try {
      const res = await appWithGrants(["endpoint:read"]).request("/wif-identity");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        available: true,
        source: "vercel-oidc",
        issuer: "https://oidc.vercel.com/acme",
        audience: "https://vercel.com/acme",
        subject: "owner:acme:project:koji:environment:production",
      });
    } finally {
      if (prev === undefined) delete process.env.VERCEL_OIDC_TOKEN;
      else process.env.VERCEL_OIDC_TOKEN = prev;
    }
  });

  it("is gated — 403 without endpoint:read", async () => {
    const res = await appWithGrants([]).request("/wif-identity");
    expect(res.status).toBe(403);
  });
});
