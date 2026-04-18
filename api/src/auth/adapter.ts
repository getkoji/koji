/**
 * Auth adapter interface.
 *
 * Every auth provider (local, Clerk, OIDC) implements this interface.
 * The API middleware calls `resolve(token)` on every request — it never
 * knows which provider is behind it.
 */

export interface Principal {
  userId: string;
  email: string;
  name: string | null;
}

export interface Session {
  token: string;
  expiresAt: Date;
}

export interface AuthAdapter {
  /**
   * Validate a token and return the principal, or null if invalid/expired.
   * Called on every authenticated request.
   */
  resolve(token: string): Promise<Principal | null>;

  /**
   * Create a new session for a user. Returns the raw token (not hashed)
   * to be set as a cookie.
   *
   * Only implemented by adapters that manage their own sessions (local).
   * External providers (Clerk, OIDC) throw — they manage sessions externally.
   */
  createSession(userId: string): Promise<Session>;

  /**
   * Destroy a session by its raw token.
   */
  destroySession(token: string): Promise<void>;
}
