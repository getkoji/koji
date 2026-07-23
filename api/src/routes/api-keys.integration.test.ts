/**
 * Integration test for the API-keys route (oss-433) against a real Postgres.
 * The multi/all-access scope logic writes the `api_key_project_access` grant
 * table and the list/revoke visibility filter joins it, so a mocked DB proves
 * nothing. Mounts the real `apiKeys` router with injected auth context.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import type { Env } from "../env";
import { apiKeys } from "./api-keys";

let container: StartedPostgreSqlContainer;
let db: Db;

const tenant = randomUUID();
const user = randomUUID();
const projA = randomUUID();
const projB = randomUUID();
const projC = randomUUID();

/** App acting as an owner scoped to `projectId`, mounting the real router. */
function appAt(projectId: string | null) {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("db", db as any);
    c.set("tenantId", tenant);
    c.set("principal", { userId: user, email: "o@x.com", name: "Owner" } as any);
    c.set("roles", ["owner"]);
    c.set("grants", new Set(["api_key:write"]) as any);
    // The real auth middleware always sets this; null = unrestricted, which is
    // what an owner resolves to. The workspace-wide guards read it, and they
    // fail closed when it's absent — so the stub has to mirror reality.
    c.set("accessibleProjectIds", null as any);
    if (projectId) c.set("projectId", projectId);
    await next();
  });
  a.route("/api/api-keys", apiKeys);
  return a;
}

async function createKey(app: Hono<Env>, body: unknown) {
  const res = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as any };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test").withUsername("postgres").withPassword("postgres").start();
  await runMigrations(container.getConnectionUri());
  db = createDb(container.getConnectionUri(), { max: 4 });

  await db.execute(sql`INSERT INTO tenants (id, slug, display_name) VALUES (${tenant}::uuid, 't', 'T')`);
  await db.execute(sql`INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES (${user}::uuid, 'o@x.com', 'local', 'o@x.com')`);
  for (const [id, slug] of [[projA, "proj-a"], [projB, "proj-b"], [projC, "proj-c"]] as const) {
    await db.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES (${id}::uuid, ${tenant}::uuid, ${slug}, ${slug}, ${user}::uuid)`);
  }
}, 120_000);

afterAll(async () => { await container?.stop(); }, 60_000);

beforeEach(async () => {
  await db.execute(sql`DELETE FROM api_key_project_access WHERE tenant_id = ${tenant}::uuid`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenant}::uuid`);
});

describe("API-keys route — project scope (oss-433)", () => {
  test("single (default): key is bound to the current project, no grants", async () => {
    const { res, body } = await createKey(appAt(projA), { name: "single" });
    expect(res.status).toBe(201);
    expect(body.scope).toEqual({ mode: "single", projectId: projA, projectIds: [projA] });
    const [row] = await db.execute<{ project_id: string }>(sql`SELECT project_id FROM api_keys WHERE id = ${body.id}::uuid`);
    expect(row!.project_id).toBe(projA);
    const grants = await db.execute(sql`SELECT 1 FROM api_key_project_access WHERE api_key_id = ${body.id}::uuid`);
    expect(grants.length).toBe(0);
  });

  test("all: key has a null project_id and no grants", async () => {
    const { res, body } = await createKey(appAt(projA), { name: "all", project_scope: { mode: "all" } });
    expect(res.status).toBe(201);
    expect(body.scope).toEqual({ mode: "all", projectId: null, projectIds: [] });
    const [row] = await db.execute<{ project_id: string | null }>(sql`SELECT project_id FROM api_keys WHERE id = ${body.id}::uuid`);
    expect(row!.project_id).toBeNull();
  });

  test("projects: grant rows written; default is the current project when in the set", async () => {
    const { res, body } = await createKey(appAt(projA), {
      name: "multi-ab",
      project_scope: { mode: "projects", project_ids: [projA, projB] },
    });
    expect(res.status).toBe(201);
    expect(body.scope.mode).toBe("projects");
    expect(body.scope.projectId).toBe(projA); // current project is in the set → default
    expect(new Set(body.scope.projectIds)).toEqual(new Set([projA, projB]));
    const grants = await db.execute<{ project_id: string }>(sql`SELECT project_id FROM api_key_project_access WHERE api_key_id = ${body.id}::uuid ORDER BY project_id`);
    expect(new Set(grants.map((g) => g.project_id))).toEqual(new Set([projA, projB]));
  });

  test("projects: default falls to the first named project when the current one isn't in the set", async () => {
    const { res, body } = await createKey(appAt(projA), {
      name: "multi-bc",
      project_scope: { mode: "projects", project_ids: [projB, projC] },
    });
    expect(res.status).toBe(201);
    expect(body.scope.projectId).toBe(projB);
  });

  test("projects: an unknown project id is rejected (400)", async () => {
    const { res } = await createKey(appAt(projA), {
      name: "bad",
      project_scope: { mode: "projects", project_ids: [projA, randomUUID()] },
    });
    expect(res.status).toBe(400);
  });

  test("projects: an empty set is rejected (400)", async () => {
    const { res } = await createKey(appAt(projA), {
      name: "empty",
      project_scope: { mode: "projects", project_ids: [] },
    });
    expect(res.status).toBe(400);
  });

  test("list from project A shows A-reaching keys, hides B-only keys", async () => {
    await createKey(appAt(projA), { name: "single-a" });
    await createKey(appAt(projB), { name: "single-b" });
    await createKey(appAt(projA), { name: "all", project_scope: { mode: "all" } });
    await createKey(appAt(projA), { name: "multi-ab", project_scope: { mode: "projects", project_ids: [projA, projB] } });
    await createKey(appAt(projA), { name: "multi-bc", project_scope: { mode: "projects", project_ids: [projB, projC] } });

    const res = await appAt(projA).request("/api/api-keys");
    const body = (await res.json()) as any;
    const names = new Set(body.data.map((k: any) => k.name));
    expect(names).toEqual(new Set(["single-a", "all", "multi-ab"]));
    expect(names.has("single-b")).toBe(false);
    expect(names.has("multi-bc")).toBe(false);
  });

  test("tenant-wide list (no project) shows every key", async () => {
    await createKey(appAt(projA), { name: "single-a" });
    await createKey(appAt(projB), { name: "single-b" });
    await createKey(appAt(projA), { name: "all", project_scope: { mode: "all" } });

    const res = await appAt(null).request("/api/api-keys");
    const body = (await res.json()) as any;
    expect(new Set(body.data.map((k: any) => k.name))).toEqual(new Set(["single-a", "single-b", "all"]));
  });

  test("revoke: allowed for a key reachable from the project, 404 otherwise", async () => {
    const { body: allKey } = await createKey(appAt(projA), { name: "all", project_scope: { mode: "all" } });
    const { body: singleB } = await createKey(appAt(projB), { name: "single-b" });

    // From project A: the all-access key is reachable → revoked.
    const ok = await appAt(projA).request(`/api/api-keys/${allKey.id}`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    const [revoked] = await db.execute<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM api_keys WHERE id = ${allKey.id}::uuid`);
    expect(revoked!.revoked_at).not.toBeNull();

    // From project A: a project-B-only key is NOT reachable → 404, still active.
    const denied = await appAt(projA).request(`/api/api-keys/${singleB.id}`, { method: "DELETE" });
    expect(denied.status).toBe(404);
    const [still] = await db.execute<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM api_keys WHERE id = ${singleB.id}::uuid`);
    expect(still!.revoked_at).toBeNull();
  });

  // ── PATCH: editing a key's project scope (oss-482) ──────────────────────
  // Scope used to be fixed at creation, so widening a key meant revoking and
  // reissuing it. These cover the move between all three modes, and the trap
  // that motivated it: a "specific projects" key is a frozen list, so a
  // project created later is NOT in it — only mode "all" keeps up.

  async function patchKey(app: Hono<Env>, id: string, body: unknown) {
    const res = await app.request(`/api/api-keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as any };
  }

  const grantsFor = async (id: string) =>
    (
      await db.execute<{ project_id: string }>(
        sql`SELECT project_id FROM api_key_project_access WHERE api_key_id = ${id}::uuid`,
      )
    ).map((r) => r.project_id);

  test("widens a single-project key to all-access", async () => {
    const { body: key } = await createKey(appAt(projA), { name: "widen-me" });
    const { res, body } = await patchKey(appAt(projA), key.id, {
      project_scope: { mode: "all" },
    });
    expect(res.status).toBe(200);
    expect(body.scope.mode).toBe("all");

    const [row] = await db.execute<{ project_id: string | null }>(
      sql`SELECT project_id FROM api_keys WHERE id = ${key.id}::uuid`,
    );
    expect(row!.project_id).toBeNull();
    expect(await grantsFor(key.id)).toEqual([]);
  });

  test("narrows an all-access key to a specific project set, replacing grants", async () => {
    const { body: key } = await createKey(appAt(projA), {
      name: "narrow-me",
      project_scope: { mode: "all" },
    });
    await patchKey(appAt(projA), key.id, {
      project_scope: { mode: "projects", project_ids: [projA, projB] },
    });
    expect(new Set(await grantsFor(key.id))).toEqual(new Set([projA, projB]));

    // Replaced wholesale, not appended — dropping projB must drop the grant.
    const { body } = await patchKey(appAt(projA), key.id, {
      project_scope: { mode: "projects", project_ids: [projA] },
    });
    expect(body.scope.mode).toBe("projects");
    expect(await grantsFor(key.id)).toEqual([projA]);
  });

  test("a 'specific projects' key does not cover a project created later; 'all' does", async () => {
    const { body: listKey } = await createKey(appAt(projA), {
      name: "frozen-list",
      project_scope: { mode: "projects", project_ids: [projA, projB] },
    });
    const { body: allKey } = await createKey(appAt(projA), {
      name: "standing-rule",
      project_scope: { mode: "all" },
    });

    const projLater = randomUUID();
    await db.execute(
      sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by)
          VALUES (${projLater}::uuid, ${tenant}::uuid, 'proj-later', 'Later', ${user}::uuid)`,
    );

    // The list key's reach is exactly what was named when it was written.
    expect(new Set(await grantsFor(listKey.id))).toEqual(new Set([projA, projB]));
    const [allRow] = await db.execute<{ project_id: string | null }>(
      sql`SELECT project_id FROM api_keys WHERE id = ${allKey.id}::uuid`,
    );
    // NULL project_id is the standing rule that matches the new project too.
    expect(allRow!.project_id).toBeNull();

    // And the fix for the frozen list is now a PATCH, not a reissue.
    await patchKey(appAt(projA), listKey.id, { project_scope: { mode: "all" } });
    const [fixed] = await db.execute<{ project_id: string | null }>(
      sql`SELECT project_id FROM api_keys WHERE id = ${listKey.id}::uuid`,
    );
    expect(fixed!.project_id).toBeNull();
    expect(await grantsFor(listKey.id)).toEqual([]);
  });

  test("renames without touching scope", async () => {
    const { body: key } = await createKey(appAt(projA), {
      name: "old-name",
      project_scope: { mode: "projects", project_ids: [projA, projB] },
    });
    const { res } = await patchKey(appAt(projA), key.id, { name: "new-name" });
    expect(res.status).toBe(200);
    const [row] = await db.execute<{ name: string }>(
      sql`SELECT name FROM api_keys WHERE id = ${key.id}::uuid`,
    );
    expect(row!.name).toBe("new-name");
    expect(new Set(await grantsFor(key.id))).toEqual(new Set([projA, projB]));
  });

  test("cannot edit a key that is not reachable from the caller's project", async () => {
    const { body: singleB } = await createKey(appAt(projB), { name: "b-only" });
    const { res } = await patchKey(appAt(projA), singleB.id, {
      project_scope: { mode: "all" },
    });
    expect(res.status).toBe(404);
  });

  test("rejects an unknown project id", async () => {
    const { body: key } = await createKey(appAt(projA), { name: "bad-target" });
    const { res, body } = await patchKey(appAt(projA), key.id, {
      project_scope: { mode: "projects", project_ids: [randomUUID()] },
    });
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Unknown project/i);
  });

  test("a revoked key cannot be re-scoped", async () => {
    const { body: key } = await createKey(appAt(projA), { name: "gone" });
    await appAt(projA).request(`/api/api-keys/${key.id}`, { method: "DELETE" });
    const { res } = await patchKey(appAt(projA), key.id, { project_scope: { mode: "all" } });
    expect(res.status).toBe(409);
  });

  test("a project-restricted caller cannot widen a key to the whole workspace", async () => {
    const { body: key } = await createKey(appAt(projA), { name: "escalate" });
    // Same app, but the caller is confined to projA (a Set, not null) — the
    // shape the real middleware produces for a restricted member or a
    // project-bound API key.
    const restricted = new Hono<Env>();
    restricted.use("*", async (c, next) => {
      c.set("db", db as any);
      c.set("tenantId", tenant);
      c.set("principal", { userId: user, email: "o@x.com", name: "Owner" } as any);
      c.set("roles", ["owner"]);
      c.set("grants", new Set(["api_key:write"]) as any);
      c.set("accessibleProjectIds", new Set([projA]) as any);
      c.set("projectId", projA);
      await next();
    });
    restricted.route("/api/api-keys", apiKeys);

    const { res } = await patchKey(restricted, key.id, { project_scope: { mode: "all" } });
    expect(res.status).toBe(403);
  });
});
