import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { getPrincipal } from "../auth/middleware";
import { createRateLimiter } from "../rate-limit";

// Max 3 tenant creations per IP per day (free-tier abuse protection)
const tenantCreateLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });

export const tenants = new Hono<Env>();

/**
 * GET /api/tenants — list tenants the current user belongs to.
 *
 * This is a no-tenant route (doesn't need x-koji-tenant header).
 * Used by the project switcher and onboarding.
 */
tenants.get("/", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);

  const rows = await db
    .select({
      id: schema.tenants.id,
      slug: schema.tenants.slug,
      displayName: schema.tenants.displayName,
      roles: schema.memberships.roles,
    })
    .from(schema.tenants)
    .innerJoin(schema.memberships, eq(schema.memberships.tenantId, schema.tenants.id))
    .where(eq(schema.memberships.userId, principal.userId));

  return c.json({ data: rows });
});

/**
 * PATCH /api/tenants/:slug — update tenant display name.
 * Requires tenant-admin role (enforced via x-koji-tenant + requires()).
 * But since tenants route is mounted as no-tenant, we check membership inline.
 */
tenants.patch("/:slug", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ display_name?: string }>();

  // Find tenant + verify membership with admin role
  const [tenant] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, slug))
    .limit(1);

  if (!tenant) {
    return c.json({ error: "Tenant not found" }, 404);
  }

  const [membership] = await db
    .select({ roles: schema.memberships.roles })
    .from(schema.memberships)
    .where(
      eq(schema.memberships.userId, principal.userId),
    )
    .limit(1);

  if (!membership) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }

  const { resolvePermissions } = await import("../auth/roles");
  const grants = resolvePermissions(membership.roles);
  if (!grants.has("tenant:admin")) {
    return c.json({ code: "forbidden", message: "Missing permission: tenant:admin" }, 403);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.display_name) updates.displayName = body.display_name;

  const rows = await db
    .update(schema.tenants)
    .set(updates)
    .where(eq(schema.tenants.slug, slug))
    .returning({
      id: schema.tenants.id,
      slug: schema.tenants.slug,
      displayName: schema.tenants.displayName,
    });

  return c.json(rows[0]);
});

/**
 * POST /api/tenants — create a new workspace.
 * Any authenticated user can create a workspace. They become the owner.
 */
tenants.post("/", async (c) => {
  // IP-based signup throttle — max 3 workspaces per IP per day
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
  if (!tenantCreateLimiter.check(ip)) {
    return c.json({ error: "Too many workspace creations. Try again tomorrow." }, 429);
  }

  const db = c.get("db");
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    slug: string;
    display_name: string;
  }>();

  if (!body.slug || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.slug)) {
    return c.json({ error: "Slug must be lowercase letters, numbers, and hyphens (2-64 chars)" }, 400);
  }
  if (!body.display_name) {
    return c.json({ error: "Display name is required" }, 400);
  }

  const existing = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, body.slug))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: `Workspace URL "${body.slug}" is already taken` }, 409);
  }

  const [tenant] = await db.insert(schema.tenants).values({
    slug: body.slug,
    displayName: body.display_name,
    plan: "scale",
  }).returning();

  // Creator becomes owner
  await db.insert(schema.memberships).values({
    userId: principal.userId,
    tenantId: tenant!.id,
    roles: ["owner"],
  });

  return c.json({
    id: tenant!.id,
    slug: tenant!.slug,
    displayName: tenant!.displayName,
  }, 201);
});
