import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../index";
import { getPrincipal } from "../auth/middleware";

export const me = new Hono<Env>();

/**
 * GET /api/me — returns the authenticated user's profile.
 */
me.get("/", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);

  const [user] = await db
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
    .where(eq(schema.users.id, principal.userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(user);
});

me.patch("/", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);
  const body = await c.req.json<{ name?: string; email?: string }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.email !== undefined) updates.email = body.email;

  const [user] = await db
    .update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, principal.userId))
    .returning({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      createdAt: schema.users.createdAt,
    });

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(user);
});
