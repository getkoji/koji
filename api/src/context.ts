/**
 * Request context helpers — resolve tenant and user.
 *
 * Until auth is wired, these return the first tenant/user in the DB
 * (created during setup). When auth lands, they'll resolve from the
 * session token instead.
 */
import { schema } from "@koji/db";
import type { Db } from "@koji/db";

let _cachedTenantId: string | null = null;
let _cachedUserId: string | null = null;

export async function getTenantId(db: Db): Promise<string> {
  if (_cachedTenantId) return _cachedTenantId;

  const [tenant] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .orderBy(schema.tenants.createdAt)
    .limit(1);

  if (!tenant) throw new Error("No tenant exists. Complete setup at /setup first.");

  _cachedTenantId = tenant.id;
  return tenant.id;
}

export async function getUserId(db: Db): Promise<string> {
  if (_cachedUserId) return _cachedUserId;

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(schema.users.createdAt)
    .limit(1);

  if (!user) throw new Error("No user exists. Complete setup at /setup first.");

  _cachedUserId = user.id;
  return user.id;
}

/** Clear cache — call after setup creates a new tenant/user. */
export function clearContextCache() {
  _cachedTenantId = null;
  _cachedUserId = null;
}
