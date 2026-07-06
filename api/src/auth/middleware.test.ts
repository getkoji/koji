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
  projects?: Map<string, string>; // slug → id (for x-koji-project header tests)
  /** Per-project access (oss-370): when set, the member is restricted to the
   *  listed project IDs. Omit for an unrestricted member (default). */
  restrictedToProjectIds?: string[];
  /**
   * Sets `c.masterKey` before the auth middleware runs. Required for
   * the doc-endpoint matcher branch (HMAC preview-token validation
   * lives behind this guard — without it the matcher just `next()`s
   * unconditionally).
   */
  masterKey?: string;
}) {
  const adapter = createMockAdapter(opts.users ?? new Map());
  const app = new Hono<Env>();

  if (opts.masterKey) {
    app.use("*", async (c, next) => {
      c.set("masterKey", opts.masterKey!);
      await next();
    });
  }

  // Track state so the mock can figure out which table is being queried.
  app.use("*", async (c, next) => {
    let queryIndex = 0;

    // For a tenant-scoped session route the middleware issues (in order):
    //   0. SELECT tenants           WHERE slug = x-koji-tenant
    //   1. SELECT memberships        (project_restricted, for access checks)
    //   2. SELECT projects           (header project OR default-project resolve)
    //   3. SELECT memberships        (roles/grants, Stage 3)
    // Restricted members (not exercised by these unit tests) add a
    // project_access query between 1 and 2. The value is returned regardless of
    // which builder method the caller awaits on (.limit() or a bare await).
    // When the member is restricted, the middleware inserts a project_access
    // query between the restriction read and project resolution — shifting the
    // later indices by one.
    const restricted = opts.restrictedToProjectIds !== undefined;
    const projIdx = restricted ? 3 : 2;
    const grantsIdx = restricted ? 4 : 3;

    const valueFor = (idx: number): unknown[] => {
      if (idx === 0) {
        const slug = c.req.header("x-koji-tenant");
        const tenantId = opts.tenants?.get(slug ?? "");
        return tenantId ? [{ id: tenantId }] : [];
      }
      if (idx === 1) {
        // Access-check membership read: is this member project-restricted?
        return [{ restricted }];
      }
      if (restricted && idx === 2) {
        // project_access grant rows for a restricted member.
        return (opts.restrictedToProjectIds ?? []).map((projectId) => ({ projectId }));
      }
      if (idx === projIdx) {
        const projSlug = c.req.header("x-koji-project");
        if (projSlug) {
          const projId = opts.projects?.get(projSlug);
          return projId ? [{ id: projId }] : [];
        }
        // Default-project resolution returns the ordered candidate list; the
        // middleware picks the first one the member can access.
        return [{ id: "00000000-0000-4000-8000-00000000aaaa" }];
      }
      if (idx === grantsIdx) {
        const principal = c.get("principal") as Principal | undefined;
        const tenantId = c.get("tenantId") as string | undefined;
        if (principal && tenantId) {
          const m = opts.memberships?.get(`${principal.userId}:${tenantId}`);
          return m ? [m] : [];
        }
        return [];
      }
      return [];
    };

    const fakeChain = () => {
      const idx = queryIndex++;
      const resolve = () => valueFor(idx);
      const chain: any = {
        from: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        where: () => chain,
        limit: () => resolve(),
        then: (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF),
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

  it("answers an unknown x-koji-project with 403 for non-members (no slug oracle)", async () => {
    // A non-member must not learn whether a project slug exists — the
    // membership 403 wins over the project 404.
    const app = createTestApp({ users, tenants, memberships: new Map(), projects: new Map() });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: {
        Cookie: "koji_session=valid-token",
        "x-koji-tenant": "acme",
        "x-koji-project": "secret-codename",
      },
    });
    expect(res.status).toBe(403);
  });

  it("answers an unknown x-koji-project with 404 for members", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({ users, tenants, memberships, projects: new Map() });
    app.get("/api/schemas", (c) => c.json([]));
    const res = await app.request("/api/schemas", {
      headers: {
        Cookie: "koji_session=valid-token",
        "x-koji-tenant": "acme",
        "x-koji-project": "nope",
      },
    });
    expect(res.status).toBe(404);
  });

  it("resolves a known x-koji-project for members", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const projects = new Map([["side", "00000000-0000-4000-8000-00000000bbbb"]]);
    const app = createTestApp({ users, tenants, memberships, projects });
    app.get("/api/schemas", (c) => c.json({ projectId: c.get("projectId") }));
    const res = await app.request("/api/schemas", {
      headers: {
        Cookie: "koji_session=valid-token",
        "x-koji-tenant": "acme",
        "x-koji-project": "side",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectId).toBe("00000000-0000-4000-8000-00000000bbbb");
  });

  it("restricted member: allows a granted project via header", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const projects = new Map([["side", "00000000-0000-4000-8000-00000000bbbb"]]);
    const app = createTestApp({
      users, tenants, memberships, projects,
      restrictedToProjectIds: ["00000000-0000-4000-8000-00000000bbbb"],
    });
    app.get("/api/schemas", (c) => c.json({ projectId: c.get("projectId") }));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme", "x-koji-project": "side" },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).projectId).toBe("00000000-0000-4000-8000-00000000bbbb");
  });

  it("restricted member: 403 for a project they aren't granted", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const projects = new Map([["side", "00000000-0000-4000-8000-00000000bbbb"]]);
    const app = createTestApp({
      users, tenants, memberships, projects,
      restrictedToProjectIds: ["00000000-0000-4000-8000-00000000cccc"],
    });
    app.get("/api/schemas", (c) => c.json({ ok: true }));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme", "x-koji-project": "side" },
    });
    expect(res.status).toBe(403);
  });

  it("restricted member: default project resolves to a granted one (no header)", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({
      users, tenants, memberships,
      // The default-candidate the harness returns is ...aaaa; granting it means
      // the restricted member lands there.
      restrictedToProjectIds: ["00000000-0000-4000-8000-00000000aaaa"],
    });
    app.get("/api/schemas", (c) => c.json({ projectId: c.get("projectId") }));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).projectId).toBe("00000000-0000-4000-8000-00000000aaaa");
  });

  it("restricted member with NO accessible project gets a non-matching sentinel (never tenant-wide)", async () => {
    const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
    const app = createTestApp({
      users, tenants, memberships,
      // granted a project that is NOT the default candidate (...aaaa) → no
      // accessible candidate resolves.
      restrictedToProjectIds: ["00000000-0000-4000-8000-00000000cccc"],
    });
    app.get("/api/schemas", (c) => c.json({ projectId: c.get("projectId") }));
    const res = await app.request("/api/schemas", {
      headers: { Cookie: "koji_session=valid-token", "x-koji-tenant": "acme" },
    });
    expect(res.status).toBe(200);
    // Nil-uuid sentinel — matches no real project, so RLS returns zero rows;
    // crucially NOT undefined (which would mean tenant-wide access).
    expect((await res.json() as any).projectId).toBe("00000000-0000-0000-0000-000000000000");
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

  // Regression: the doc-endpoint matcher used to 403 whenever
  // `?token=` was absent on /preview, /embed-data, or /stream — but
  // those endpoints support dual-auth (preview token OR session
  // cookie). The dashboard sends cookie-authenticated GETs on
  // /stream with no token, and got hammered with 403s in production.
  describe("doc-endpoint dual-auth (preview | embed-data | stream)", () => {
    it("falls through to session auth when token is absent", async () => {
      const memberships = new Map([["u1:t1", { roles: ["viewer"] }]]);
      const app = createTestApp({
        users,
        tenants,
        memberships,
        masterKey: "test-master-key",
      });
      app.get(
        "/api/jobs/:slug/documents/:docId/stream",
        (c) => c.json({ ok: true }),
      );

      const res = await app.request(
        "/api/jobs/job-1/documents/doc-1/stream",
        {
          headers: {
            Cookie: "koji_session=valid-token",
            "x-koji-tenant": "acme",
          },
        },
      );
      expect(res.status).toBe(200);
    });

    it("still 403s when an explicit invalid token is supplied", async () => {
      // An explicitly-passed bad token is a sign the embed viewer's
      // token expired — return 403 so the client can refresh. Falling
      // through to session auth in that case would silently 401 the
      // embed iframe and break the UX.
      const app = createTestApp({ users, tenants, masterKey: "test-master-key" });
      app.get(
        "/api/jobs/:slug/documents/:docId/preview",
        (c) => c.json({ ok: true }),
      );

      const res = await app.request(
        "/api/jobs/job-1/documents/doc-1/preview?token=nope",
      );
      expect(res.status).toBe(403);
    });

    it("401s when token is absent AND no session cookie is set", async () => {
      // The fall-through must reach the normal auth path — which 401s
      // without a cookie. If a future change accidentally `next()`s
      // here without a token, we'd be silently opening up the
      // endpoint to anonymous requests.
      const app = createTestApp({ users, tenants, masterKey: "test-master-key" });
      app.get(
        "/api/jobs/:slug/documents/:docId/stream",
        (c) => c.json({ ok: true }),
      );

      const res = await app.request(
        "/api/jobs/job-1/documents/doc-1/stream",
      );
      expect(res.status).toBe(401);
    });
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
