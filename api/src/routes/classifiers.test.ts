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

/**
 * The live-pointer guard, exercised through the HTTP handler rather than
 * `releaseDirect` directly — this covers the route wiring (status code, body
 * shape, `allow_reactivate` passthrough) that the unit tests in
 * ../schemas/versioning.release-direct.test.ts do not reach.
 */
describe("versions — live release pointer", () => {
  const YAML = "classes:\n  a: {}";
  const LIVE_ID = "00000000-0000-0000-0000-0000000002a9";
  const OLDER_ID = "00000000-0000-0000-0000-0000000002a5";

  /** Query order: classifier by slug → currentVersionId → active row → hash match. */
  function queues(match: unknown) {
    return [
      [{ id: CLASSIFIER_ID }],
      [{ currentVersionId: LIVE_ID }],
      [{ id: LIVE_ID, major: 2, minor: 0, patch: 9, prerelease: null, parsedJson: { classes: [] } }],
      [match],
    ];
  }

  const olderRelease = {
    id: OLDER_ID,
    versionNumber: 5,
    major: 2,
    minor: 0,
    patch: 5,
    prerelease: null,
  };

  function post(db: any, body: Record<string, unknown>) {
    const app = createApp({ db });
    return app.request("/api/classifiers/docs/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml_source: YAML, ...body }),
    });
  }

  it("409s instead of silently rolling the live release back, and writes nothing", async () => {
    const { db, updates } = makeMockDb({ selectResults: queues(olderRelease) });
    const res = await post(db, {});

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.reason).toBe("requires_reactivate");
    expect(body.matched_version).toBe("v2.0.5");
    expect(body.current_version).toBe("v2.0.9");
    expect(body.direction).toBe("backward");
    expect(updates).toEqual([]);
  });

  it("moves the pointer when allow_reactivate is passed, and reports the displaced release", async () => {
    const { db, updates } = makeMockDb({ selectResults: queues(olderRelease) });
    const res = await post(db, { allow_reactivate: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.action).toBe("reactivated");
    expect(body.released).toBe("v2.0.5");
    expect(body.displaced).toEqual({ id: LIVE_ID, label: "v2.0.9" });
    expect(updates).toContainEqual(expect.objectContaining({ currentVersionId: OLDER_ID }));
  });

  it("reports republishing the live version as unchanged without writing", async () => {
    const live = { id: LIVE_ID, versionNumber: 9, major: 2, minor: 0, patch: 9, prerelease: null };
    const { db, updates } = makeMockDb({ selectResults: queues(live) });
    const res = await post(db, {});

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.action).toBe("unchanged");
    expect(updates).toEqual([]);
  });
});

/**
 * Version addressing + "what is live" — the reported read-endpoint gaps.
 * `/versions/:v` used to parseInt() its segment, so the semver label the
 * sibling /versions list hands out (`v0.0.1`) became NaN and errored.
 */
describe("GET /:slug/versions/:v — addressing", () => {
  const VERSIONS = [
    { id: "aaaa1111-0000-0000-0000-000000000001", versionNumber: 1, major: 0, minor: 0, patch: 1, prerelease: null, yamlSource: "classes:\n  a: {}", parsedJson: { classes: [] } },
    { id: "bbbb2222-0000-0000-0000-000000000002", versionNumber: 2, major: 0, minor: 0, patch: 2, prerelease: "rc.1", yamlSource: "classes:\n  b: {}", parsedJson: { classes: [] } },
  ];

  function app(results: unknown[][]) {
    const { db } = makeMockDb({ selectResults: results });
    return createApp({ db });
  }

  it("resolves the semver label the /versions list hands out", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/v0.0.1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.versionNumber).toBe(1);
    // The endpoint that carries parsedJson — reachable by label at last.
    expect(body.parsedJson).toBeDefined();
  });

  it("still resolves a bare version number", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/2",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).versionNumber).toBe(2);
  });

  it("resolves a candidate label", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/v0.0.2-rc.1",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).versionNumber).toBe(2);
  });

  it("resolves a version-id prefix", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/bbbb2222",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).versionNumber).toBe(2);
  });

  it("400s on a segment that cannot identify a version", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/latest",
    );
    expect(res.status).toBe(400);
  });

  it("404s for a label no version carries", async () => {
    const res = await app([[{ id: CLASSIFIER_ID }], VERSIONS]).request(
      "/api/classifiers/docs/versions/v9.9.9",
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /:slug — what is live", () => {
  it("reports activeVersion separately from the highest committed version", async () => {
    const ACTIVE_ID = "aaaa1111-0000-0000-0000-000000000001";
    const { db } = makeMockDb({
      selectResults: [
        [{ id: CLASSIFIER_ID, slug: "docs", currentVersionId: ACTIVE_ID }],
        // latest = a CANDIDATE sitting on top of the live release
        [{ versionNumber: 2, major: 0, minor: 0, patch: 2, prerelease: "rc.1", yamlSource: "y", commitMessage: null, createdAt: new Date() }],
        [{ id: ACTIVE_ID, versionNumber: 1, major: 0, minor: 0, patch: 1, prerelease: null }],
      ],
    });
    const res = await createApp({ db }).request("/api/classifiers/docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    // Routing runs v0.0.1; the highest committed version is a candidate.
    expect(body.latestVersionLabel).toBe("v0.0.2-rc.1");
    expect(body.activeVersionLabel).toBe("v0.0.1");
    expect(body.activeVersion.versionId).toBe(ACTIVE_ID);
  });

  it("reports a null activeVersion when nothing is live", async () => {
    const { db } = makeMockDb({
      selectResults: [[{ id: CLASSIFIER_ID, slug: "docs", currentVersionId: null }], []],
    });
    const res = await createApp({ db }).request("/api/classifiers/docs");
    const body = (await res.json()) as Record<string, any>;
    expect(body.activeVersion).toBeNull();
    expect(body.activeVersionLabel).toBeNull();
  });
});

/**
 * The production incident (oss-468): a release body whose YAML arrived under an
 * unrecognized key used to fall through to the STORED DRAFT and release it.
 * The caller's payload was never seen, and the rollback guard then reported a
 * content match against draft content they had not sent.
 */
describe("POST /:slug/release — never substitutes the stored draft", () => {
  const DRAFT = "classes:\n  stub: {}";
  const PAYLOAD = "classes:\n  invoice:\n    keywords: [invoice]";

  function appWithDraft() {
    // Query order: classifier row (with its draft) → releaseDirect's lookups.
    const { db, updates } = makeMockDb({
      selectResults: [[{ id: CLASSIFIER_ID, draftYaml: DRAFT }], [], [], []],
      insertReturning: [{ id: "new", versionNumber: 2, major: 0, minor: 0, patch: 2, prerelease: null }],
    });
    return { app: createApp({ db }), updates };
  }

  function release(app: any, body: string) {
    return app.request("/api/classifiers/docs/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("400s when the YAML arrived under an unrecognized key", async () => {
    const { app, updates } = appWithDraft();
    const res = await release(app, JSON.stringify({ content: PAYLOAD }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("content");
    // The draft was NOT released.
    expect(updates).toEqual([]);
  });

  it("400s on a malformed body instead of releasing the draft", async () => {
    const { app, updates } = appWithDraft();
    const res = await release(app, "{ not json");
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("accepts yaml_source, the field name that caused the incident", async () => {
    const { app } = appWithDraft();
    const res = await release(app, JSON.stringify({ yaml_source: PAYLOAD }));
    expect(res.status).toBe(200);
  });

  it("accepts yaml", async () => {
    const { app } = appWithDraft();
    const res = await release(app, JSON.stringify({ yaml: PAYLOAD }));
    expect(res.status).toBe(200);
  });

  it("still releases the stored draft when no body is sent", async () => {
    const { app } = appWithDraft();
    const res = await app.request("/api/classifiers/docs/release", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
