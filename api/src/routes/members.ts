import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { schema } from "@koji/db";
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
    .where(eq(schema.memberships.tenantId, tenantId));

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
    .select({ id: schema.memberships.id, userId: schema.memberships.userId, roles: schema.memberships.roles })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!membership) {
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
    .select({ id: schema.memberships.id, userId: schema.memberships.userId, roles: schema.memberships.roles })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.id, membershipId),
        eq(schema.memberships.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!membership) {
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
