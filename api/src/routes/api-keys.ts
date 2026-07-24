import type { Context } from "hono";
import { Hono } from "hono";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, requireProjectId } from "../auth/middleware";

export const apiKeys = new Hono<Env>();

const WIDEN_DENIED =
  "Only a member with access to every project can give a key workspace-wide access.";

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

/**
 * Whether `caller` may edit or revoke a key with the given scope.
 *
 * Visibility (`visibleFromProject`) answers "can this key act here?", which is
 * the right question for a project-scoped LIST but the wrong one for managing
 * a key from the workspace-level API Keys page: the list there is unscoped, so
 * narrowing management by whichever project the session happened to have
 * selected made keys that were plainly listed 404 on save (oss-484).
 *
 * The rule instead follows reach: you may manage a key only if the key cannot
 * reach further than you can. An unrestricted caller (`accessible === null`)
 * manages any key in the workspace. A caller confined to a subset of projects
 * may manage a key only when every project that key reaches is inside that
 * subset — so a project-restricted member can't revoke or re-scope an
 * all-access key that other projects depend on.
 */
export function canManageKey(scope: KeyScope, accessible: Set<string> | null): boolean {
  if (accessible === null) return true;
  if (scope.mode === "all") return false;
  return scope.projectIds.every((id) => accessible.has(id));
}

/**
 * The caller's accessible-project set for management decisions. `null` from the
 * middleware means unrestricted; `undefined` means the middleware never ran, in
 * which case fail closed with an empty set rather than silently granting
 * workspace-wide reach.
 */
function accessibleForManagement(c: Context<Env>): Set<string> | null {
  const accessible = c.get("accessibleProjectIds") as Set<string> | null | undefined;
  return accessible === undefined ? new Set<string>() : accessible;
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
 * Resolve a `project_scope` request block into the pair the table stores:
 * a default `project_id` and a set of grant rows. Shared by create and the
 * scope edit so the two can't drift.
 *
 * Returns an error string instead of throwing so the caller controls status.
 *
 * `currentProjectId` is the request's resolved project — used as the "single"
 * target and as the preferred default for a multi-project key.
 */
export async function resolveProjectScope(
  db: Env["Variables"]["db"],
  tenantId: string,
  body: { mode?: "single" | "all" | "projects"; project_ids?: string[] } | undefined,
  currentProjectId: string | null,
): Promise<{ keyProjectId: string | null; grantProjectIds: string[] } | { error: string }> {
  const mode = body?.mode ?? "single";

  if (mode === "single") {
    if (!currentProjectId) {
      return { error: "No project in scope for a single-project key" };
    }
    return { keyProjectId: currentProjectId, grantProjectIds: [] };
  }

  if (mode === "all") {
    // NULL project_id is what makes a key genuinely tenant-wide: it matches
    // every project, including ones created after the key. A "projects" list
    // cannot do that — it is a snapshot, and a project added later is not in
    // it. That difference is the whole reason both modes exist.
    return { keyProjectId: null, grantProjectIds: [] };
  }

  if (mode === "projects") {
    const ids = [...new Set(body?.project_ids ?? [])];
    if (ids.length === 0) {
      return { error: "project_scope.project_ids must be a non-empty array" };
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
      return { error: `Unknown project(s): ${unknown.join(", ")}` };
    }
    // Default project when no x-koji-project header: prefer the request's
    // current project if it's in the set, else the first named project.
    const keyProjectId = currentProjectId && ids.includes(currentProjectId) ? currentProjectId : ids[0]!;
    return { keyProjectId, grantProjectIds: ids };
  }

  return { error: `Invalid project_scope.mode: ${mode}` };
}

/**
 * Whether the caller may give a key workspace-wide reach. Mirrors the provider
 * credential rule: widening a key past the caller's own reach is not something
 * a project-restricted member gets to do. `accessibleProjectIds` is null for an
 * unrestricted member / all-access key.
 */
function canWidenToWorkspace(c: Context<Env>): boolean {
  return c.get("accessibleProjectIds") === null;
}

/**
 * GET /api/api-keys — list active (non-revoked) API keys visible from the
 * request's project scope.
 */
apiKeys.get("/", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  // This route uses raw db (not withRLS), so the scope filter is explicit.
  //
  // `?scope=workspace` lists every key in the workspace instead of only those
  // reachable from the current project — what the workspace-level API Keys
  // page renders. A key can span projects, so "which keys exist" is a
  // workspace question; narrowing by project made a multi-project key show up
  // once per project and gave no single place to see them all. Callers who are
  // themselves confined to a subset of projects keep the narrowed view.
  const wantsWorkspace =
    c.req.query("scope") === "workspace" && c.get("accessibleProjectIds") === null;
  const projectId = wantsWorkspace ? null : getProjectId(c);

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
  if (mode === "all" && !canWidenToWorkspace(c)) {
    return c.json({ error: WIDEN_DENIED }, 403);
  }
  const resolved = await resolveProjectScope(
    db,
    tenantId,
    body.project_scope,
    mode === "single" ? requireProjectId(c) : getProjectId(c),
  );
  if ("error" in resolved) return c.json({ error: resolved.error }, 400);
  const { keyProjectId, grantProjectIds } = resolved;

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
 * PATCH /api/api-keys/:id — rename a key and/or change which projects it can
 * act in.
 *
 * Scope used to be fixed at creation, so widening a key meant revoking and
 * reissuing it — every consumer of that key had to be updated to rotate a
 * value that didn't need to change. The secret is never touched here; only the
 * key's reach.
 *
 * Body: { name?, project_scope?: { mode, project_ids? } } — the same
 * `project_scope` shape POST takes.
 */
apiKeys.patch("/:id", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const currentProjectId = getProjectId(c);
  const keyId = c.req.param("id")!;

  const body = await c.req.json<{
    name?: string;
    project_scope?: { mode?: "single" | "all" | "projects"; project_ids?: string[] };
  }>();

  const [existing] = await db
    .select({
      id: schema.apiKeys.id,
      projectId: schema.apiKeys.projectId,
      revokedAt: schema.apiKeys.revokedAt,
    })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.tenantId, tenantId)))
    .limit(1);
  if (!existing) return c.json({ error: "API key not found" }, 404);
  if (existing.revokedAt) {
    return c.json({ error: "This key has been revoked and can no longer be changed." }, 409);
  }

  // Manageability is about reach, not about which project the session happens
  // to have selected — the workspace page lists every key regardless.
  const [withScope] = await loadVisibleKeys(db, tenantId, null, [existing]);
  const visible =
    withScope && canManageKey(withScope.scope, accessibleForManagement(c)) ? withScope : undefined;
  if (!visible) return c.json({ error: "API key not found" }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: "Name cannot be empty" }, 400);
    updates.name = body.name.trim();
  }

  let newScope = visible.scope;
  if (body.project_scope) {
    const mode = body.project_scope.mode ?? "single";
    if (mode === "all" && !canWidenToWorkspace(c)) {
      return c.json({ error: WIDEN_DENIED }, 403);
    }
    const resolved = await resolveProjectScope(db, tenantId, body.project_scope, currentProjectId);
    if ("error" in resolved) return c.json({ error: resolved.error }, 400);
    updates.projectId = resolved.keyProjectId;
    newScope = deriveScope(resolved.keyProjectId, resolved.grantProjectIds);

    // Grants are replaced wholesale: the request states the key's project set,
    // it doesn't append to it. Delete-then-insert so dropping a project takes
    // effect rather than lingering as a stale grant.
    await db
      .delete(schema.apiKeyProjectAccess)
      .where(
        and(
          eq(schema.apiKeyProjectAccess.tenantId, tenantId),
          eq(schema.apiKeyProjectAccess.apiKeyId, keyId),
        ),
      );
    if (resolved.grantProjectIds.length > 0) {
      await db.insert(schema.apiKeyProjectAccess).values(
        resolved.grantProjectIds.map((projectId) => ({ tenantId, apiKeyId: keyId, projectId })),
      );
    }
  }

  if (Object.keys(updates).length > 0) {
    await db
      .update(schema.apiKeys)
      .set(updates)
      .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.tenantId, tenantId)));
  }

  return c.json({ id: keyId, scope: newScope });
});

/**
 * DELETE /api/api-keys/:id — revoke an API key (soft-delete).
 */
apiKeys.delete("/:id", requires("api_key:write"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const keyId = c.req.param("id")!;

  const [key] = await db
    .select({ id: schema.apiKeys.id, projectId: schema.apiKeys.projectId })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.tenantId, tenantId)))
    .limit(1);

  if (!key) {
    return c.json({ error: "API key not found" }, 404);
  }

  // Revocation follows the same reach rule as editing: a caller confined to a
  // subset of projects must not be able to revoke a key that other projects
  // depend on (an all-access key is visible from every project, so the old
  // visibility check let them).
  const [scoped] = await loadVisibleKeys(db, tenantId, null, [key]);
  if (!scoped || !canManageKey(scoped.scope, accessibleForManagement(c))) {
    return c.json({ error: "API key not found" }, 404);
  }

  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyId));

  return c.json({ ok: true });
});
