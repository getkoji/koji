/**
 * Auth middleware — resolves the current user from the session cookie
 * or Bearer token on every request.
 *
 * Unprotected routes (health, setup) skip this middleware.
 * Protected routes get a `principal` on the context — if missing,
 * the route returns 401.
 */
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthAdapter, Principal } from "./adapter";
import type { Env } from "../index";

const SESSION_COOKIE = "koji_session";

const PUBLIC_PATHS = new Set([
  "/health",
  "/api/setup/status",
  "/api/setup",
  "/api/auth/login",
]);

export function authMiddleware(adapter: AuthAdapter) {
  return async (c: Context<Env>, next: Next) => {
    const path = c.req.path;

    // Skip auth for public routes
    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    // Try cookie first, then Bearer header
    const cookieToken = getCookie(c, SESSION_COOKIE);
    const bearerToken = c.req.header("Authorization")?.replace("Bearer ", "");
    const token = cookieToken || bearerToken;

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const principal = await adapter.resolve(token);
    if (!principal) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    c.set("principal", principal);
    await next();
  };
}

export function getPrincipal(c: Context<Env>): Principal {
  const p = c.get("principal" as never) as Principal | undefined;
  if (!p) throw new Error("No principal on context — auth middleware not applied?");
  return p;
}
