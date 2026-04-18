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

me.post("/password", async (c) => {
  const db = c.get("db");
  const principal = getPrincipal(c);
  const body = await c.req.json<{
    current_password: string;
    new_password: string;
  }>();

  if (!body.current_password || !body.new_password) {
    return c.json({ error: "Current and new password are required" }, 400);
  }
  if (body.new_password.length < 8) {
    return c.json({ error: "New password must be at least 8 characters" }, 400);
  }

  const [user] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, principal.userId))
    .limit(1);

  if (!user?.passwordHash) {
    return c.json({ error: "This account uses external auth — password cannot be changed here" }, 400);
  }

  const { verifyPassword, hashPassword } = await import("../auth/password");

  const valid = await verifyPassword(body.current_password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const newHash = await hashPassword(body.new_password);
  await db
    .update(schema.users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(schema.users.id, principal.userId));

  return c.json({ ok: true });
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
