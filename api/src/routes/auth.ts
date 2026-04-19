import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { schema } from "@koji/db";
import { createRateLimiter } from "../rate-limit";
import type { Env } from "../env";
import type { AuthAdapter } from "../auth/adapter";

const SESSION_COOKIE = "koji_session";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

// 5 failed login attempts per IP per 15 minutes
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
}

export function createAuthRoutes(adapter: AuthAdapter) {
  const auth = new Hono<Env>();

  /**
   * POST /api/auth/login — email + password → session cookie.
   */
  auth.post("/login", async (c) => {
    if (!loginLimiter.check(getClientIp(c))) {
      return c.json({ error: "Too many login attempts. Try again in a few minutes." }, 429);
    }

    const db = c.get("db");
    const body = await c.req.json<{ email: string; password: string }>();

    if (!body.email || !body.password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    // Find the user by email
    const [user] = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);

    if (!user) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    // Verify password
    if (!user.passwordHash) {
      return c.json({ error: "This account has no password set (external auth provider)" }, 401);
    }

    const { verifyPassword } = await import("../auth/password");
    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const session = await adapter.createSession(user.id);

    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: false, // TODO: true in production
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    // Find user's first membership to get the default project
    const [membership] = await db
      .select({ tenantId: schema.memberships.tenantId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user.id))
      .limit(1);

    let redirectSlug = "default";
    if (membership) {
      const [project] = await db
        .select({ slug: schema.projects.slug })
        .from(schema.projects)
        .where(eq(schema.projects.tenantId, membership.tenantId))
        .limit(1);
      if (project) redirectSlug = project.slug;
    }

    return c.json({
      user: { id: user.id, name: user.name, email: user.email },
      redirect: `/t/${redirectSlug}`,
    });
  });

  /**
   * DELETE /api/auth/session — destroy the current session.
   */
  auth.delete("/session", async (c) => {
    const cookieToken = c.req.header("Cookie")?.match(/koji_session=([^;]+)/)?.[1];
    if (cookieToken) {
      await adapter.destroySession(cookieToken);
    }

    deleteCookie(c, SESSION_COOKIE, { path: "/" });

    return c.json({ ok: true });
  });

  return auth;
}
