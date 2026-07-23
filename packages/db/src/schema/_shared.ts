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
 * `project_id` — the intra-tenant isolation boundary. Denormalized onto every
 * directly-listed resource (pipelines, schemas, jobs, …) the same way
 * `tenant_id` is, so RLS can filter on a literal column. Children that are
 * only reachable through a project-checked parent id (schema_versions,
 * documents, traces, …) do NOT carry it.
 *
 * Unlike the tenant policy (permissive, unset ⇒ zero rows), the project
 * policy is RESTRICTIVE and unset ⇒ all rows of the current tenant: project
 * scope narrows an already tenant-scoped transaction, and background workers
 * legitimately operate tenant-wide. See PROJECT_RLS_TABLES in ../index.ts.
 */
export const projectId = () => uuid("project_id").notNull();

/**
 * A NULLABLE `project_id`, for tables where NULL carries meaning: "this row
 * belongs to the whole workspace, not to one project." Those tables get the
 * null-AWARE variant of the project policy (`project_id IS NULL` always
 * passes) — see PROJECT_NULLABLE_RLS_TABLES in ../index.ts.
 *
 * Used by the provider tables: a model or parse credential can be shared
 * across every project in the workspace (NULL) or scoped to one project (an
 * id), and a project-scoped credential overrides the shared one.
 */
export const sharedProjectId = () => uuid("project_id");

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
