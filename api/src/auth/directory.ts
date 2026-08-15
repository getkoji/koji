/**
 * External identity directory.
 *
 * Some deployments delegate *identity* to an external provider: who exists,
 * who belongs to an organization, how they sign in, and how invitation email
 * is delivered. Koji keeps owning *authorization* — the role a member holds
 * inside a tenant, and which projects they can reach — because those concepts
 * have no equivalent in a generic directory.
 *
 * The split matters. A directory typically models one or two coarse org roles
 * (an owner/admin and everyone else). Koji has a seven-role tenant hierarchy
 * plus per-project grants. If the directory were treated as authoritative for
 * roles, every role that has no directory equivalent would be flattened back
 * to the nearest coarse one on the member's next request.
 *
 * So:
 *   - directory owns  → membership existence, invitation delivery, sign-in
 *   - Koji owns       → `memberships.roles`, `project_access`
 *
 * Self-hosted deployments leave this unset: Koji sends its own invite email,
 * mints its own accept token, and is the only record of membership.
 */

export interface DirectoryAdapter {
  /**
   * Ask the directory to invite `email` into the tenant's organization. The
   * directory delivers the email and owns the accept flow; Koji separately
   * records the intended roles against the pending invite so they can be
   * applied when the accepted membership arrives.
   */
  inviteMember(input: {
    tenantId: string;
    email: string;
    invitedByUserId: string;
    /** The Koji roles the invite confers. Passed so an implementation can
     *  derive whatever coarse role its directory requires on an invitation;
     *  the authoritative roles stay on the Koji invite row. */
    roles: string[];
  }): Promise<void>;

  /**
   * Withdraw a pending directory invitation for `email`. Implementations
   * should no-op rather than throw when the directory has no matching
   * pending invitation — Koji revokes its own row either way.
   */
  revokeInvite(input: { tenantId: string; email: string }): Promise<void>;

  /**
   * Remove a member from the tenant's organization in the directory.
   *
   * Deleting only the Koji membership is not enough when a directory is
   * wired: the user would still be an org member upstream, so the auth
   * middleware would just-in-time provision a fresh membership on their very
   * next request and silently undo the removal.
   */
  removeMember(input: { tenantId: string; userId: string }): Promise<void>;
}
