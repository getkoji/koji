import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal } from "../auth/middleware";

export const projects = new Hono<Env>();

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
  return c.json({ data: rows });
});

projects.get("/:slug", requires("tenant:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const slug = c.req.param("slug")!;

  const rows = await withRLS(db, tenantId, (tx) =>
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

  const existing = await withRLS(db, tenantId, (tx) =>
    tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, body.slug))
      .limit(1)
  );
  if (existing.length > 0) {
    return c.json({ error: `Project "${body.slug}" already exists` }, 409);
  }

  const rows = await withRLS(db, tenantId, (tx) =>
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

  const rows = await withRLS(db, tenantId, (tx) =>
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

  await withRLS(db, tenantId, (tx) =>
    tx
      .update(schema.projects)
      .set({ deletedAt: new Date() })
      .where(eq(schema.projects.slug, slug))
  );
  return c.body(null, 204);
});
