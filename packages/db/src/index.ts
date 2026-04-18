import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "./schema";
import type { Db } from "./rls";

export * as schema from "./schema";
export { withRLS } from "./rls";
export type { Db } from "./rls";

/**
 * Opens a Drizzle client against `databaseUrl`. The client is NOT tenant-
 * scoped — use `withRLS(db, tenantId, fn)` for every tenant-scoped query.
 *
 * The underlying `postgres` pool is process-singleton safe as long as the
 * caller caches the returned Db. Workers runtime callers should keep the
 * connection on a module-level binding so multiple requests share the pool.
 */
export function createDb(databaseUrl: string, options?: { max?: number }): Db {
  const client = postgres(databaseUrl, {
    max: options?.max ?? 10,
    prepare: false,
  });
  return drizzle(client, { schema });
}

/**
 * Row-Level Security policy definitions.
 *
 * Drizzle Kit generates the `CREATE TABLE` DDL from the schema, but it does
 * not emit `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` statements. This
 * module owns that DDL. The initial migration pulls it in via a follow-up
 * `.sql` file (`drizzle/0001_rls.sql`) that is concatenated after the
 * auto-generated CREATE TABLEs.
 *
 * Every tenant-scoped table appears here exactly once.
 */
export const RLS_POLICIES: readonly string[] = [
  "tenants",
  "projects",
  "api_keys",
  "audit_log",
  "invites",
  "schemas",
  "schema_versions",
  "schema_samples",
  "corpus_entries",
  "corpus_entry_ground_truth",
  "corpus_entry_tags",
  "corpus_version_results",
  "schema_runs",
  "schema_run_models",
  "pipelines",
  "sources",
  "ingestions",
  "jobs",
  "documents",
  "traces",
  "trace_stages",
  "review_items",
  "model_endpoints",
  "endpoint_usage_rollups",
  "agent_sessions",
  "agent_messages",
  "agent_proposed_edits",
  "webhook_targets",
  "webhook_deliveries",
].flatMap((table) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  `CREATE POLICY ${table}_tenant_isolation ON ${table} FOR ALL USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`,
]);

/**
 * Tables intentionally global (not tenant-scoped). RLS is NOT enabled on
 * these. Keep the list here for visibility — a migration review that sees a
 * new table outside this set should double-check it has an `RLS_POLICIES`
 * entry.
 */
export const GLOBAL_TABLES: readonly string[] = [
  "users", // A user can belong to multiple tenants.
  "sessions", // Auth sessions — user-scoped, not tenant-scoped.
  "memberships", // The user ↔ tenant join; RLS on the tenant column is enforced application-side.
  "playground_sessions", // Anonymous marketing demo.
  "playground_extractions",
  "playground_rate_limits",
];
