/**
 * Route tests for the classifier config artifact — the schema-sibling CRUD.
 *
 * Mirrors ./schemas.corpus-delete.test.ts: withRLS is mocked so we run against
 * an in-memory fake DB while still capturing the tenantId every query is scoped
 * to. The focus is the contract that matters for a tenant-scoped artifact:
 *
 *   - permission gating (schema:read / schema:write / schema:deploy),
 *   - tenant isolation (every query runs under the caller's tenant — an
 *     API-layer companion to the DB-level RLS round-trip in
 *     packages/db/src/rls.test.ts),
 *   - the engine-validation seam (bad YAML → 400 ClassifierConfigError),
 *   - 404s for unknown slugs.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import type { Permission } from "../auth/roles";
import { resolvePermissions } from "../auth/roles";

// Capture the tenantId every withRLS call is scoped to; run fn against the fake db.
// The scope param may be a bare tenantId string or a { tenantId, projectId } object.
const rlsTenants: string[] = [];
vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withRLS: (
      _db: any,
      scope: string | { tenantId: string; projectId?: string | null },
      fn: (tx: any) => Promise<any>,
    ) => {
      rlsTenants.push(typeof scope === "string" ? scope : scope.tenantId);
      return fn(_db);
    },
  };
});

const { classifiers } = await import("./classifiers");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-00000000aaaa";
const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
const USER_ID = "00000000-0000-0000-0000-000000000099";
const CLASSIFIER_ID = "00000000-0000-0000-0000-000000000010";

/**
 * A minimal chainable/awaitable query stub. Every builder method returns the
 * same object; awaiting it (or calling `.limit()`) resolves the next queued
 * result. `updates` records what `.set()` was called with.
 */
function makeMockDb(opts: {
  selectResults?: unknown[][];
  updateReturning?: unknown[];
  insertReturning?: unknown[];
}) {
  const selectQueue = [...(opts.selectResults ?? [])];
  const updates: Record<string, unknown>[] = [];

  function selectChain() {
    const result = selectQueue.shift() ?? [];
    // Every builder method returns the same chain so any call order works
    // (`.where().limit()`, `.orderBy().limit()`, `.innerJoin().where().orderBy()`).
    // The chain is itself awaitable, so a terminal `.orderBy()` (no `.limit`)
    // still resolves.
    const chain: any = {
      from: () => chain,
      where: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(result),
      then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    };
    return chain;
  }

  const db: any = {
    select: () => selectChain(),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        const chain: any = {
          where: () => chain,
          returning: () => Promise.resolve(opts.updateReturning ?? []),
          then: (res: any, rej: any) => Promise.resolve(opts.updateReturning ?? []).then(res, rej),
        };
        return chain;
      },
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve(opts.insertReturning ?? []),
      }),
    }),
  };
  return { db, updates };
}

function createApp(opts: {
  db: any;
  grants?: Permission[];
}) {
  const grants = opts.grants ?? ["schema:read", "schema:write", "schema:deploy"];
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("tenantId", TENANT_ID);
    c.set("projectId", PROJECT_ID);
    c.set("principal", { userId: USER_ID, email: "test@koji.dev", name: "Test" } as any);
    c.set("grants", new Set(grants));
    c.set("roles", ["owner"]);
    c.set("db", opts.db);
    await next();
  });
  app.route("/api/classifiers", classifiers);
  return app;
}

// ── Permission map (pure) ────────────────────────────────────────────────────

describe("classifier routes — permission mapping reuses schema perms", () => {
  it("viewer can read classifiers (schema:read)", () => {
    expect(resolvePermissions(["viewer"]).has("schema:read")).toBe(true);
  });
  it("schema-editor can write classifiers (schema:write)", () => {
    expect(resolvePermissions(["schema-editor"]).has("schema:write")).toBe(true);
  });
  it("schema-deployer can promote/release classifiers (schema:deploy)", () => {
    expect(resolvePermissions(["schema-deployer"]).has("schema:deploy")).toBe(true);
  });
  it("viewer cannot write or deploy classifiers", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("schema:write")).toBe(false);
    expect(perms.has("schema:deploy")).toBe(false);
  });
});

// ── CRUD contract ────────────────────────────────────────────────────────────

describe("GET /api/classifiers/:slug", () => {
  it("returns 404 for an unknown slug", async () => {
    const { db } = makeMockDb({ selectResults: [[]] });
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/nope");
    expect(res.status).toBe(404);
  });

  it("returns the classifier + latest version when it exists", async () => {
    rlsTenants.length = 0;
    const { db } = makeMockDb({
      selectResults: [
        [{ id: CLASSIFIER_ID, slug: "docs", displayName: "Docs" }],
        [{ versionNumber: 2, yamlSource: "classes:\n  a: {}", commitMessage: "x", createdAt: new Date() }],
      ],
    });
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.slug).toBe("docs");
    expect(body.latestVersion.versionNumber).toBe(2);
    // Every query ran scoped to the caller's tenant.
    expect(rlsTenants.length).toBeGreaterThan(0);
    expect(rlsTenants.every((t) => t === TENANT_ID)).toBe(true);
  });
});

describe("POST /api/classifiers — validation seam", () => {
  it("returns 400 when slug/display_name are missing", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db });
    const res = await app.request("/api/classifiers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 (ClassifierConfigError) for invalid initial YAML", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db });
    // Valid YAML, but not a valid classifier config (no `classes`).
    const res = await app.request("/api/classifiers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "docs", display_name: "Docs", initial_yaml: "name: docs\n" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("Invalid initial YAML");
  });

  it("creates a classifier + v1 from the default template and scopes to the tenant", async () => {
    rlsTenants.length = 0;
    const { db } = makeMockDb({
      insertReturning: [{ id: CLASSIFIER_ID, slug: "docs", displayName: "Docs" }],
    });
    const app = createApp({ db });
    const res = await app.request("/api/classifiers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "docs", display_name: "Docs" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.latestVersion).toBe(1);
    expect(rlsTenants.every((t) => t === TENANT_ID)).toBe(true);
  });

  it("returns 403 without schema:write", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db, grants: ["schema:read"] });
    const res = await app.request("/api/classifiers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "docs", display_name: "Docs" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/classifiers/:slug", () => {
  it("updates metadata, sets updatedAt, and returns the row", async () => {
    rlsTenants.length = 0;
    const { db, updates } = makeMockDb({
      updateReturning: [{ id: CLASSIFIER_ID, slug: "docs", displayName: "Renamed" }],
    });
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/docs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Renamed", draft_yaml: "classes:\n  a: {}" }),
    });
    expect(res.status).toBe(200);
    expect(updates[0]!.displayName).toBe("Renamed");
    expect(updates[0]!.draftUpdatedAt).toBeInstanceOf(Date);
    expect(rlsTenants.every((t) => t === TENANT_ID)).toBe(true);
  });

  it("returns 404 when the classifier does not exist", async () => {
    const { db } = makeMockDb({ updateReturning: [] });
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 without schema:write", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db, grants: ["schema:read"] });
    const res = await app.request("/api/classifiers/docs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/classifiers/:slug", () => {
  it("soft-deletes (sets deletedAt), returns 204, scoped to the tenant", async () => {
    rlsTenants.length = 0;
    const { db, updates } = makeMockDb({});
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/docs", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(updates[0]!.deletedAt).toBeInstanceOf(Date);
    expect(rlsTenants.every((t) => t === TENANT_ID)).toBe(true);
  });

  it("returns 403 without schema:write", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db, grants: ["schema:read"] });
    const res = await app.request("/api/classifiers/docs", { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});

describe("versions/promote/release — permission gating", () => {
  it("POST /:slug/versions requires schema:write (403 for viewer)", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db, grants: ["schema:read"] });
    const res = await app.request("/api/classifiers/docs/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml_source: "classes:\n  a: {}" }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /:slug/promote requires schema:deploy (403 for schema-editor without deploy)", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db, grants: ["schema:read", "schema:write"] });
    const res = await app.request("/api/classifiers/docs/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("POST /:slug/versions with invalid YAML returns 400 before touching the DB", async () => {
    const { db } = makeMockDb({});
    const app = createApp({ db });
    const res = await app.request("/api/classifiers/docs/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml_source: "name: docs\n" }), // no classes
    });
    expect(res.status).toBe(400);
  });
});
