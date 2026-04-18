import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, requires, getPrincipal } from "../auth/middleware";
import type { AuthAdapter, Principal, Session } from "../auth/adapter";
import type { Env } from "../env";

function createMockAdapter(users: Map<string, Principal>): AuthAdapter {
  return {
    async resolve(token: string) { return users.get(token) ?? null; },
    async createSession(userId: string): Promise<Session> {
      return { token: `sess_${userId}`, expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

/**
 * Build a test app that simulates the CLI auth flow.
 * The /api/cli/authorize route is a no-tenant route (needs auth but
 * not x-koji-tenant header — it receives tenant_id in the body).
 */
function createTestApp(opts: {
  users: Map<string, Principal>;
  memberships: Map<string, boolean>; // key: `${userId}:${tenantId}` → is member
}) {
  const adapter = createMockAdapter(opts.users);
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    // Minimal fake DB for the middleware's tenant/membership lookups
    // CLI authorize is a no-tenant route, so these won't be called by middleware
    let queryIndex = 0;
    const fakeChain = () => {
      const idx = queryIndex++;
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => [],
      };
      return chain;
    };
    c.set("db", { select: fakeChain } as any);
    await next();
  });

  app.use("*", authMiddleware(adapter));

  // Simulate the CLI authorize endpoint logic
  app.post("/api/cli/authorize", async (c) => {
    const principal = getPrincipal(c);
    const body = await c.req.json() as Record<string, unknown>;
    const tenantId = body.tenant_id as string | undefined;

    if (!tenantId) {
      return c.json({ error: "tenant_id is required" }, 400);
    }

    // Check membership
    const key = `${principal.userId}:${tenantId}`;
    if (!opts.memberships.has(key)) {
      return c.json({ error: "You are not a member of this workspace" }, 403);
    }

    // Simulate key creation
    return c.json({
      key: `koji_${"a".repeat(64)}`,
    }, 201);
  });

  return app;
}

describe("CLI auth flow", () => {
  const user: Principal = { userId: "u1", email: "frank@example.com", name: "Frank" };
  const users = new Map([["valid-token", user]]);

  it("returns 401 without authentication", async () => {
    const app = createTestApp({ users, memberships: new Map() });
    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when tenant_id is missing", async () => {
    const app = createTestApp({ users, memberships: new Map() });
    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: {
        Cookie: "koji_session=valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain("tenant_id");
  });

  it("returns 403 when user is not a member of the tenant", async () => {
    const app = createTestApp({ users, memberships: new Map() });
    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: {
        Cookie: "koji_session=valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: "t1" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 with a key when user is a member", async () => {
    const memberships = new Map([["u1:t1", true]]);
    const app = createTestApp({ users, memberships });
    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: {
        Cookie: "koji_session=valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: "t1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toBeDefined();
    expect((body.key as string).startsWith("koji_")).toBe(true);
  });

  it("does not require x-koji-tenant header (it's a no-tenant route)", async () => {
    const memberships = new Map([["u1:t1", true]]);
    const app = createTestApp({ users, memberships });

    // No x-koji-tenant header — should still work
    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: {
        Cookie: "koji_session=valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: "t1" }),
    });
    expect(res.status).toBe(201);
  });

  it("user cannot authorize for a workspace they don't belong to", async () => {
    // u1 is a member of t1, but not t2
    const memberships = new Map([["u1:t1", true]]);
    const app = createTestApp({ users, memberships });

    const res = await app.request("/api/cli/authorize", {
      method: "POST",
      headers: {
        Cookie: "koji_session=valid-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: "t2" }),
    });
    expect(res.status).toBe(403);
  });
});
