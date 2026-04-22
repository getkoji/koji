import { Hono } from "hono";
import { eq, and, gt, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { schema } from "@koji/db";
import { hashPassword } from "../auth/password";
import { passwordResetEmail } from "../email-templates";
import { createRateLimiter } from "../rate-limit";
import type { Env } from "../env";

const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// 5 forgot-password requests per IP per 15 minutes
const forgotLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
// 10 reset attempts per IP per 15 minutes
const resetLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";
}

export const passwordReset = new Hono<Env>();

/**
 * POST /api/auth/forgot-password — request a password reset email.
 *
 * Always returns 200 regardless of whether the email exists (no user
 * enumeration). If the user exists, sends a reset link via email.
 */
passwordReset.post("/forgot-password", async (c) => {
  if (!forgotLimiter.check(getClientIp(c))) {
    return c.json({ error: "Too many requests. Try again in a few minutes." }, 429);
  }

  const db = c.get("db");
  const body = await c.req.json<{ email: string }>();

  if (!body.email) {
    return c.json({ error: "Email is required" }, 400);
  }

  // Find user — but always return success to prevent user enumeration
  const [user] = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, body.email))
    .limit(1);

  if (user) {
    const token = randomBytes(32).toString("hex");
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

    await db.insert(schema.passwordResets).values({
      userId: user.id,
      tokenHash: hash,
      expiresAt,
    });

    const resetUrl = `${c.get("appUrl")}/reset-password?token=${token}`;
    const email = passwordResetEmail(user.name ?? "", resetUrl);

    await c.get("emailSender").send({
      to: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }

  return c.json({ ok: true, message: "If an account with that email exists, a reset link has been sent." });
});

/**
 * POST /api/auth/reset-password — set a new password using a reset token.
 */
passwordReset.post("/reset-password", async (c) => {
  if (!resetLimiter.check(getClientIp(c))) {
    return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const db = c.get("db");
  const body = await c.req.json<{ token: string; new_password: string }>();

  if (!body.token || !body.new_password) {
    return c.json({ error: "Token and new password are required" }, 400);
  }
  if (body.new_password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const hash = hashToken(body.token);
  const now = new Date();

  const [reset] = await db
    .select({
      id: schema.passwordResets.id,
      userId: schema.passwordResets.userId,
    })
    .from(schema.passwordResets)
    .where(
      and(
        eq(schema.passwordResets.tokenHash, hash),
        gt(schema.passwordResets.expiresAt, now),
        isNull(schema.passwordResets.usedAt),
      ),
    )
    .limit(1);

  if (!reset) {
    return c.json({ error: "Invalid or expired reset link. Request a new one." }, 400);
  }

  // Update password
  const newHash = await hashPassword(body.new_password);
  await db
    .update(schema.users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(schema.users.id, reset.userId));

  // Mark token as used
  await db
    .update(schema.passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(schema.passwordResets.id, reset.id));

  return c.json({ ok: true, message: "Password updated. You can now sign in." });
});
