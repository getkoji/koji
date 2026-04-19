/**
 * Local auth adapter — sessions stored in Postgres.
 *
 * Used for self-hosted deployments where there's no external auth
 * provider. The adapter manages its own session table.
 *
 * Token flow:
 *   createSession(userId) → generates a random token, stores SHA-256
 *     hash in the sessions table, returns the raw token
 *   resolve(token) → hashes the token, looks up the session, returns
 *     the user if found and not expired
 *   destroySession(token) → hashes the token, deletes the session row
 */
import { randomBytes, createHash } from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import { schema } from "@koji/db";
import type { Db } from "@koji/db";
import type { AuthAdapter, Principal, Session } from "./adapter";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `koji_sess_${randomBytes(32).toString("hex")}`;
}

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class LocalAuthAdapter implements AuthAdapter {
  constructor(private db: Db) {}

  async resolve(token: string): Promise<Principal | null> {
    const hash = hashToken(token);
    const now = new Date();

    const rows = await this.db
      .select({
        userId: schema.sessions.userId,
        email: schema.users.email,
        name: schema.users.name,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.tokenHash, hash),
          gt(schema.sessions.expiresAt, now),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;

    return {
      userId: rows[0]!.userId,
      email: rows[0]!.email,
      name: rows[0]!.name,
    };
  }

  async createSession(userId: string): Promise<Session> {
    const token = generateToken();
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await this.db.insert(schema.sessions).values({
      userId,
      tokenHash: hash,
      expiresAt,
    });

    return { token, expiresAt };
  }

  async destroySession(token: string): Promise<void> {
    const hash = hashToken(token);
    await this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.tokenHash, hash));
  }
}
