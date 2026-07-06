import { Hono } from "hono";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getRoles } from "../auth/middleware";
import { highestRoleRank, isValidRole, ROLE_RANK } from "../auth/roles";

export const members = new Hono<Env>();

/**
 * GET /api/members — list all members of the current tenant.
 */
members.get("/", requires("member:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await db
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      createdAt: schema.memberships.createdAt,
      userName: schema.users.name,
      userEmail: schema.users.email,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(
      eq(schema.memberships.tenantId, tenantId),
      eq(schema.memberships.isShadow, false),
    ));

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.userName,
      email: r.userEmail,
      roles: r.roles,
      lastLoginAt: r.lastLoginAt,
      createdAt: r.createdAt,
    })),
  });
});

/**
 * PATCH /api/members/:id — update a member's roles.
 */
members.patch("/:id", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const membershipId = c.req.param("id")!;
  const principal = getPrincipal(c);
  const myRoles = getRoles(c);
  const body = await c.req.json<{ roles: string[] }>();

  if (!body.roles || body.roles.length === 0) {
    return c.json({ error: "At least one role is required" }, 400);
  }

  for (const role of body.roles) {
    if (!isValidRole(role)) {
      return c.json({ error: `Invalid role: ${role}` }, 400);
    }
  }

  // Can't grant roles above your own
  const myMax = highestRoleRank(myRoles);
  const targetMax = highestRoleRank(body.roles);
  if (targetMax > myMax) {
    return c.json({ error: "Cannot assign a role higher than your own" }, 403);
  }

  // Find the membership
  const [membership] = await db
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      isShadow: schema.memberships.isShadow,
    })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!membership || membership.isShadow) {
    return c.json({ error: "Member not found" }, 404);
  }

  // Can't demote someone with a higher role than you
  const theirMax = highestRoleRank(membership.roles);
  if (theirMax > myMax) {
    return c.json({ error: "Cannot modify a member with a higher role than your own" }, 403);
  }

  await db
    .update(schema.memberships)
    .set({ roles: body.roles, updatedAt: new Date() })
    .where(eq(schema.memberships.id, membershipId));

  return c.json({ ok: true });
});

/**
 * DELETE /api/members/:id — remove a member from the tenant.
 */
members.delete("/:id", requires("member:remove"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const membershipId = c.req.param("id")!;
  const principal = getPrincipal(c);
  const myRoles = getRoles(c);

  const [membership] = await db
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      isShadow: schema.memberships.isShadow,
    })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!membership || membership.isShadow) {
    return c.json({ error: "Member not found" }, 404);
  }

  // Can't remove yourself via this endpoint
  if (membership.userId === principal.userId) {
    return c.json({ error: "Cannot remove yourself. Use account deletion instead." }, 400);
  }

  // Can't remove someone with a higher role
  const myMax = highestRoleRank(myRoles);
  const theirMax = highestRoleRank(membership.roles);
  if (theirMax > myMax) {
    return c.json({ error: "Cannot remove a member with a higher role than your own" }, 403);
  }

  await db
    .delete(schema.memberships)
    .where(eq(schema.memberships.id, membershipId));

  return c.json({ ok: true });
});

/** Resolve a membership by id within the tenant. Returns null if missing/shadow. */
async function findMembership(db: any, tenantId: string, membershipId: string) {
  const [m] = await db
    .select({
      id: schema.memberships.id,
      userId: schema.memberships.userId,
      roles: schema.memberships.roles,
      projectRestricted: schema.memberships.projectRestricted,
      isShadow: schema.memberships.isShadow,
    })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), eq(schema.memberships.tenantId, tenantId)))
    .limit(1);
  return m && !m.isShadow ? m : null;
}

/**
 * GET /api/members/:id/project-access — a member's project-access setting.
 * `restricted: false` means all projects; otherwise `projects` is the allowed
 * set (by slug).
 */
members.get("/:id/project-access", requires("member:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const m = await findMembership(db, tenantId, c.req.param("id")!);
  if (!m) return c.json({ error: "Member not found" }, 404);

  const rows = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ slug: schema.projects.slug, displayName: schema.projects.displayName })
      .from(schema.projectAccess)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectAccess.projectId))
      .where(and(eq(schema.projectAccess.userId, m.userId), isNull(schema.projects.deletedAt))),
  );

  return c.json({
    restricted: m.projectRestricted,
    projects: rows.map((r) => ({ slug: r.slug, displayName: r.displayName })),
  });
});

/**
 * PUT /api/members/:id/project-access — set a member's project access.
 * Body: { restricted: boolean, project_slugs?: string[] }. When `restricted`,
 * the member may access exactly `project_slugs`; otherwise they see all
 * projects and any grants are cleared.
 */
members.put("/:id/project-access", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const m = await findMembership(db, tenantId, c.req.param("id")!);
  if (!m) return c.json({ error: "Member not found" }, 404);

  // Can't restrict someone who outranks you (mirrors PATCH/DELETE) — otherwise
  // a tenant-admin could curtail an owner's project access.
  if (highestRoleRank(m.roles) > highestRoleRank(getRoles(c))) {
    return c.json({ error: "Cannot modify a member with a higher role than your own" }, 403);
  }

  const body = await c.req.json<{ restricted: boolean; project_slugs?: string[] }>();
  const restricted = body.restricted === true;
  const slugs = restricted ? [...new Set(body.project_slugs ?? [])] : [];

  // Resolve slugs → live project ids up front so we can 400 cleanly.
  let projectIds: string[] = [];
  if (slugs.length > 0) {
    const rows = await withRLS(db, tenantId, (tx) =>
      tx
        .select({ id: schema.projects.id, slug: schema.projects.slug })
        .from(schema.projects)
        .where(and(inArray(schema.projects.slug, slugs), isNull(schema.projects.deletedAt))),
    );
    const found = new Set(rows.map((r) => r.slug));
    const missing = slugs.filter((s) => !found.has(s));
    if (missing.length > 0) {
      return c.json({ error: `Unknown project(s): ${missing.join(", ")}` }, 400);
    }
    projectIds = rows.map((r) => r.id);
  }

  await withRLS(db, tenantId, async (tx) => {
    // Replace the grant set, then flip the flag — one transaction.
    await tx.delete(schema.projectAccess).where(eq(schema.projectAccess.userId, m.userId));
    if (projectIds.length > 0) {
      await tx.insert(schema.projectAccess).values(
        projectIds.map((pid) => ({
          tenantId,
          userId: m.userId,
          projectId: pid,
          createdBy: principal.userId,
        })),
      );
    }
    await tx
      .update(schema.memberships)
      .set({ projectRestricted: restricted, updatedAt: new Date() })
      .where(eq(schema.memberships.id, m.id));
  });

  return c.json({ ok: true, restricted, projects: slugs });
});
