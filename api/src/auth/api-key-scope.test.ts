import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { getTableName } from "drizzle-orm";
import { authMiddleware } from "./middleware";
import type { AuthAdapter, Session } from "./adapter";
import type { Env } from "../env";

/**
 * oss-433 — API-key project scoping matrix.
 *
 * These exercise the auth middleware's Stage-2.5 project resolution for API
 * keys of each scope (single / multi / all-access) against the presence and
 * value of an `x-koji-project` header. The mock DB dispatches by TABLE name
 * (via getTableName) rather than by query index, so it is robust to query
 * reordering in the middleware.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const CREATOR = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function nullAdapter(): AuthAdapter {
  return {
    async resolve() {
      return null; // force the api_keys hash-lookup fallback
    },
    async createSession(userId: string): Promise<Session> {
      return { token: `sess_${userId}`, expiresAt: new Date(Date.now() + 86400_000) };
    },
    async destroySession() {},
  };
}

function createApp(opts: {
  /** The key's bound default project (null = all-access). */
  keyProjectId: string | null;
  /** api_key_project_access grant project ids (empty = single/all). */
  grants: string[];
  /** Project slug → id, for x-koji-project header resolution. */
  projectsBySlug?: Map<string, string>;
  /** Ordered candidate project ids for the no-header default resolution. */
  candidates?: string[];
  /** The key creator's workspace roles (Stage 3). */
  roles?: string[];
}) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const rowsFor = (table: string): unknown[] => {
      switch (table) {
        case "api_keys":
          return [
            {
              id: KEY_ID,
              tenantId: TENANT,
              projectId: opts.keyProjectId,
              userId: CREATOR,
              email: "key@test.com",
              name: "Key Creator",
            },
          ];
        case "api_key_project_access":
          return opts.grants.map((projectId) => ({ projectId }));
        case "projects": {
          const slug = c.req.header("x-koji-project");
          if (slug) {
            const id = opts.projectsBySlug?.get(slug);
            return id ? [{ id }] : [];
          }
          return (opts.candidates ?? []).map((id) => ({ id }));
        }
        case "memberships":
          return [{ roles: opts.roles ?? ["owner"] }];
        case "tenants":
          return [{ id: TENANT }];
        default:
          return [];
      }
    };

    const select = () => {
      let table = "";
      const chain: any = {
        from: (t: unknown) => {
          try {
            table = getTableName(t as never);
          } catch {
            table = "";
          }
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        where: () => chain,
        limit: () => rowsFor(table),
        then: (onF: (v: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(onF),
      };
      return chain;
    };

    // `update` is a no-op stub purely so the middleware's last_used_at stamp
    // (oss-496) has something to call. These tests are about project scoping;
    // the stamp is covered in api-key-last-used.test.ts.
    const update = () => ({ set: () => ({ where: async () => undefined }) });

    c.set("db", { select, update } as any);
    await next();
  });

  app.use("*", authMiddleware(nullAdapter()));
  app.get("/api/schemas", (c) =>
    c.json({ projectId: c.get("projectId") ?? null }),
  );
  return app;
}

const hdrs = (project?: string) => ({
  Authorization: "Bearer koji_testkey",
  ...(project ? { "x-koji-project": project } : {}),
});

async function resolvedProject(res: Response): Promise<string | null> {
  const body = (await res.json()) as { projectId: string | null };
  return body.projectId;
}

describe("API-key project scoping (oss-433)", () => {
  describe("single-project key", () => {
    const base = { keyProjectId: P1, grants: [], candidates: [P1] };

    it("resolves to its bound project with no header", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs() });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P1);
    });

    it("allows the header to name its own project", async () => {
      const app = createApp({ ...base, projectsBySlug: new Map([["p1", P1]]) });
      const res = await app.request("/api/schemas", { headers: hdrs("p1") });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P1);
    });

    it("403s with an actionable message when the header names a project it isn't scoped to", async () => {
      // The project exists inside the key's OWN tenant, which the key is
      // already authenticated for, so 404 bought no secrecy — it just made a
      // too-narrow key indistinguishable from a typo'd slug. Cross-tenant
      // slugs still 404 (they never resolve to a project at all).
      const app = createApp({ ...base, projectsBySlug: new Map([["p2", P2]]) });
      const res = await app.request("/api/schemas", { headers: hdrs("p2") });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/not scoped to that project/i);
    });

    it("still 404s for a slug that does not exist in the tenant", async () => {
      const app = createApp({ ...base, projectsBySlug: new Map() });
      const res = await app.request("/api/schemas", { headers: hdrs("nope") });
      expect(res.status).toBe(404);
    });

    it("403s when its only bound project has been deleted", async () => {
      // No live candidates → the accessible set is entirely gone.
      const app = createApp({ keyProjectId: P1, grants: [], candidates: [] });
      const res = await app.request("/api/schemas", { headers: hdrs() });
      expect(res.status).toBe(403);
    });
  });

  describe("multi-project key", () => {
    const base = {
      keyProjectId: P1,
      grants: [P1, P2],
      projectsBySlug: new Map([
        ["p1", P1],
        ["p2", P2],
        ["p3", P3],
      ]),
      candidates: [P1, P2, P3],
    };

    it("allows any project in its grant set via header", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs("p2") });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P2);
    });

    it("403s for a project outside its grant set", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs("p3") });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/not scoped to that project/i);
    });

    it("defaults to its bound project with no header", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs() });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P1);
    });
  });

  describe("all-access key", () => {
    const base = {
      keyProjectId: null,
      grants: [],
      projectsBySlug: new Map([
        ["p1", P1],
        ["p2", P2],
      ]),
      candidates: [P1, P2],
    };

    it("resolves any named project", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs("p2") });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P2);
    });

    it("falls back to the tenant default project with no header", async () => {
      const res = await createApp(base).request("/api/schemas", { headers: hdrs() });
      expect(res.status).toBe(200);
      expect(await resolvedProject(res)).toBe(P1);
    });
  });
});
