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
