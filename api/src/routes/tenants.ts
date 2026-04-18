import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../index";
import { getUserId } from "../context";

export const tenants = new Hono<Env>();

/**
 * GET /api/tenants — list tenants the current user has access to.
 *
 * Returns tenants via the memberships join. Until auth is wired,
 * this returns all tenants the first user belongs to (typically just
 * the default tenant created during setup).
 */
tenants.get("/", async (c) => {
  const db = c.get("db");
  const userId = await getUserId(db);

  const rows = await db
    .select({
      id: schema.tenants.id,
      slug: schema.tenants.slug,
      displayName: schema.tenants.displayName,
    })
    .from(schema.tenants)
    .innerJoin(schema.memberships, eq(schema.memberships.tenantId, schema.tenants.id))
    .where(eq(schema.memberships.userId, userId));

  return c.json({ data: rows });
});

/**
 * PATCH /api/tenants/:slug — update tenant display name.
 */
tenants.patch("/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  const body = await c.req.json<{ display_name?: string }>();

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

  if (rows.length === 0) {
    return c.json({ error: "Tenant not found" }, 404);
  }
  return c.json(rows[0]);
});

/**
 * POST /api/tenants — create a new workspace.
 */
tenants.post("/", async (c) => {
  const db = c.get("db");
  const userId = await getUserId(db);
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

  // Check for slug collision
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
    plan: "pro",
  }).returning();

  // Add the current user as owner
  await db.insert(schema.memberships).values({
    userId,
    tenantId: tenant!.id,
    roles: ["tenant-owner", "project-admin", "schema-write", "pipeline-write", "review-write", "endpoint-write"],
  });

  return c.json({
    id: tenant!.id,
    slug: tenant!.slug,
    displayName: tenant!.displayName,
  }, 201);
});
