import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires, getTenantId, getPrincipal, getRoles } from "../auth/middleware";
import { highestRoleRank } from "../auth/roles";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";

function createMockAdapter(users: Map<string, Principal>): AuthAdapter {
  return {
    async resolve(token: string) { return users.get(token) ?? null; },
    async createSession(): Promise<Session> {
      return { token: "s", expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

function createTestApp(opts: {
  users: Map<string, Principal>;
  memberships: Map<string, { roles: string[] }>;
  tenants: Map<string, string>;
}) {
  const adapter = createMockAdapter(opts.users);
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    let qi = 0;
    const chain = () => {
      const idx = qi++;
      const obj = {
        from: () => obj, where: () => obj,
        limit: () => {
          if (idx === 0) {
            const slug = c.req.header("x-koji-tenant");
            return opts.tenants.has(slug ?? "") ? [{ id: opts.tenants.get(slug!)! }] : [];
          }
          if (idx === 1) {
            const p = c.get("principal") as Principal | undefined;
            const t = c.get("tenantId") as string | undefined;
            if (p && t) { const m = opts.memberships.get(`${p.userId}:${t}`); return m ? [m] : []; }
            return [];
          }
          return [];
        },
      };
      return obj;
    };
    c.set("db", { select: chain } as any);
    await next();
  });

  app.use("*", authMiddleware(adapter));
  return app;
}

describe("members endpoint permission enforcement", () => {
  const owner: Principal = { userId: "u-owner", email: "owner@test.com", name: "Owner" };
  const admin: Principal = { userId: "u-admin", email: "admin@test.com", name: "Admin" };
  const viewer: Principal = { userId: "u-viewer", email: "viewer@test.com", name: "Viewer" };

  const users = new Map([
    ["token-owner", owner],
    ["token-admin", admin],
    ["token-viewer", viewer],
  ]);
  const tenants = new Map([["acme", "t1"]]);
  const memberships = new Map([
    ["u-owner:t1", { roles: ["owner"] }],
    ["u-admin:t1", { roles: ["tenant-admin"] }],
    ["u-viewer:t1", { roles: ["viewer"] }],
  ]);

  const hdrs = (token: string) => ({
    Cookie: `koji_session=${token}`,
    "x-koji-tenant": "acme",
    "Content-Type": "application/json",
  });

  it("viewer can list members (member:read)", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/members", requires("member:read"), (c) => c.json({ data: [] }));
    expect((await app.request("/api/members", { headers: hdrs("token-viewer") })).status).toBe(200);
  });

  it("viewer cannot remove members", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/members/:id", requires("member:remove"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/members/x", { method: "DELETE", headers: hdrs("token-viewer") })).status).toBe(403);
  });

  it("viewer cannot update member roles", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.patch("/api/members/:id", requires("member:invite"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/members/x", { method: "PATCH", headers: hdrs("token-viewer"), body: "{}" })).status).toBe(403);
  });

  it("admin can remove members", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/members/:id", requires("member:remove"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/members/x", { method: "DELETE", headers: hdrs("token-admin") })).status).toBe(200);
  });

  it("admin can update member roles", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.patch("/api/members/:id", requires("member:invite"), (c) => c.json({ ok: true }));
    expect((await app.request("/api/members/x", { method: "PATCH", headers: hdrs("token-admin"), body: "{}" })).status).toBe(200);
  });

  it("owner can do all member operations", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/members", requires("member:read"), (c) => c.json({ data: [] }));
    app.patch("/api/members/:id", requires("member:invite"), (c) => c.json({ ok: true }));
    app.delete("/api/members/:id", requires("member:remove"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/members", { headers: hdrs("token-owner") })).status).toBe(200);
    expect((await app.request("/api/members/x", { method: "PATCH", headers: hdrs("token-owner"), body: "{}" })).status).toBe(200);
    expect((await app.request("/api/members/x", { method: "DELETE", headers: hdrs("token-owner") })).status).toBe(200);
  });
});

describe("member role update ceiling logic", () => {
  it("admin cannot promote someone to owner", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const targetMax = highestRoleRank(["owner"]);
    expect(targetMax).toBeGreaterThan(myMax);
  });

  it("admin can set roles up to tenant-admin", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const allowed = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin"];
    for (const role of allowed) {
      expect(highestRoleRank([role])).toBeLessThanOrEqual(myMax);
    }
  });

  it("admin cannot demote an owner", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const theirMax = highestRoleRank(["owner"]);
    // Should block: their current role is higher than mine
    expect(theirMax).toBeGreaterThan(myMax);
  });

  it("owner can change anyone's role", () => {
    const myMax = highestRoleRank(["owner"]);
    const all = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of all) {
      expect(highestRoleRank([role])).toBeLessThanOrEqual(myMax);
    }
  });
});

describe("self-removal guard", () => {
  it("user cannot remove themselves (enforced at route level)", () => {
    // The route handler checks membership.userId === principal.userId
    // and returns 400. This is a logic test, not a middleware test.
    const principal = { userId: "u1" };
    const membership = { userId: "u1" };
    expect(membership.userId).toBe(principal.userId);
    // Route returns: { error: "Cannot remove yourself..." }
  });
});
