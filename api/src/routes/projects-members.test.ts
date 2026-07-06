/**
 * Integration test for the project-centric member endpoints (oss-383) against a
 * real Postgres — the GET partitions members into granted / all-access /
 * candidates and PUT/DELETE write project_access grants under RLS, so a mocked
 * DB proves nothing.
 *
 * These exercise the handlers via a minimal Hono app that injects the request
 * context (tenantId, roles, grants) the real auth middleware would set, then
 * mounts the real `projects` router.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb, schema, type Db } from "@koji/db";
import { runMigrations } from "@koji/db/migrate";
import type { Env } from "../env";
import { projects } from "./projects";

let container: StartedPostgreSqlContainer;
let db: Db;

const tenant = randomUUID();
const owner = randomUUID(); // the acting admin (owner)
const alice = randomUUID(); // restricted member
const bob = randomUUID(); // restricted member (candidate)
const adminUser = randomUUID(); // unrestricted tenant-admin
const projA = randomUUID();
let aliceMembershipId: string;
let bobMembershipId: string;
let adminMembershipId: string;

/** App that injects context as owner (member:invite) then mounts the real router. */
function app() {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    c.set("db", db as any);
    c.set("tenantId", tenant);
    c.set("principal", { userId: owner, email: "o@x.com", name: "Owner" } as any);
    c.set("roles", ["owner"]);
    c.set("grants", new Set(["member:read", "member:invite", "tenant:admin"]) as any);
    c.set("projectId", projA);
    await next();
  });
  a.route("/api/projects", projects);
  return a;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("koji_test").withUsername("postgres").withPassword("postgres").start();
  await runMigrations(container.getConnectionUri());
  db = createDb(container.getConnectionUri(), { max: 4 });

  await db.execute(sql`INSERT INTO tenants (id, slug, display_name) VALUES (${tenant}::uuid, 't', 'T')`);
  for (const [id, email] of [[owner, "o@x.com"], [alice, "alice@x.com"], [bob, "bob@x.com"], [adminUser, "admin@x.com"]] as const) {
    await db.execute(sql`INSERT INTO users (id, email, auth_provider, auth_provider_id) VALUES (${id}::uuid, ${email}, 'local', ${email})`);
  }
  await db.execute(sql`INSERT INTO projects (id, tenant_id, slug, display_name, created_by) VALUES (${projA}::uuid, ${tenant}::uuid, 'proj-a', 'Project A', ${owner}::uuid)`);
  await db.execute(sql`INSERT INTO memberships (tenant_id, user_id, roles, project_restricted) VALUES (${tenant}::uuid, ${owner}::uuid, ${"{owner}"}, false)`);
  await db.execute(sql`INSERT INTO memberships (tenant_id, user_id, roles, project_restricted) VALUES (${tenant}::uuid, ${adminUser}::uuid, ${"{tenant-admin}"}, false)`);
}, 120_000);

afterAll(async () => { await container?.stop(); }, 60_000);

beforeEach(async () => {
  // Reset alice/bob to restricted with no grants each run.
  await db.execute(sql`DELETE FROM project_access WHERE tenant_id = ${tenant}::uuid`);
  await db.execute(sql`DELETE FROM memberships WHERE user_id IN (${alice}::uuid, ${bob}::uuid)`);
  await db.execute(sql`INSERT INTO memberships (tenant_id, user_id, roles, project_restricted) VALUES (${tenant}::uuid, ${alice}::uuid, ${"{schema-editor}"}, true)`);
  await db.execute(sql`INSERT INTO memberships (tenant_id, user_id, roles, project_restricted) VALUES (${tenant}::uuid, ${bob}::uuid, ${"{viewer}"}, true)`);
  const [am] = await db.execute<{ id: string }>(sql`SELECT id FROM memberships WHERE user_id = ${alice}::uuid`);
  const [bm] = await db.execute<{ id: string }>(sql`SELECT id FROM memberships WHERE user_id = ${bob}::uuid`);
  const [adm] = await db.execute<{ id: string }>(sql`SELECT id FROM memberships WHERE user_id = ${adminUser}::uuid`);
  aliceMembershipId = am!.id;
  bobMembershipId = bm!.id;
  adminMembershipId = adm!.id;
});

describe("project members endpoints", () => {
  test("GET partitions into all-access, granted, and candidates", async () => {
    // Grant alice project-editor on A; bob stays a candidate.
    await db.execute(sql`INSERT INTO project_access (tenant_id, user_id, project_id, roles, created_by) VALUES (${tenant}::uuid, ${alice}::uuid, ${projA}::uuid, ${"{project-editor}"}, ${owner}::uuid)`);
    const res = await app().request("/api/projects/proj-a/members");
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    const byEmail = Object.fromEntries(body.members.map((m: any) => [m.email, m]));
    // owner + admin are all-access
    expect(byEmail["o@x.com"].access).toBe("all");
    expect(byEmail["admin@x.com"].access).toBe("all");
    // alice is granted with her project role
    expect(byEmail["alice@x.com"].access).toBe("granted");
    expect(byEmail["alice@x.com"].roles).toEqual(["project-editor"]);
    // bob is a candidate (restricted, no grant), NOT in members
    expect(byEmail["bob@x.com"]).toBeUndefined();
    expect(body.candidates.map((c: any) => c.email)).toContain("bob@x.com");
    expect(body.candidates.map((c: any) => c.email)).not.toContain("alice@x.com");
  });

  test("PUT grants a restricted member a role in the project", async () => {
    const res = await app().request(`/api/projects/proj-a/members/${bobMembershipId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roles: ["project-viewer"] }),
    });
    expect(res.status).toBe(200);
    const rows = await db.execute<{ roles: string[] }>(sql`SELECT roles FROM project_access WHERE user_id = ${bob}::uuid AND project_id = ${projA}::uuid`);
    expect(rows[0]?.roles).toEqual(["project-viewer"]);
  });

  test("PUT changing an existing grant's role replaces it (no duplicate row)", async () => {
    await db.execute(sql`INSERT INTO project_access (tenant_id, user_id, project_id, roles, created_by) VALUES (${tenant}::uuid, ${alice}::uuid, ${projA}::uuid, ${"{project-viewer}"}, ${owner}::uuid)`);
    const res = await app().request(`/api/projects/proj-a/members/${aliceMembershipId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roles: ["project-admin"] }),
    });
    expect(res.status).toBe(200);
    const rows = await db.execute<{ roles: string[] }>(sql`SELECT roles FROM project_access WHERE user_id = ${alice}::uuid AND project_id = ${projA}::uuid`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.roles).toEqual(["project-admin"]);
  });

  test("PUT refuses an all-access member (must restrict on Members page first)", async () => {
    const res = await app().request(`/api/projects/proj-a/members/${adminMembershipId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roles: ["project-viewer"] }),
    });
    expect(res.status).toBe(400);
  });

  test("PUT rejects an invalid project role", async () => {
    const res = await app().request(`/api/projects/proj-a/members/${bobMembershipId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roles: ["schema-editor"] }), // workspace role, not a project role
    });
    expect(res.status).toBe(400);
  });

  test("DELETE revokes a member's access to the project", async () => {
    await db.execute(sql`INSERT INTO project_access (tenant_id, user_id, project_id, roles, created_by) VALUES (${tenant}::uuid, ${alice}::uuid, ${projA}::uuid, ${"{project-editor}"}, ${owner}::uuid)`);
    const res = await app().request(`/api/projects/proj-a/members/${aliceMembershipId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const rows = await db.execute(sql`SELECT 1 FROM project_access WHERE user_id = ${alice}::uuid AND project_id = ${projA}::uuid`);
    expect(rows.length).toBe(0);
  });

  test("404 for an unknown project", async () => {
    const res = await app().request("/api/projects/nope/members");
    expect(res.status).toBe(404);
  });
});
