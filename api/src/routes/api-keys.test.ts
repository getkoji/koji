import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires, getTenantId, getPrincipal } from "../auth/middleware";
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
        from: () => obj,
        where: () => obj,
        limit: () => {
          if (idx === 0) {
            const slug = c.req.header("x-koji-tenant");
            const tid = opts.tenants.get(slug ?? "");
            return tid ? [{ id: tid }] : [];
          }
          if (idx === 1) {
            const p = c.get("principal") as Principal | undefined;
            const t = c.get("tenantId") as string | undefined;
            if (p && t) {
              const m = opts.memberships.get(`${p.userId}:${t}`);
              return m ? [m] : [];
            }
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

describe("API keys permission enforcement", () => {
  const owner: Principal = { userId: "u-owner", email: "owner@test.com", name: "Owner" };
  const viewer: Principal = { userId: "u-viewer", email: "viewer@test.com", name: "Viewer" };
  const editor: Principal = { userId: "u-editor", email: "editor@test.com", name: "Editor" };

  const users = new Map([
    ["token-owner", owner],
    ["token-viewer", viewer],
    ["token-editor", editor],
  ]);
  const tenants = new Map([["acme", "t1"]]);
  const memberships = new Map([
    ["u-owner:t1", { roles: ["owner"] }],
    ["u-viewer:t1", { roles: ["viewer"] }],
    ["u-editor:t1", { roles: ["schema-editor"] }],
  ]);

  const hdrs = (token: string) => ({
    Cookie: `koji_session=${token}`,
    "x-koji-tenant": "acme",
    "Content-Type": "application/json",
  });

  it("owner can list API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/api-keys", requires("api_key:write"), (c) => c.json({ data: [] }));

    const res = await app.request("/api/api-keys", { headers: hdrs("token-owner") });
    expect(res.status).toBe(200);
  });

  it("viewer cannot list API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/api-keys", requires("api_key:write"), (c) => c.json({ data: [] }));

    const res = await app.request("/api/api-keys", { headers: hdrs("token-viewer") });
    expect(res.status).toBe(403);
  });

  it("schema-editor cannot create API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/api-keys", requires("api_key:write"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/api-keys", {
      method: "POST", headers: hdrs("token-editor"), body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("owner can create API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/api-keys", requires("api_key:write"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/api-keys", {
      method: "POST", headers: hdrs("token-owner"), body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("viewer cannot revoke API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/api-keys/:id", requires("api_key:write"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/api-keys/some-id", {
      method: "DELETE", headers: hdrs("token-viewer"),
    });
    expect(res.status).toBe(403);
  });

  it("owner can revoke API keys", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/api-keys/:id", requires("api_key:write"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/api-keys/some-id", {
      method: "DELETE", headers: hdrs("token-owner"),
    });
    expect(res.status).toBe(200);
  });

  it("tenant-admin can manage API keys", async () => {
    const admin: Principal = { userId: "u-admin", email: "admin@test.com", name: "Admin" };
    const u = new Map([...users, ["token-admin", admin]]);
    const m = new Map([...memberships, ["u-admin:t1", { roles: ["tenant-admin"] }]]);
    const app = createTestApp({ users: u, tenants, memberships: m });

    app.get("/api/api-keys", requires("api_key:write"), (c) => c.json({ data: [] }));
    app.post("/api/api-keys", requires("api_key:write"), (c) => c.json({ ok: true }));
    app.delete("/api/api-keys/:id", requires("api_key:write"), (c) => c.json({ ok: true }));

    expect((await app.request("/api/api-keys", { headers: hdrs("token-admin") })).status).toBe(200);
    expect((await app.request("/api/api-keys", { method: "POST", headers: hdrs("token-admin"), body: "{}" })).status).toBe(200);
    expect((await app.request("/api/api-keys/x", { method: "DELETE", headers: hdrs("token-admin") })).status).toBe(200);
  });
});
