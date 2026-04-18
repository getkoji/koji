import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../index";
import { DEFAULT_TENANT_ID } from "../bootstrap";

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

export const me = new Hono<Env>();

me.get("/", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      authProvider: schema.users.authProvider,
      lastLoginAt: schema.users.lastLoginAt,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, DEFAULT_USER_ID))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(rows[0]);
});

me.patch("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{
    name?: string;
    email?: string;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.email !== undefined) updates.email = body.email;

  const rows = await db
    .update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, DEFAULT_USER_ID))
    .returning({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      createdAt: schema.users.createdAt,
    });

  if (rows.length === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(rows[0]);
});
