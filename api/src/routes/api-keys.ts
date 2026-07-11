import { Hono } from "hono";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";

export const apiKeys = new Hono<Env>();

/**
 * A key's project scope (oss-433), mirroring the member `projectRestricted`
 * model. Derived from the row's `project_id` + its `api_key_project_access`
 * grant rows:
 *   - single: one bound project (the default; every legacy key)
 *   - projects: a specific set of projects (grant rows)
 *   - all: any project in the tenant (null project_id, no grants)
 */
type KeyScope =
  | { mode: "single"; projectId: string; projectIds: string[] }
  | { mode: "projects"; projectId: string | null; projectIds: string[] }
  | { mode: "all"; projectId: null; projectIds: [] };

export function deriveScope(keyProjectId: string | null, grantProjectIds: string[]): KeyScope {
  if (grantProjectIds.length > 0) {
    return { mode: "projects", projectId: keyProjectId, projectIds: grantProjectIds };
  }
  if (keyProjectId === null) {
    return { mode: "all", projectId: null, projectIds: [] };
  }
  return { mode: "single", projectId: keyProjectId, projectIds: [keyProjectId] };
}

/**
 * Whether a key with the given scope is visible/manageable from the request's
 * resolved project. A tenant-wide caller (no project) sees every key. A
 * project-scoped caller sees: keys bound to that project, all-access keys
 * (tenant-wide), and multi-project keys that include that project.
 */
export function visibleFromProject(scope: KeyScope, projectId: string | null): boolean {
  if (!projectId) return true; // tenant-wide caller
  if (scope.mode === "all") return true;
  if (scope.mode === "single") return scope.projectId === projectId;
  return scope.projectIds.includes(projectId);
}

type ScopedKey<T> = T & { scope: KeyScope };

/**
 * Load the tenant's keys joined with their project grants, tagged with a
 * derived scope, filtered to those visible from the resolved project.
 */
async function loadVisibleKeys<T extends { id: string; projectId: string | null }>(
  db: Env["Variables"]["db"],
  tenantId: string,
  currentProjectId: string | null,
  rows: T[],
): Promise<ScopedKey<T>[]> {
  const keyIds = rows.map((r) => r.id);
  const grantRows = keyIds.length
    ? await db
        .select({ apiKeyId: schema.apiKeyProjectAccess.apiKeyId, projectId: schema.apiKeyProjectAccess.projectId })
        .from(schema.apiKeyProjectAccess)
        .where(
          and(
            eq(schema.apiKeyProjectAccess.tenantId, tenantId),
            inArray(schema.apiKeyProjectAccess.apiKeyId, keyIds),
          ),
        )
    : [];
  const grantsByKey = new Map<string, string[]>();
  for (const g of grantRows) {
    const list = grantsByKey.get(g.apiKeyId) ?? [];
    list.push(g.projectId);
    grantsByKey.set(g.apiKeyId, list);
  }
  return rows
    .map((r) => ({ ...r, scope: deriveScope(r.projectId, grantsByKey.get(r.id) ?? []) }))
    .filter((r) => visibleFromProject(r.scope, currentProjectId));
}

/**
 * GET /api/api-keys — list active (non-revoked) API keys visible from the
 * request's project scope.
 */
apiKeys.get("/", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  // This route uses raw db (not withRLS), so the scope filter is explicit.
  const projectId = getProjectId(c);

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      projectId: schema.apiKeys.projectId,
      name: schema.apiKeys.name,
      keyPrefix: schema.apiKeys.keyPrefix,
      scopes: schema.apiKeys.scopes,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
      revokedAt: schema.apiKeys.revokedAt,
      createdByName: schema.users.name,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy))
    .where(eq(schema.apiKeys.tenantId, tenantId))
    .orderBy(schema.apiKeys.createdAt);

  const visible = await loadVisibleKeys(db, tenantId, projectId, rows);

  return c.json({
    data: visible.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      scopes: r.scopes,
      scope: r.scope,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      createdBy: r.createdByName,
    })),
  });
});

/**
 * POST /api/api-keys — create a new API key.
 *
 * `project_scope` controls which project(s) the key can act in (oss-433):
 *   - { mode: "single" } (default) — the request's current project.
 *   - { mode: "all" } — every project in the tenant (tenant-wide key).
 *   - { mode: "projects", project_ids: [...] } — a specific set of projects.
 *
 * Returns the full key ONCE in the response. After this, only the
 * prefix is available (the full key is hashed for storage).
 */
apiKeys.post("/", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    name: string;
    scopes?: string[];
    expires_in_days?: number;
    project_scope?: { mode?: "single" | "all" | "projects"; project_ids?: string[] };
  }>();

  if (!body.name || body.name.trim().length === 0) {
    return c.json({ error: "Name is required" }, 400);
  }

  // Resolve the key's project scope into a default project_id + grant set.
  const mode = body.project_scope?.mode ?? "single";
  let keyProjectId: string | null;
  let grantProjectIds: string[] = [];

  if (mode === "single") {
    keyProjectId = requireProjectId(c);
  } else if (mode === "all") {
    keyProjectId = null;
  } else if (mode === "projects") {
    const ids = [...new Set(body.project_scope?.project_ids ?? [])];
    if (ids.length === 0) {
      return c.json({ error: "project_scope.project_ids must be a non-empty array" }, 400);
    }
    // Every named project must be a live project in this tenant.
    const valid = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.tenantId, tenantId),
          inArray(schema.projects.id, ids),
          isNull(schema.projects.deletedAt),
        ),
      );
    const validIds = new Set(valid.map((v) => v.id));
    const unknown = ids.filter((i) => !validIds.has(i));
    if (unknown.length > 0) {
      return c.json({ error: `Unknown project(s): ${unknown.join(", ")}` }, 400);
    }
    grantProjectIds = ids;
    // Default project when no x-koji-project header: prefer the request's
    // current project if it's in the set, else the first named project.
    const current = getProjectId(c);
    keyProjectId = current && ids.includes(current) ? current : ids[0]!;
  } else {
    return c.json({ error: `Invalid project_scope.mode: ${mode}` }, 400);
  }

  // Generate the key: koji_<32 random hex chars>
  const rawKey = `koji_${randomBytes(32).toString("hex")}`;
  const prefix = rawKey.slice(0, 8) + "..." + rawKey.slice(-4); // fits varchar(16)
  const keyHash = createHash("sha256").update(rawKey).digest();

  const scopes = body.scopes ?? ["*"];
  const expiresAt = body.expires_in_days
    ? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000)
    : null;

  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      tenantId,
      projectId: keyProjectId,
      name: body.name.trim(),
      keyPrefix: prefix,
      keyHash,
      scopes,
      createdBy: principal.userId,
      expiresAt,
    })
    .returning();

  if (grantProjectIds.length > 0) {
    await db.insert(schema.apiKeyProjectAccess).values(
      grantProjectIds.map((projectId) => ({
        tenantId,
        apiKeyId: row!.id,
        projectId,
      })),
    );
  }

  return c.json({
    id: row!.id,
    name: row!.name,
    keyPrefix: prefix,
    key: rawKey, // Only returned on creation — store it now!
    scopes,
    scope: deriveScope(keyProjectId, grantProjectIds),
    expiresAt,
    createdAt: row!.createdAt,
  }, 201);
});

/**
 * DELETE /api/api-keys/:id — revoke an API key (soft-delete).
 */
apiKeys.delete("/:id", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  // Scope revocation exactly like the list (GET): a project-admin must only be
  // able to revoke keys that are visible from — i.e. can act in — their
  // project. All-access and multi-project keys are visible from any project
  // they include.
  const projectId = getProjectId(c);
  const keyId = c.req.param("id")!;

  const [key] = await db
    .select({ id: schema.apiKeys.id, projectId: schema.apiKeys.projectId })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.tenantId, tenantId)))
    .limit(1);

  if (!key) {
    return c.json({ error: "API key not found" }, 404);
  }

  const [scoped] = await loadVisibleKeys(db, tenantId, projectId, [key]);
  if (!scoped) {
    return c.json({ error: "API key not found" }, 404);
  }

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyId));

  return c.json({ ok: true });
});
