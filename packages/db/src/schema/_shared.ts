import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * `bytea` — Postgres binary column. Drizzle doesn't ship a builtin for this,
 * so we wrap it in a customType that maps to `Buffer` on the JS side.
 *
 * Drizzle-kit emits the type name as a quoted identifier (`"bytea"`) in the
 * generated DDL. Postgres resolves quoted-lowercase to the builtin type, so
 * this works despite looking unusual. The round-trip test in `rls.test.ts`
 * proves the migration applies cleanly against a real Postgres.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * `inet` — Postgres IP address column. Stored as a string on the JS side.
 * Same quoted-identifier trick as `bytea` above.
 */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

/**
 * `citext` — case-insensitive text. Not used yet but available if we need
 * case-insensitive uniqueness on emails etc.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

export const primaryKey = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const deletedAt = () => timestamp("deleted_at", { withTimezone: true, mode: "date" });

export const tenantId = () => uuid("tenant_id").notNull();

/**
 * The RLS policy body used on every tenant-scoped table. Read at migration
 * time via `GET_TENANT_ISOLATION_POLICY(tableName)`.
 *
 * The `current_setting('app.current_tenant_id', true)` call returns `NULL`
 * when the setting is not present (the `true` arg is "missing_ok"), which
 * means a connection that forgets to call `SET LOCAL app.current_tenant_id`
 * sees zero tenant-scoped rows — the safe default.
 */
export const TENANT_ISOLATION_USING = `tenant_id = current_setting('app.current_tenant_id', true)::uuid`;
