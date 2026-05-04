/**
 * Auth middleware — 5-stage request lifecycle:
 *
 * 1. Identify — resolve principal from session cookie or Bearer token
 * 2. Resolve tenant — from x-koji-tenant header
 * 3. Load grants — look up membership, expand roles → permissions
 * 4. Set context — principal, tenantId, grants on Hono context
 * 5. Enforce — requires() middleware checks permissions per route
 *
 * Public routes skip all of this. Authenticated-but-no-tenant routes
 * (like /api/me, /api/tenants) skip tenant resolution.
 */
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { eq, and } from "drizzle-orm";
import { schema } from "@koji/db";
import type { AuthAdapter, Principal } from "./adapter";
import { resolvePermissions, type Permission } from "./roles";
import type { Env } from "../env";

const DEFAULT_SESSION_COOKIE = "koji_session";

export interface AuthMiddlewareOptions {
  /** Cookie name the middleware should pull a bearer token from. Defaults to
   *  `koji_session` (the local adapter). Hosted/Clerk sets `__session` on the
   *  app domain, so the platform Worker configures that here.
   *  Authorization: Bearer tokens are always honoured as a fallback. */
  sessionCookie?: string;
}

/** Routes that skip auth entirely. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/health/ready",
  "/api/health",
  "/api/setup/status",
  "/api/setup",
  "/api/auth/login",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/invites/accept",
  "/api/inngest",
  "/api/billing/webhooks/stripe",
  "/api/webhooks/clerk",
  "/api/model-registry/refresh",
]);

/** Routes that require auth but not tenant context. */
const NO_TENANT_PATHS = new Set([
  "/api/me",
  "/api/me/password",
  "/api/me/can-delete",
  "/api/tenants",
]);

function matchesNoTenantPath(path: string): boolean {
  // Exact matches or prefix matches for paths with sub-routes
  if (NO_TENANT_PATHS.has(path)) return true;
  if (path === "/api/me" || path.startsWith("/api/me/")) return true;
  if (path === "/api/tenants" || path.startsWith("/api/tenants/")) return true;
  if (path === "/api/cli/authorize") return true;
  if (path === "/api/projects/setup") return true;
  if (path === "/api/model-registry") return true;
  if (path === "/api/model-registry/refresh") return true;
  if (path.startsWith("/api/admin")) return true;
  return false;
}

export function authMiddleware(adapter: AuthAdapter, opts: AuthMiddlewareOptions = {}) {
  const sessionCookie = opts.sessionCookie ?? DEFAULT_SESSION_COOKIE;

  return async (c: Context<Env>, next: Next) => {
    const path = c.req.path;

    // Public routes — no auth needed
    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    // Source webhook inbound — public, verified by HMAC, not user auth
    if (path.match(/^\/api\/sources\/[^/]+\/webhook$/)) {
      await next();
      return;
    }

    // --- Stage 1: Identify ---
    const cookieToken = getCookie(c, sessionCookie);
    const bearerToken = c.req.header("Authorization")?.replace("Bearer ", "");
    const token = cookieToken || bearerToken;

    if (!token) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Use the per-request auth adapter from context if available (Workers
    // injects a fresh one with a per-request DB), falling back to the
    // closure adapter for Node/self-hosted where the DB is shared.
    const requestAuth = c.get("auth") ?? adapter;
    const principal = await requestAuth.resolve(token);
    if (!principal) {
      return c.json({ error: "Invalid or expired session" }, 401);
    }

    c.set("principal", principal);

    // Routes that don't need tenant context
    if (matchesNoTenantPath(path)) {
      await next();
      return;
    }

    // --- Stage 2: Resolve tenant ---
    const tenantSlug = c.req.header("x-koji-tenant");
    const db = c.get("db");
    let tenant: { id: string } | undefined;

    if (tenantSlug) {
      // Primary path: resolve by slug (OSS, CLI, API keys)
      [tenant] = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(eq(schema.tenants.slug, tenantSlug))
        .limit(1);
    } else if (principal.orgId) {
      // Org-based path: resolve by external auth ID (Clerk org, OIDC group, etc.)
      [tenant] = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(eq(schema.tenants.externalAuthId, principal.orgId))
        .limit(1);
    }

    if (!tenant) {
      if (!tenantSlug && !principal.orgId) {
        return c.json({ error: "Missing x-koji-tenant header" }, 400);
      }
      return c.json({ error: "Tenant not found" }, 404);
    }

    c.set("tenantId", tenant.id);

    // --- Stage 3: Load grants ---
    const [membership] = await db
      .select({ roles: schema.memberships.roles })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, principal.userId),
          eq(schema.memberships.tenantId, tenant.id),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: "You are not a member of this workspace" }, 403);
    }

    const grants = resolvePermissions(membership.roles);
    c.set("grants", grants);
    c.set("roles", membership.roles);

    await next();
  };
}

/**
 * Route-level permission guard.
 *
 * Usage:
 *   router.get('/schemas', requires('schema:read'), listSchemas);
 *   router.post('/schemas', requires('schema:write'), createSchema);
 *
 * Multiple permissions = OR (any one is sufficient).
 */
export function requires(...permissions: Permission[]) {
  return async (c: Context<Env>, next: Next) => {
    const grants = c.get("grants") as Set<Permission> | undefined;

    if (!grants) {
      return c.json({ code: "forbidden", message: "No permissions resolved" }, 403);
    }

    const hasAny = permissions.some((p) => grants.has(p));
    if (!hasAny) {
      return c.json(
        { code: "forbidden", message: `Missing permission: ${permissions.join(" | ")}` },
        403,
      );
    }

    await next();
  };
}

/** Get the principal from the request context. Throws if not set. */
export function getPrincipal(c: Context<Env>): Principal {
  const p = c.get("principal");
  if (!p) throw new Error("No principal on context — auth middleware not applied?");
  return p;
}

/** Get the resolved tenant ID. Throws if not set. */
export function getTenantId(c: Context<Env>): string {
  const id = c.get("tenantId");
  if (!id) throw new Error("No tenantId on context — tenant resolution not applied?");
  return id;
}

/** Get the user's roles for the current tenant. */
export function getRoles(c: Context<Env>): string[] {
  return (c.get("roles") as string[] | undefined) ?? [];
}

/** Get the user's resolved permissions for the current tenant. */
export function getGrants(c: Context<Env>): Set<Permission> {
  return (c.get("grants") as Set<Permission> | undefined) ?? new Set();
}
