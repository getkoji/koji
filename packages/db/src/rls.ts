import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Runs `fn` inside a transaction with `SET LOCAL app.current_tenant_id = <uuid>`
 * applied at the very start. Every tenant-scoped RLS policy reads this setting
 * via `current_setting('app.current_tenant_id', true)::uuid`; a missing or
 * mismatched value returns zero rows.
 *
 * Usage:
 *
 *     import { withRLS } from "@koji/db/rls";
 *
 *     const jobs = await withRLS(db, tenantId, async (tx) => {
 *       return tx.select().from(schema.jobs).limit(50);
 *     });
 *
 * **Every handler that touches tenant-scoped data must go through this
 * wrapper.** Direct `db.select(...)` calls bypass the RLS context and will
 * return either nothing (if the connection has no prior setting) or the wrong
 * tenant's data (if a stale setting is still on the connection). The wrapper
 * exists so it's *impossible* to get the setting wrong — the only way to see
 * rows is to name the tenant up front.
 *
 * See `docs/specs/auth-permissioning.md` §5.3 for the contract.
 */
export async function withRLS<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      `withRLS: refusing to set app.current_tenant_id to a non-UUID value (got ${JSON.stringify(tenantId)})`,
    );
  }

  return db.transaction(async (tx) => {
    // SET LOCAL scopes the setting to this transaction, so it is automatically
    // cleared on COMMIT/ROLLBACK and never leaks to the next query on the
    // same connection. Quoting via sql.raw is safe because we reject any
    // value that doesn't match the strict UUID regex above.
    await tx.execute(sql.raw(`SET LOCAL app.current_tenant_id = '${tenantId}'`));
    return fn(tx);
  });
}

/**
 * Canonical UUID v4-shape regex. `withRLS` refuses any other input — this
 * guards the `SET LOCAL` statement against injection.
 */
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
