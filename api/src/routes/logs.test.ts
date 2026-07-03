/**
 * Route-level isolation test for GET /api/projects/:slug/logs.
 *
 * The withRLS Postgres path itself is verified end-to-end against real
 * Postgres in packages/db/src/rls.test.ts (Testcontainers). What we verify
 * here is the *route contract*:
 *
 *   1. Every tenant-scoped query goes through withRLS, never raw db.select.
 *   2. The tenantId passed to withRLS is the caller's tenantId, not a slug
 *      or query parameter that an attacker could manipulate.
 *   3. A project that exists only in tenant B returns 404 to tenant A.
 *   4. Filters (since, level, kind, limit) work as documented.
 *
 * Together with the rls.test.ts round-trip, this guards against the two
 * realistic regressions on this surface: forgetting withRLS, or passing
 * the wrong tenantId into it.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import { logs } from "./logs";

const TENANT_A = "00000000-0000-0000-0000-00000000000a";
const TENANT_B = "00000000-0000-0000-0000-00000000000b";

// Captures every (tenantId, table) pair the route asks withRLS to scope to.
// Test assertions read this to prove no cross-tenant query was issued.
const withRLSCalls: Array<{ tenantId: string; table: string }> = [];

// Tenant-tagged seed data. The mocked tx returns rows from the bucket that
// matches the tenantId withRLS was invoked with — mirroring how real RLS
// would only surface rows whose tenant_id matches app.current_tenant_id.
type Seed = {
  projects: Array<{ id: string; slug: string }>;
  traces: Array<{
    traceId: string;
    status: string;
    durationMs: number | null;
    startedAt: Date;
    documentId: string;
    jobId: string;
    filename: string;
  }>;
  auditLog: Array<{
    action: string;
    actorType: string;
    actorId: string | null;
    resourceType: string;
    resourceId: string;
    traceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    detailsJson: unknown;
    createdAt: Date;
  }>;
};

const tenantData: Record<string, Seed> = {
  [TENANT_A]: {
    projects: [{ id: "p-a", slug: "acme" }],
    traces: [
      {
        traceId: "trace-a1",
        status: "completed",
        durationMs: 1200,
        startedAt: new Date("2026-06-01T10:00:00Z"),
        documentId: "doc-a1",
        jobId: "job-a1",
        filename: "tenant-a.pdf",
      },
      {
        traceId: "trace-a2",
        status: "failed",
        durationMs: 300,
        startedAt: new Date("2026-06-02T10:00:00Z"),
        documentId: "doc-a2",
        jobId: "job-a2",
        filename: "tenant-a-fail.pdf",
      },
    ],
    auditLog: [
      {
        action: "create",
        actorType: "user",
        actorId: "u-a",
        resourceType: "schema",
        resourceId: "s-a",
        traceId: null,
        ipAddress: "10.0.0.1",
        userAgent: "test",
        detailsJson: { tenant: "A" },
        createdAt: new Date("2026-06-03T10:00:00Z"),
      },
      {
        action: "delete",
        actorType: "user",
        actorId: "u-a",
        resourceType: "schema",
        resourceId: "s-a-old",
        traceId: null,
        ipAddress: "10.0.0.1",
        userAgent: "test",
        detailsJson: { tenant: "A" },
        createdAt: new Date("2026-06-04T10:00:00Z"),
      },
    ],
  },
  [TENANT_B]: {
    projects: [{ id: "p-b", slug: "beta-only" }],
    traces: [
      {
        traceId: "trace-b1",
        status: "completed",
        durationMs: 999,
        startedAt: new Date("2026-06-01T10:00:00Z"),
        documentId: "doc-b1",
        jobId: "job-b1",
        filename: "tenant-b.pdf",
      },
    ],
    auditLog: [
      {
        action: "create",
        actorType: "user",
        actorId: "u-b",
        resourceType: "schema",
        resourceId: "s-b",
        traceId: null,
        ipAddress: "10.0.0.2",
        userAgent: "test",
        detailsJson: { tenant: "B" },
        createdAt: new Date("2026-06-03T10:00:00Z"),
      },
    ],
  },
};

// Mock drizzle-orm operators so the mock chain can introspect the slug
// passed to where(eq(projects.slug, slug)) and filter accordingly. This
// mirrors what RLS + the WHERE clause do together in production: only
// rows matching the tenant_id AND the slug are returned.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
    and: (...conds: unknown[]) => ({ __op: "and", conds }),
    gte: (col: unknown, val: unknown) => ({ __op: "gte", col, val }),
    desc: (col: unknown) => ({ __op: "desc", col }),
  };
});

// Mock withRLS: record (tenantId, table) and return a chain-builder that
// pulls rows from the matching tenant's bucket. Any call without a seeded
// bucket gets an empty array — modeling the safe-default RLS guarantee.
vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  const tableName = (t: unknown): string => {
    if (t && typeof t === "object" && "__name" in (t as object)) {
      return (t as { __name: string }).__name;
    }
    return "unknown";
  };

  // Extract a slug value (or any string val) from an eq()/and() condition.
  // Used to filter the projects bucket as RLS+WHERE would in production.
  const extractEqVal = (cond: any): string | undefined => {
    if (!cond) return undefined;
    if (cond.__op === "eq" && typeof cond.val === "string") return cond.val;
    if (cond.__op === "and" && Array.isArray(cond.conds)) {
      for (const c of cond.conds) {
        const v = extractEqVal(c);
        if (v) return v;
      }
    }
    return undefined;
  };

  return {
    ...actual,
    withRLS: async (
      _db: unknown,
      scope: string | { tenantId: string; projectId?: string | null },
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      // Handlers now pass { tenantId, projectId } scopes; normalize to the
      // tenantId for bucket lookup + call recording.
      const tenantId = typeof scope === "string" ? scope : scope.tenantId;
      const seed = tenantData[tenantId] ?? {
        projects: [],
        traces: [],
        auditLog: [],
      };
      let currentTable = "unknown";
      let projectSlugFilter: string | undefined;
      const chain: any = {
        from: (t: unknown) => {
          currentTable = tableName(t);
          withRLSCalls.push({ tenantId, table: currentTable });
          return chain;
        },
        innerJoin: () => chain,
        where: (cond: unknown) => {
          if (currentTable === "projects") {
            projectSlugFilter = extractEqVal(cond);
          }
          return chain;
        },
        orderBy: () => chain,
        limit: () => {
          if (currentTable === "projects") {
            const rows = projectSlugFilter
              ? seed.projects.filter((p) => p.slug === projectSlugFilter)
              : seed.projects;
            return Promise.resolve(rows);
          }
          if (currentTable === "traces") return Promise.resolve(seed.traces);
          if (currentTable === "auditLog") return Promise.resolve(seed.auditLog);
          return Promise.resolve([]);
        },
      };
      const tx = { select: () => chain };
      return fn(tx);
    },
    schema: {
      ...((actual.schema as object) ?? {}),
      projects: { __name: "projects" },
      traces: { __name: "traces" },
      documents: { __name: "documents" },
      jobs: { __name: "jobs" },
      auditLog: { __name: "auditLog" },
    },
  };
});

// Build a Hono app that mounts the logs route with auth bypassed and
// a raw db that explodes if the route ever bypasses withRLS.
function createLogsApp(tenantId: string) {
  const app = new Hono<Env>();
  const exploder = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `BYPASS: route called db.${String(prop)} directly — must go through withRLS`,
        );
      },
    },
  );

  app.use("*", async (c, next) => {
    c.set("tenantId", tenantId);
    c.set("projectId", "00000000-0000-4000-8000-00000000aaaa");
    c.set("principal", {
      userId: "u-test",
      email: "test@koji.dev",
      name: "Test",
    } as any);
    c.set("grants", new Set(["trace:read"]));
    c.set("roles", ["owner"]);
    c.set("db", exploder as any);
    await next();
  });

  app.route("/api/projects", logs);
  return app;
}

describe("GET /api/projects/:slug/logs — tenant isolation", () => {
  it("returns only the caller's tenant's traces and audit entries", async () => {
    withRLSCalls.length = 0;
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any[]; meta: any };

    // Every entry must be from tenant A's seed.
    const aTraceIds = new Set(["trace-a1", "trace-a2"]);
    const aResourceIds = new Set(["s-a", "s-a-old"]);
    for (const e of body.data) {
      if (e.kind === "trace") {
        expect(aTraceIds.has(e.trace_id)).toBe(true);
      } else if (e.kind === "audit") {
        expect(aResourceIds.has(e.resource_id)).toBe(true);
      }
    }
    // Tenant B's identifiers must NOT appear anywhere in the response.
    const json = JSON.stringify(body);
    expect(json).not.toContain("trace-b1");
    expect(json).not.toContain("tenant-b.pdf");
    expect(json).not.toContain("s-b");
  });

  it("calls withRLS with the caller's tenantId for every tenant-scoped query", async () => {
    withRLSCalls.length = 0;
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs");
    expect(res.status).toBe(200);

    // projects (slug lookup), traces, auditLog — all three must be scoped.
    const tables = withRLSCalls.map((c) => c.table);
    expect(tables).toContain("projects");
    expect(tables).toContain("traces");
    expect(tables).toContain("auditLog");

    // Every withRLS call must use tenant A's UUID — never undefined,
    // never some attacker-controlled value, never the wrong tenant.
    for (const call of withRLSCalls) {
      expect(call.tenantId).toBe(TENANT_A);
    }
  });

  it("returns 404 when the slug belongs to a different tenant", async () => {
    withRLSCalls.length = 0;
    // 'beta-only' exists in tenant B's projects but NOT tenant A's.
    // Tenant A asking for it must get 404 — the slug lookup is scoped.
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/beta-only/logs");
    expect(res.status).toBe(404);

    // The project lookup must have been scoped to tenant A specifically.
    const projectLookup = withRLSCalls.find((c) => c.table === "projects");
    expect(projectLookup?.tenantId).toBe(TENANT_A);

    // Critically: traces/audit must NOT have been queried after the 404.
    // (If they were, tenant A would see tenant B's audit entries through
    // an unscoped-slug error.)
    expect(withRLSCalls.find((c) => c.table === "traces")).toBeUndefined();
    expect(withRLSCalls.find((c) => c.table === "auditLog")).toBeUndefined();
  });

  it("tenant B sees only tenant B's data on the same slug", async () => {
    withRLSCalls.length = 0;
    const app = createLogsApp(TENANT_B);
    const res = await app.request("/api/projects/beta-only/logs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any[] };
    const json = JSON.stringify(body);
    expect(json).toContain("trace-b1");
    expect(json).not.toContain("trace-a1");
    expect(json).not.toContain("tenant-a.pdf");

    for (const call of withRLSCalls) {
      expect(call.tenantId).toBe(TENANT_B);
    }
  });
});

describe("GET /api/projects/:slug/logs — filters", () => {
  it("level=error returns only error-level entries", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs?level=error");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any[] };
    for (const e of body.data) {
      expect(e.level).toBe("error");
    }
    // tenant A has one failed trace (trace-a2) → exactly one error entry.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].trace_id).toBe("trace-a2");
  });

  it("kind=audit excludes trace entries", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs?kind=audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const e of body.data) {
      expect(e.kind).toBe("audit");
    }
  });

  it("kind=trace excludes audit entries", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs?kind=trace");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: any[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const e of body.data) {
      expect(e.kind).toBe("trace");
    }
  });

  it("rejects an invalid since parameter with 400", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("caps limit at 1000", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs?limit=999999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { filters: { limit: number } } };
    expect(body.meta.filters.limit).toBe(1000);
  });

  it("entries are sorted by timestamp descending", async () => {
    const app = createLogsApp(TENANT_A);
    const res = await app.request("/api/projects/acme/logs");
    const body = (await res.json()) as { data: Array<{ timestamp: string }> };
    for (let i = 1; i < body.data.length; i++) {
      const prev = body.data[i - 1]!.timestamp;
      const curr = body.data[i]!.timestamp;
      expect(prev >= curr).toBe(true);
    }
  });
});
