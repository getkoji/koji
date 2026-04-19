import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires, getTenantId, getPrincipal } from "./middleware";
import type { AuthAdapter, Principal, Session } from "./adapter";
import type { Env } from "../env";

function createMockAdapter(
  users: Map<string, Principal> = new Map(),
): AuthAdapter {
  return {
    async resolve(token: string) {
      return users.get(token) ?? null;
    },
    async createSession(userId: string): Promise<Session> {
      return { token: `sess_${userId}`, expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

/**
 * Build a test app with a fake DB that returns configured tenants/memberships.
 * The fake DB intercepts the drizzle query chain used by the auth middleware.
 */
function createTestApp(opts: {
  users?: Map<string, Principal>;
  memberships?: Map<string, { roles: string[] }>; // key: `${userId}:${tenantId}`
  tenants?: Map<string, string>; // slug → id
}) {
  const adapter = createMockAdapter(opts.users ?? new Map());
  const app = new Hono<Env>();

  // Track state so the mock can figure out which table is being queried
  app.use("*", async (c, next) => {
    let queryIndex = 0;

    // The middleware issues exactly 2 queries for tenant-scoped routes:
    // 1. SELECT from tenants WHERE slug = x-koji-tenant
    // 2. SELECT from memberships WHERE userId = principal.userId AND tenantId = resolved
    //
    // We return the right mock data based on call order.
    const fakeChain = () => {
      const idx = queryIndex++;
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => {
          if (idx === 0) {
            // Tenant lookup
            const slug = c.req.header("x-koji-tenant");
            const tenantId = opts.tenants?.get(slug ?? "");
            return tenantId ? [{ id: tenantId }] : [];
          }
          if (idx === 1) {
            // Membership lookup
            const principal = c.get("principal") as Principal | undefined;
            const tenantId = c.get("tenantId") as string | undefined;
            if (principal && tenantId) {
              const key = `${principal.userId}:${tenantId}`;
              const m = opts.memberships?.get(key);
              return m ? [m] : [];
            }
            return [];
          }
          return [];
        },
      };
      return chain;
    };

    c.set("db", { select: fakeChain } as any);
    await next();
  });

  app.use("*", authMiddleware(adapter));
  return app;
}

describe("authMiddleware", () => {
  const validUser: Principal = { userId: "u1", email: "test@koji.dev", name: "Test" };
  const users = new Map([["valid-token", validUser]]);
  const tenants = new Map([["acme", "t1"]]);

  it("allows public paths without auth", async () => {
    const app = createTestApp({});
    app.get("/health", (c) => c.json({ ok: true }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("returns 401 for missing token", async () => {
    const app = createTestApp({});
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas");
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    const app = createTestApp({ users });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=bad-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when x-koji-tenant is missing for tenant-scoped routes", async () => {
    const app = createTestApp({ users });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown tenant slug", async () => {
    const app = createTestApp({ users, tenants });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when user is not a member", async () => {
    const app = createTestApp({ users, tenants, memberships: new Map() });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" },
    });
    expect(res.status).toBe(403);
  });

  it("sets principal + tenantId for valid member", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/schemas", (c) => {
      return c.json({ userId: getPrincipal(c).userId, tenantId: getTenantId(c) });
    });
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.userId).toBe("u1");
    expect(body.tenantId).toBe("t1");
  });

  it("allows /api/me without x-koji-tenant", async () => {
    const app = createTestApp({ users });
    app.get("/api/me", (c) => c.json({ userId: getPrincipal(c).userId }));
    const res = await app.request("/api/me", {
      headers: { Cookie: "koji_session=valid-token" },
    });
    expect(res.status).toBe(200);
  });

  it("allows /api/tenants without x-koji-tenant", async () => {
    const app = createTestApp({ users });
    app.get("/api/tenants", (c) => c.json({ data: [] }));
    const res = await app.request("/api/tenants", {
      headers: { Cookie: "koji_session=valid-token" },
    });
    expect(res.status).toBe(200);
  });

  it("/api/me bypass does NOT match /api/members", async () => {
    // Regression: startsWith("/api/me") was matching "/api/members",
    // skipping tenant resolution and leaving grants unset → 403
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/members", requires("member:read"), (c) => c.json({ ok: true }));

    // Without tenant header → should get 400 (missing header), not bypass to no-tenant path
    const noHeader = await app.request("/api/members", {
      headers: { Cookie: "koji_session=valid-token" },
    });
    expect(noHeader.status).toBe(400);

    // With tenant header → should resolve tenant + grants normally
    const withHeader = await app.request("/api/members", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" },
    });
    expect(withHeader.status).toBe(200);
  });
});

describe("requires() middleware", () => {
  const validUser: Principal = { userId: "u1", email: "test@koji.dev", name: "Test" };
  const users = new Map([["valid-token", validUser]]);
  const tenants = new Map([["acme", "t1"]]);
  const headers = { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" };

  it("allows when user has the required permission", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/schemas", requires("schema:read"), (c) => c.json({ ok: true }));
    const res = await app.request("/api/schemas", { headers });
    expect(res.status).toBe(200);
  });

  it("returns 403 when user lacks the permission", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/schemas", requires("schema:write"), (c) => c.json({ ok: true }));
    const res = await app.request("/api/schemas", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
    expect(body.message).toContain("schema:write");
  });

  it("viewer: read yes, write no, deploy no", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/schemas", requires("schema:read"), (c) => c.json({ ok: true }));
    app.post("/api/schemas", requires("schema:write"), (c) => c.json({ ok: true }));
    app.post("/api/deploy", requires("schema:deploy"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/schemas", { headers })).status).toBe(200);
    expect((await app.request("/api/schemas", { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await app.request("/api/deploy", { method: "POST", headers, body: "{}" })).status).toBe(403);
  });

  it("schema-editor: write yes, deploy no", async () => {
    const memberships = new Map([["u1:t1", { roles: ["schema-editor"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/schemas", requires("schema:write"), (c) => c.json({ ok: true }));
    app.post("/api/deploy", requires("schema:deploy"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/schemas", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await app.request("/api/deploy", { method: "POST", headers, body: "{}" })).status).toBe(403);
  });

  it("owner can do everything", async () => {
    const memberships = new Map([["u1:t1", { roles: ["owner"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/tenant", requires("tenant:delete"), (c) => c.json({ ok: true }));
    app.post("/api/invites", requires("member:invite"), (c) => c.json({ ok: true }));
    app.post("/api/deploy", requires("schema:deploy"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/tenant", { method: "DELETE", headers })).status).toBe(200);
    expect((await app.request("/api/invites", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await app.request("/api/deploy", { method: "POST", headers, body: "{}" })).status).toBe(200);
  });

  it("OR semantics — any matching permission passes", async () => {
    const memberships = new Map([["u1:t1", { roles: ["runner"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    // runner has job:run but not schema:write
    app.post("/api/action", requires("schema:write", "job:run"), (c) => c.json({ ok: true }));
    const res = await app.request("/api/action", { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(200);
  });

  it("union of multiple roles gives combined permissions", async () => {
    const memberships = new Map([["u1:t1", { roles: ["runner", "schema-editor"] }]]);
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/jobs", requires("job:run"), (c) => c.json({ ok: true }));
    app.post("/api/schemas", requires("schema:write"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/jobs", { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await app.request("/api/schemas", { method: "POST", headers, body: "{}" })).status).toBe(200);
  });
});
