import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../index";

export const me = new Hono<Env>();

/**
 * Get the current user.
 *
 * Until real auth is wired, this returns the first user in the DB
 * (the owner created during setup). When auth lands, this will
 * resolve the user from the session token instead.
 */
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
    .orderBy(schema.users.createdAt)
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "No users exist. Complete setup at /setup first." }, 404);
  }

  return c.json(rows[0]);
});

me.patch("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{
    name?: string;
    email?: string;
  }>();

  // Find the current user (first user, until auth is wired)
  const [currentUser] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(schema.users.createdAt)
    .limit(1);

  if (!currentUser) {
    return c.json({ error: "No users exist" }, 404);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.email !== undefined) updates.email = body.email;

  const rows = await db
    .update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, currentUser.id))
    .returning({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      createdAt: schema.users.createdAt,
    });

  return c.json(rows[0]);
});
