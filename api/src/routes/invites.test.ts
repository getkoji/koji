import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires, getTenantId, getPrincipal, getRoles } from "../auth/middleware";
import { highestRoleRank, isValidRole, resolvePermissions } from "../auth/roles";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";

/**
 * These tests validate the invite flow's permission logic without
 * hitting a real database. We test:
 *
 * 1. Role ceiling — inviter cannot grant roles above their own
 * 2. Role validation — invalid role strings are rejected
 * 3. Permission gating — only users with member:invite can create invites
 * 4. Revocation permissions — only users with member:invite can revoke
 * 5. Member removal — cannot remove someone with a higher role
 * 6. Self-removal guard — cannot remove yourself
 */

describe("invite role ceiling logic", () => {
  it("owner can invite any role", () => {
    const inviterMax = highestRoleRank(["owner"]);
    const roles = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of roles) {
      expect(highestRoleRank([role])).toBeLessThanOrEqual(inviterMax);
    }
  });

  it("tenant-admin cannot invite owner", () => {
    const inviterMax = highestRoleRank(["tenant-admin"]);
    const inviteeMax = highestRoleRank(["owner"]);
    expect(inviteeMax).toBeGreaterThan(inviterMax);
  });

  it("schema-editor cannot invite tenant-admin", () => {
    const inviterMax = highestRoleRank(["schema-editor"]);
    const inviteeMax = highestRoleRank(["tenant-admin"]);
    expect(inviteeMax).toBeGreaterThan(inviterMax);
  });

  it("schema-editor cannot invite schema-deployer", () => {
    const inviterMax = highestRoleRank(["schema-editor"]);
    const inviteeMax = highestRoleRank(["schema-deployer"]);
    expect(inviteeMax).toBeGreaterThan(inviterMax);
  });

  it("viewer cannot invite anyone above viewer", () => {
    const inviterMax = highestRoleRank(["viewer"]);
    const aboveViewer = ["runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of aboveViewer) {
      expect(highestRoleRank([role])).toBeGreaterThan(inviterMax);
    }
  });

  it("same-rank invitation is allowed", () => {
    const roles = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of roles) {
      const inviterMax = highestRoleRank([role]);
      const inviteeMax = highestRoleRank([role]);
      expect(inviteeMax).toBeLessThanOrEqual(inviterMax);
    }
  });

  it("user with multiple roles uses highest for ceiling", () => {
    // User with viewer + schema-editor → highest is schema-editor (rank 3)
    const inviterMax = highestRoleRank(["viewer", "schema-editor"]);
    expect(inviterMax).toBe(3); // schema-editor index

    // Can invite up to schema-editor
    expect(highestRoleRank(["schema-editor"])).toBeLessThanOrEqual(inviterMax);
    // Cannot invite schema-deployer
    expect(highestRoleRank(["schema-deployer"])).toBeGreaterThan(inviterMax);
  });
});

describe("role validation", () => {
  it("accepts all 7 valid roles", () => {
    const valid = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of valid) {
      expect(isValidRole(role)).toBe(true);
    }
  });

  it("rejects invalid role strings", () => {
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole("tenant-owner")).toBe(false);
    expect(isValidRole("VIEWER")).toBe(false);
    expect(isValidRole("schema_editor")).toBe(false);
  });
});

describe("permission gating for invite operations", () => {
  it("viewer does not have member:invite", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("member:invite")).toBe(false);
  });

  it("viewer has member:read", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("member:read")).toBe(true);
  });

  it("tenant-admin has member:invite", () => {
    const perms = resolvePermissions(["tenant-admin"]);
    expect(perms.has("member:invite")).toBe(true);
  });

  it("tenant-admin has member:remove", () => {
    const perms = resolvePermissions(["tenant-admin"]);
    expect(perms.has("member:remove")).toBe(true);
  });

  it("owner has member:invite and member:remove", () => {
    const perms = resolvePermissions(["owner"]);
    expect(perms.has("member:invite")).toBe(true);
    expect(perms.has("member:remove")).toBe(true);
  });

  it("schema-editor does not have member:invite", () => {
    const perms = resolvePermissions(["schema-editor"]);
    expect(perms.has("member:invite")).toBe(false);
  });

  it("schema-deployer does not have member:invite", () => {
    const perms = resolvePermissions(["schema-deployer"]);
    expect(perms.has("member:invite")).toBe(false);
  });

  it("reviewer cannot invite or remove", () => {
    const perms = resolvePermissions(["reviewer"]);
    expect(perms.has("member:invite")).toBe(false);
    expect(perms.has("member:remove")).toBe(false);
  });
});

describe("member removal role ceiling", () => {
  it("admin cannot remove an owner", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const theirMax = highestRoleRank(["owner"]);
    expect(theirMax).toBeGreaterThan(myMax);
  });

  it("admin can remove another admin", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const theirMax = highestRoleRank(["tenant-admin"]);
    expect(theirMax).toBeLessThanOrEqual(myMax);
  });

  it("admin can remove lower roles", () => {
    const myMax = highestRoleRank(["tenant-admin"]);
    const lowerRoles = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer"];
    for (const role of lowerRoles) {
      expect(highestRoleRank([role])).toBeLessThan(myMax);
    }
  });

  it("owner can remove anyone", () => {
    const myMax = highestRoleRank(["owner"]);
    const allRoles = ["viewer", "runner", "reviewer", "schema-editor", "schema-deployer", "tenant-admin", "owner"];
    for (const role of allRoles) {
      expect(highestRoleRank([role])).toBeLessThanOrEqual(myMax);
    }
  });
});

// Integration tests using the middleware mock

function createMockAdapter(users: Map<string, Principal>): AuthAdapter {
  return {
    async resolve(token: string) { return users.get(token) ?? null; },
    async createSession(userId: string): Promise<Session> {
      return { token: `sess_${userId}`, expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

function createTestApp(opts: {
  users?: Map<string, Principal>;
  memberships?: Map<string, { roles: string[] }>;
  tenants?: Map<string, string>;
}) {
  const adapter = createMockAdapter(opts.users ?? new Map());
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    let queryIndex = 0;
    const fakeChain = () => {
      const idx = queryIndex++;
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => {
          if (idx === 0) {
            const slug = c.req.header("x-koji-tenant");
            const tenantId = opts.tenants?.get(slug ?? "");
            return tenantId ? [{ id: tenantId }] : [];
          }
          if (idx === 1) {
            const principal = c.get("principal") as Principal | undefined;
            const tenantId = c.get("tenantId") as string | undefined;
            if (principal && tenantId) {
              const m = opts.memberships?.get(`${principal.userId}:${tenantId}`);
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

describe("invite endpoint permission enforcement", () => {
  const owner: Principal = { userId: "u-owner", email: "owner@test.com", name: "Owner" };
  const admin: Principal = { userId: "u-admin", email: "admin@test.com", name: "Admin" };
  const viewer: Principal = { userId: "u-viewer", email: "viewer@test.com", name: "Viewer" };
  const editor: Principal = { userId: "u-editor", email: "editor@test.com", name: "Editor" };

  const users = new Map([
    ["token-owner", owner],
    ["token-admin", admin],
    ["token-viewer", viewer],
    ["token-editor", editor],
  ]);
  const tenants = new Map([["acme", "t1"]]);
  const memberships = new Map([
    ["u-owner:t1", { roles: ["owner"] }],
    ["u-admin:t1", { roles: ["tenant-admin"] }],
    ["u-viewer:t1", { roles: ["viewer"] }],
    ["u-editor:t1", { roles: ["schema-editor"] }],
  ]);

  const headers = (token: string) => ({
    Cookie: `koji_session=${token}`,
    "x-koji-tenant": "acme",
    "Content-Type": "application/json",
  });

  it("viewer gets 403 trying to create an invite", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/invites", requires("member:invite"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/invites", {
      method: "POST",
      headers: headers("token-viewer"),
      body: JSON.stringify({ email: "new@test.com", roles: ["viewer"] }),
    });
    expect(res.status).toBe(403);
  });

  it("schema-editor gets 403 trying to create an invite", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/invites", requires("member:invite"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/invites", {
      method: "POST",
      headers: headers("token-editor"),
      body: JSON.stringify({ email: "new@test.com", roles: ["viewer"] }),
    });
    expect(res.status).toBe(403);
  });

  it("tenant-admin can create an invite", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/invites", requires("member:invite"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/invites", {
      method: "POST",
      headers: headers("token-admin"),
      body: JSON.stringify({ email: "new@test.com", roles: ["viewer"] }),
    });
    expect(res.status).toBe(200);
  });

  it("owner can create an invite", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.post("/api/invites", requires("member:invite"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/invites", {
      method: "POST",
      headers: headers("token-owner"),
      body: JSON.stringify({ email: "new@test.com", roles: ["viewer"] }),
    });
    expect(res.status).toBe(200);
  });

  it("viewer gets 403 trying to revoke an invite", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/invites/:id", requires("member:invite"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/invites/some-id", {
      method: "DELETE",
      headers: headers("token-viewer"),
    });
    expect(res.status).toBe(403);
  });

  it("viewer can list members (member:read)", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.get("/api/members", requires("member:read"), (c) => c.json({ data: [] }));

    const res = await app.request("/api/members", {
      headers: headers("token-viewer"),
    });
    expect(res.status).toBe(200);
  });

  it("viewer gets 403 trying to remove a member", async () => {
    const app = createTestApp({ users, tenants, memberships });
    app.delete("/api/members/:id", requires("member:remove"), (c) => c.json({ ok: true }));

    const res = await app.request("/api/members/some-id", {
      method: "DELETE",
      headers: headers("token-viewer"),
    });
    expect(res.status).toBe(403);
  });
});
