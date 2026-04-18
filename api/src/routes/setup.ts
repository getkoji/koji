import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { sql } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Env } from "../index";
import { adapter } from "../index";
import { clearContextCache } from "../context";

export const setup = new Hono<Env>();

/**
 * GET /api/setup/status — check whether first-run setup is needed.
 *
 * Returns { needed: true } when the users table is empty (fresh install).
 * Returns { needed: false } after the first user exists.
 */
setup.get("/status", async (c) => {
  // Skip setup entirely when using an external auth adapter (Clerk, OIDC)
  const authAdapter = process.env.KOJI_AUTH_ADAPTER ?? "local";
  if (authAdapter !== "local") {
    return c.json({ needed: false, reason: "external_auth" });
  }

  const db = c.get("db");
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users);
  const userCount = rows[0]?.count ?? 0;

  return c.json({ needed: userCount === 0 });
});

/**
 * POST /api/setup — create the first user + default tenant.
 *
 * One-shot: returns 404 if any user already exists.
 */
setup.post("/", async (c) => {
  const authAdapter = process.env.KOJI_AUTH_ADAPTER ?? "local";
  if (authAdapter !== "local") {
    return c.json({ error: "Setup is disabled when using external auth" }, 404);
  }

  const db = c.get("db");

  // Guard: refuse if any user exists
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users);
  if ((rows[0]?.count ?? 0) > 0) {
    return c.json({ error: "Setup already completed" }, 404);
  }

  const body = await c.req.json<{
    name: string;
    email: string;
    password: string;
    workspace_name?: string;
    workspace_slug: string;
  }>();

  if (!body.name || !body.email || !body.password) {
    return c.json({ error: "name, email, and password are required" }, 400);
  }

  if (body.password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  if (!body.workspace_slug || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(body.workspace_slug)) {
    return c.json({ error: "Workspace URL must be lowercase letters, numbers, and hyphens (2-64 chars)" }, 400);
  }

  // Create user with hashed password
  const { hashPassword } = await import("../auth/password");
  const passwordHash = await hashPassword(body.password);

  const [user] = await db.insert(schema.users).values({
    email: body.email,
    name: body.name,
    passwordHash,
    authProvider: "local",
    authProviderId: `local-${body.email}`,
  }).returning();

  // Create tenant
  const tenantName = body.workspace_name || body.workspace_slug;
  const [tenant] = await db.insert(schema.tenants).values({
    slug: body.workspace_slug,
    displayName: tenantName,
    plan: "pro",
  }).returning();

  // Create membership with owner role
  await db.insert(schema.memberships).values({
    userId: user!.id,
    tenantId: tenant!.id,
    roles: ["tenant-owner", "project-admin", "schema-write", "pipeline-write", "review-write", "endpoint-write"],
  });

  // Create a default project within the tenant
  const [project] = await db.insert(schema.projects).values({
    tenantId: tenant!.id,
    slug: body.workspace_slug,
    displayName: tenantName,
    createdBy: user!.id,
  }).returning();

  // Create a session so the user is logged in immediately
  const session = await adapter.createSession(user!.id);
  setCookie(c, "koji_session", session.token, {
    httpOnly: true,
    secure: false, // TODO: true in production
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  // Clear cached IDs so /api/me and other routes pick up the new user/tenant
  clearContextCache();

  return c.json({
    user: { id: user!.id, name: user!.name, email: user!.email },
    tenant: { id: tenant!.id, slug: tenant!.slug, displayName: tenant!.displayName },
    project: { id: project!.id, slug: project!.slug, displayName: project!.displayName },
    redirect: `/t/${project!.slug}`,
  }, 201);
});
