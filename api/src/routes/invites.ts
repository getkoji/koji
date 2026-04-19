import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { eq, and, gt, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import type { Env } from "../env";
import { requires, getTenantId, getPrincipal, getRoles } from "../auth/middleware";
import { highestRoleRank, isValidRole } from "../auth/roles";
import { teamInviteEmail } from "../email-templates";
import { sendEmail } from "../email";
import { adapter } from "../index";

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002";

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export const invites = new Hono<Env>();

/**
 * POST /api/invites — send a team invite.
 *
 * Requires member:invite permission. Inviter cannot grant roles
 * higher than their own.
 */
invites.post("/", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const principal = getPrincipal(c);
  const inviterRoles = getRoles(c);

  const body = await c.req.json<{ email: string; roles: string[] }>();

  if (!body.email) {
    return c.json({ error: "Email is required" }, 400);
  }
  if (!body.roles || body.roles.length === 0) {
    return c.json({ error: "At least one role is required" }, 400);
  }

  // Validate all roles
  for (const role of body.roles) {
    if (!isValidRole(role)) {
      return c.json({ error: `Invalid role: ${role}` }, 400);
    }
  }

  // Role ceiling: inviter cannot grant roles above their own highest
  const inviterMax = highestRoleRank(inviterRoles);
  const inviteeMax = highestRoleRank(body.roles);
  if (inviteeMax > inviterMax) {
    return c.json({ error: "Cannot invite someone with a higher role than your own" }, 403);
  }

  // Get tenant info for the email
  const [tenant] = await db
    .select({ displayName: schema.tenants.displayName })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);

  const token = randomBytes(32).toString("hex");
  const tokenHashBuf = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

  await db.insert(schema.invites).values({
    tenantId,
    email: body.email,
    roles: body.roles,
    tokenHash: tokenHashBuf,
    invitedBy: principal.userId,
    expiresAt,
  });

  // Send invite email
  const inviteUrl = `${APP_URL}/accept-invite?token=${token}`;
  const inviterName = principal.name ?? principal.email;
  const projectName = tenant?.displayName ?? "Koji";
  const email = teamInviteEmail(inviterName, projectName, inviteUrl);

  await sendEmail({
    to: body.email,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });

  return c.json({ ok: true, message: `Invite sent to ${body.email}` }, 201);
});

/**
 * GET /api/invites — list pending invites for the current tenant.
 */
invites.get("/", requires("member:read"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);

  const rows = await db
    .select({
      id: schema.invites.id,
      email: schema.invites.email,
      roles: schema.invites.roles,
      expiresAt: schema.invites.expiresAt,
      acceptedAt: schema.invites.acceptedAt,
      createdAt: schema.invites.createdAt,
      invitedByName: schema.users.name,
      invitedByEmail: schema.users.email,
    })
    .from(schema.invites)
    .innerJoin(schema.users, eq(schema.users.id, schema.invites.invitedBy))
    .where(eq(schema.invites.tenantId, tenantId))
    .orderBy(schema.invites.createdAt);

  return c.json({
    data: rows.map((r) => ({
      id: r.id,
      email: r.email,
      roles: r.roles,
      expiresAt: r.expiresAt,
      acceptedAt: r.acceptedAt,
      createdAt: r.createdAt,
      invitedBy: r.invitedByName ?? r.invitedByEmail,
    })),
  });
});

/**
 * DELETE /api/invites/:id — revoke a pending invite.
 */
invites.delete("/:id", requires("member:invite"), async (c) => {
  const db = c.get("db");
  const tenantId = getTenantId(c);
  const inviteId = c.req.param("id")!;

  const [invite] = await db
    .select({ id: schema.invites.id, acceptedAt: schema.invites.acceptedAt })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.id, inviteId),
        eq(schema.invites.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!invite) {
    return c.json({ error: "Invite not found" }, 404);
  }

  if (invite.acceptedAt) {
    return c.json({ error: "Cannot revoke an accepted invite" }, 400);
  }

  await db.delete(schema.invites).where(eq(schema.invites.id, inviteId));

  return c.json({ ok: true });
});

/**
 * POST /api/invites/accept — accept an invite via token.
 *
 * Public route (no auth required — the invitee may not have an account yet).
 * If the user doesn't exist, creates their account first.
 */
invites.post("/accept", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{
    token: string;
    name?: string;
    password?: string;
  }>();

  if (!body.token) {
    return c.json({ error: "Token is required" }, 400);
  }

  const tokenHashBuf = hashToken(body.token);
  const now = new Date();

  const [invite] = await db
    .select({
      id: schema.invites.id,
      tenantId: schema.invites.tenantId,
      email: schema.invites.email,
      roles: schema.invites.roles,
      invitedBy: schema.invites.invitedBy,
    })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.tokenHash, tokenHashBuf),
        gt(schema.invites.expiresAt, now),
        isNull(schema.invites.acceptedAt),
      ),
    )
    .limit(1);

  if (!invite) {
    return c.json({ error: "Invalid, expired, or already-used invite link" }, 400);
  }

  // Find or create user
  let [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, invite.email))
    .limit(1);

  if (!user) {
    // New user — need a password for local auth
    if (!body.password || body.password.length < 8) {
      return c.json({ error: "Password is required (at least 8 characters) for new accounts" }, 400);
    }

    const { hashPassword } = await import("../auth/password");
    const passwordHash = await hashPassword(body.password);

    const [created] = await db.insert(schema.users).values({
      email: invite.email,
      name: body.name ?? invite.email.split("@")[0],
      passwordHash,
      authProvider: "local",
      authProviderId: `local-${invite.email}`,
    }).returning();

    user = created!;
  }

  // Check if already a member (shouldn't happen if invite flow is clean, but guard)
  const [existing] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.userId, user.id),
        eq(schema.memberships.tenantId, invite.tenantId),
      ),
    )
    .limit(1);

  if (existing) {
    // Already a member — just mark invite accepted
    await db
      .update(schema.invites)
      .set({ acceptedAt: now })
      .where(eq(schema.invites.id, invite.id));

    return c.json({ ok: true, message: "You are already a member of this workspace" });
  }

  // Create membership
  await db.insert(schema.memberships).values({
    userId: user.id,
    tenantId: invite.tenantId,
    roles: invite.roles,
    invitedBy: invite.invitedBy,
    invitedAt: now,
    acceptedAt: now,
  });

  // Mark invite as used
  await db
    .update(schema.invites)
    .set({ acceptedAt: now })
    .where(eq(schema.invites.id, invite.id));

  // Create session so the user is logged in
  const session = await adapter.createSession(user.id);
  setCookie(c, "koji_session", session.token, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  // Get tenant slug for redirect
  const [tenant] = await db
    .select({ slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, invite.tenantId))
    .limit(1);

  return c.json({
    ok: true,
    redirect: `/t/${tenant?.slug ?? "default"}`,
  });
});
