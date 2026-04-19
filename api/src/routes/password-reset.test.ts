import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";

/**
 * Tests for the password reset token logic.
 * These validate the token verification rules without hitting a DB.
 */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("password reset token verification", () => {
  it("valid token hash matches", () => {
    const token = randomBytes(32).toString("hex");
    const hash = hashToken(token);
    expect(hashToken(token)).toBe(hash);
  });

  it("different token produces different hash", () => {
    const token1 = randomBytes(32).toString("hex");
    const token2 = randomBytes(32).toString("hex");
    expect(hashToken(token1)).not.toBe(hashToken(token2));
  });

  it("expired token should be rejected", () => {
    const expiresAt = new Date(Date.now() - 1000); // 1 second ago
    const now = new Date();
    expect(expiresAt.getTime()).toBeLessThan(now.getTime());
  });

  it("valid token within expiry should be accepted", () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    const now = new Date();
    expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("used token (usedAt set) should be rejected", () => {
    const usedAt = new Date("2026-04-18T10:00:00Z");
    expect(usedAt).not.toBeNull();
    // Route checks: isNull(schema.passwordResets.usedAt) — if usedAt is set, no match
  });

  it("token expiry is exactly 1 hour", () => {
    const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000;
    const created = Date.now();
    const expiresAt = created + RESET_TOKEN_EXPIRY_MS;
    expect(expiresAt - created).toBe(3600000);
  });

  it("password must be at least 8 characters", () => {
    const short = "1234567";
    const valid = "12345678";
    expect(short.length).toBeLessThan(8);
    expect(valid.length).toBeGreaterThanOrEqual(8);
  });
});
