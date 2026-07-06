import { Hono } from "hono";
import { eq, and, isNull, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getProjectId, getGrants, getRoles, getAccessibleProjectIds } from "../auth/middleware";
import type { Permission } from "../auth/roles";
import { highestRoleRank, isValidProjectRole } from "../auth/roles";
import { moveResource, MOVE_PERMISSION, type MovableType } from "../projects/move";

export const projects = new Hono<Env>();

const MOVABLE_TYPES = new Set<MovableType>([
  "schema", "pipeline", "source", "classifier",
  "model_endpoint", "parse_endpoint", "webhook_target", "api_key",
]);

/**
 * POST /api/projects/:slug/move — move a resource into this project.
 *
 * Body: { type: MovableType, id: string, dry_run?: boolean }. Gated by the
 * moved resource's own write permission (moving is a write to that resource).
 * Returns 409 with `{ blockers }` when the move would strand a cross-project
 * reference, or `{ conflict }` on a slug clash — the dashboard surfaces both.
 */
projects.post("/:slug/move", async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const destSlug = c.req.param("slug")!;
  const body = await c.req.json<{ type: string; id: string; dry_run?: boolean }>();

  if (!body.type || !MOVABLE_TYPES.has(body.type as MovableType)) {
    return c.json({ error: `Unknown or unmovable resource type: ${body.type}` }, 400);
  }
  if (!body.id) return c.json({ error: "id is required" }, 400);
  const type = body.type as MovableType;

  // Moving a resource is a write to it — require that type's write permission.
  const grants = getGrants(c);
  if (!grants.has(MOVE_PERMISSION[type] as Permission)) {
    return c.json({ code: "forbidden", message: `Missing permission: ${MOVE_PERMISSION[type]}` }, 403);
  }

  // Resolve the destination project (tenant-scoped; the move itself reads
  // tenant-wide so it can see the resource in its current project).
  const [dest] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.slug, destSlug), isNull(schema.projects.deletedAt)))
      .limit(1),
  );
  if (!dest) return c.json({ error: "Destination project not found" }, 404);

  const result = await moveResource(db, tenantId, type, body.id, dest.id, {
    dryRun: body.dry_run === true,
  });

  switch (result.status) {
    case "moved":
      return c.json({ ok: true, dryRun: body.dry_run === true });
    case "noop":
      return c.json({ ok: true, alreadyInProject: true });
    case "not_found":
      return c.json({ error: "Resource not found" }, 404);
    case "slug_conflict":
      return c.json(
        { error: `The destination project already has a ${type} named "${result.conflictWith}"`, conflict: result.conflictWith },
        409,
      );
    case "blocked":
      return c.json(
        {
          error: "Move would leave a resource referencing another project. Move these first, or into the same project.",
          blockers: result.blockers,
        },
        409,
      );
  }
});

projects.get("/", requires("tenant:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.projects.id,
        slug: schema.projects.slug,
        displayName: schema.projects.displayName,
        description: schema.projects.description,
        createdAt: schema.projects.createdAt,
      })
      .from(schema.projects)
      .where(sql`deleted_at IS NULL`)
  );
  // Restricted members only see the projects they can access — this is what
  // scopes the dashboard's project switcher.
  const accessible = getAccessibleProjectIds(c);
  const data = accessible === null ? rows : rows.filter((r) => accessible.has(r.id));
  return c.json({ data });
});

projects.get("/:slug", requires("tenant:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.slug, slug))
      .limit(1)
  );
  if (rows.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }
  return c.json(rows[0]);
});

/**
 * POST /api/projects/setup — first-time setup: create tenant + membership + project.
 *
 * Called when a new user has no tenant. Creates everything in one go.
 * No tenant context required — the user just needs to be authenticated.
 * After this, the user has an owner membership and can use all tenant-scoped routes.
 */
projects.post("/setup", async (c) => {
  const db = c.get("db");
  const principal = c.get("principal");
  if (!principal) return c.json({ error: "Authentication required" }, 401);

  // On hosted (Clerk auth), tenants are created through the admin portal,
  // not by end users. Block self-service setup to prevent orphan tenants
  // that have no Clerk org backing them.
  if (principal.orgId) {
    return c.json({ error: "Workspaces are managed by your organization admin" }, 403);
  }

  const body = await c.req.json<{
    slug: string;
    display_name: string;
    description?: string;
  }>();

  if (!body.slug || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.slug)) {
    return c.json({ error: "Slug must be lowercase letters, numbers, and hyphens (2-64 chars)" }, 400);
  }
  if (!body.display_name) {
    return c.json({ error: "Display name is required" }, 400);
  }

  // Check if user already has a tenant
  const existingMembership = await db
    .select({ tenantId: schema.memberships.tenantId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, principal.userId))
    .limit(1);

  if (existingMembership.length > 0) {
    return c.json({ error: "You already have a workspace. Use POST /api/projects to create additional projects." }, 409);
  }

  // Create tenant
  const [tenant] = await db
    .insert(schema.tenants)
    .values({
      displayName: body.display_name,
      slug: body.slug,
      plan: "free",
    })
    .returning({ id: schema.tenants.id, slug: schema.tenants.slug });

  if (!tenant) return c.json({ error: "Failed to create workspace" }, 500);

  // Create owner membership
  await db.insert(schema.memberships).values({
    tenantId: tenant.id,
    userId: principal.userId,
    roles: ["owner"],
    acceptedAt: new Date(),
  });

  // Create default project
  const [project] = await db
    .insert(schema.projects)
    .values({
      tenantId: tenant.id,
      slug: body.slug,
      displayName: body.display_name,
      description: body.description ?? null,
      createdBy: principal.userId,
    })
    .returning();

  return c.json({ tenant: { id: tenant.id, slug: tenant.slug }, project: project }, 201);
});

projects.post("/", requires("tenant:admin"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    slug: string;
    display_name: string;
    description?: string;
  }>();

  if (!body.slug || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.slug)) {
    return c.json({ error: "Slug must be lowercase letters, numbers, and hyphens (2-64 chars)" }, 400);
  }
  if (!body.display_name) {
    return c.json({ error: "Display name is required" }, 400);
  }

  const existing = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, body.slug))
      .limit(1)
  );
  if (existing.length > 0) {
    return c.json({ error: `Project "${body.slug}" already exists` }, 409);
  }

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .insert(schema.projects)
      .values({
        tenantId,
        slug: body.slug,
        displayName: body.display_name,
        description: body.description ?? null,
        createdBy: principal.userId,
      })
      .returning()
  );
  return c.json(rows[0], 201);
});

projects.patch("/:slug", requires("tenant:admin"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;
  const body = await c.req.json<{ display_name?: string; description?: string }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;

  const rows = await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.projects)
      .set(updates)
      .where(eq(schema.projects.slug, slug))
      .returning()
  );
  if (rows.length === 0) {
    return c.json({ error: "Project not found" }, 404);
  }
  return c.json(rows[0]);
});

projects.delete("/:slug", requires("tenant:admin"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  // A tenant must always keep at least one live project — resources can only
  // be created inside a project, and API keys/nav resolve against one.
  const live = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.projects.id, slug: schema.projects.slug })
      .from(schema.projects)
      .where(isNull(schema.projects.deletedAt)),
  );
  if (live.length === 1 && live[0]!.slug === slug) {
    return c.json({ error: "Cannot delete the last project in a workspace" }, 400);
  }

  await withRLS(db, { tenantId, projectId: getProjectId(c) }, (tx) =>
    tx
      .update(schema.projects)
      .set({ deletedAt: new Date() })
      .where(eq(schema.projects.slug, slug))
  );
  return c.body(null, 204);
});

// ───────────────────────────────────────────────────────────────────────────
// Project-centric member management (oss-383). The Members page manages one
// member across all projects; this manages one project's roster. Both write
// the same `project_access` rows. Gated by member:invite (workspace admins).
// ───────────────────────────────────────────────────────────────────────────

/** Resolve a project by slug within the tenant, or null. */
async function findProject(db: any, tenantId: string, slug: string) {
  const [p] = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.projects.id, slug: schema.projects.slug, displayName: schema.projects.displayName })
      .from(schema.projects)
      .where(and(eq(schema.projects.slug, slug), isNull(schema.projects.deletedAt)))
      .limit(1),
  );
  return p ?? null;
}

/**
 * GET /api/projects/:slug/members — who can access this project.
 *   - `members`: everyone with access. `access:"granted"` = a restricted member
 *     explicitly granted here (with their project `roles`); `access:"all"` = an
 *     unrestricted member (owner/admin) who sees every project (workspace role,
 *     managed from the Members page).
 *   - `candidates`: restricted members NOT yet on this project (the add picker).
 *
 * Admin-gated (member:invite) — this is a management surface, and it would
 * otherwise let any member with member:read enumerate the roster of a project
 * they can't access.
 */
projects.get("/:slug/members", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const project = await findProject(db, tenantId, c.req.param("slug")!);
  if (!project) return c.json({ error: "Project not found" }, 404);

  // All tenant members (memberships is global — filtered by tenantId).
  const allMembers = await db
    .select({
      membershipId: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      restricted: schema.memberships.projectRestricted,
      isShadow: schema.memberships.isShadow,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.isShadow, false)));

  // This project's explicit grants (restricted members) → their project roles.
  const grantRows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ userId: schema.projectAccess.userId, roles: schema.projectAccess.roles })
      .from(schema.projectAccess)
      .where(eq(schema.projectAccess.projectId, project.id)),
  );
  const grantByUser = new Map(grantRows.map((g) => [g.userId, g.roles]));

  const members: any[] = [];
  const candidates: any[] = [];
  for (const m of allMembers) {
    const base = { membershipId: m.membershipId, userId: m.userId, name: m.name, email: m.email };
    if (!m.restricted) {
      members.push({ ...base, access: "all", roles: m.roles });
    } else if (grantByUser.has(m.userId)) {
      members.push({ ...base, access: "granted", roles: grantByUser.get(m.userId) });
    } else {
      candidates.push(base);
    }
  }

  return c.json({ project: { slug: project.slug, displayName: project.displayName }, members, candidates });
});

/**
 * PUT /api/projects/:slug/members/:membershipId — grant/update a restricted
 * member's role in THIS project. Body: { roles: ProjectRole[] }. The member
 * must be project-restricted (an all-access member is managed from the Members
 * page — restrict them there first).
 */
projects.put("/:slug/members/:membershipId", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const project = await findProject(db, tenantId, c.req.param("slug")!);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const [m] = await db
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      restricted: schema.memberships.projectRestricted,
      isShadow: schema.memberships.isShadow,
    })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, c.req.param("membershipId")!), eq(schema.memberships.tenantId, tenantId)))
    .limit(1);
  if (!m || m.isShadow) return c.json({ error: "Member not found" }, 404);

  if (highestRoleRank(m.roles) > highestRoleRank(getRoles(c))) {
    return c.json({ error: "Cannot modify a member with a higher role than your own" }, 403);
  }
  if (!m.restricted) {
    return c.json({ error: "This member already has access to all projects. Restrict them on the Members page first." }, 400);
  }

  const body = await c.req.json<{ roles?: string[] }>();
  const roles = body.roles && body.roles.length > 0 ? body.roles : ["project-member"];
  for (const r of roles) {
    if (!isValidProjectRole(r)) return c.json({ error: `Invalid project role: ${r}` }, 400);
  }

  await withRLS(db, tenantId, async (tx) => {
    await tx
      .delete(schema.projectAccess)
      .where(and(eq(schema.projectAccess.userId, m.userId), eq(schema.projectAccess.projectId, project.id)));
    await tx.insert(schema.projectAccess).values({
      tenantId,
      userId: m.userId,
      projectId: project.id,
      roles,
      createdBy: principal.userId,
    });
  });

  return c.json({ ok: true, roles });
});

/**
 * DELETE /api/projects/:slug/members/:membershipId — revoke a member's access
 * to THIS project (removes the grant row). No-op for all-access members.
 */
projects.delete("/:slug/members/:membershipId", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const project = await findProject(db, tenantId, c.req.param("slug")!);
  if (!project) return c.json({ error: "Project not found" }, 404);

  const [m] = await db
    .select({ userId: schema.memberships.userId, roles: schema.memberships.roles, isShadow: schema.memberships.isShadow })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, c.req.param("membershipId")!), eq(schema.memberships.tenantId, tenantId)))
    .limit(1);
  if (!m || m.isShadow) return c.json({ error: "Member not found" }, 404);

  if (highestRoleRank(m.roles) > highestRoleRank(getRoles(c))) {
    return c.json({ error: "Cannot modify a member with a higher role than your own" }, 403);
  }

  await withRLS(db, tenantId, (tx) =>
    tx
      .delete(schema.projectAccess)
      .where(and(eq(schema.projectAccess.userId, m.userId), eq(schema.projectAccess.projectId, project.id))),
  );
  return c.body(null, 204);
});
