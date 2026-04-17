import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema, withRLS } from "@koji/db";
import type { Env } from "../index";

// Default tenant ID — created on first boot. Eventually replaced by
// real tenant resolution from auth.
const DEFAULT_TENANT = process.env.KOJI_TENANT_ID ?? "00000000-0000-0000-0000-000000000000";

export const schemas = new Hono<Env>();

schemas.get("/", async (c) => {
  const db = c.get("db");
  const rows = await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .select({
        slug: schema.schemas.slug,
        displayName: schema.schemas.displayName,
        description: schema.schemas.description,
        createdAt: schema.schemas.createdAt,
      })
      .from(schema.schemas)
      .where(sql`deleted_at IS NULL`)
  );
  return c.json({ data: rows });
});

schemas.get("/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  const rows = await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .select()
      .from(schema.schemas)
      .where(eq(schema.schemas.slug, slug))
      .limit(1)
  );
  if (rows.length === 0) {
    return c.json({ error: "Schema not found" }, 404);
  }
  return c.json(rows[0]);
});

schemas.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{
    slug: string;
    display_name: string;
    description?: string;
    initial_yaml?: string;
  }>();

  const rows = await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .insert(schema.schemas)
      .values({
        tenantId: DEFAULT_TENANT,
        slug: body.slug,
        displayName: body.display_name,
        description: body.description ?? null,
        draftYaml: body.initial_yaml ?? null,
        createdBy: DEFAULT_TENANT, // placeholder until auth
      })
      .returning()
  );
  return c.json(rows[0], 201);
});

schemas.patch("/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  const body = await c.req.json<{
    display_name?: string;
    description?: string;
    draft_yaml?: string;
  }>();

  const updates: Record<string, unknown> = {};
  if (body.display_name) updates.displayName = body.display_name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.draft_yaml !== undefined) {
    updates.draftYaml = body.draft_yaml;
    updates.draftUpdatedAt = new Date();
  }

  const rows = await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .update(schema.schemas)
      .set(updates)
      .where(eq(schema.schemas.slug, slug))
      .returning()
  );
  if (rows.length === 0) {
    return c.json({ error: "Schema not found" }, 404);
  }
  return c.json(rows[0]);
});

schemas.delete("/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");

  await withRLS(db, DEFAULT_TENANT, (tx) =>
    tx
      .update(schema.schemas)
      .set({ deletedAt: new Date() })
      .where(eq(schema.schemas.slug, slug))
  );
  return c.body(null, 204);
});
