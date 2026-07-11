import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "./schema";
import type { Db } from "./rls";

export * as schema from "./schema";
export { withRLS } from "./rls";
export type { Db, RlsScope } from "./rls";

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
  "project_access",
  "api_keys",
  "api_key_project_access",
  "audit_log",
  "invites",
  "schemas",
  "schema_versions",
  "schema_samples",
  "classifiers",
  "classifier_versions",
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
  "parse_endpoints",
  "provider_credentials",
  "tenant_models",
  "endpoint_usage_rollups",
  "agent_sessions",
  "agent_messages",
  "agent_proposed_edits",
  "webhook_targets",
  "webhook_deliveries",
  "extraction_runs",
  "form_mappings",
  "pipeline_step_runs",
  "pipeline_versions",
].flatMap((table) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
  `CREATE POLICY ${table}_tenant_isolation ON ${table} FOR ALL USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);`,
]);

/**
 * Tables that carry a denormalized `project_id` — the intra-tenant isolation
 * boundary. Each gets a RESTRICTIVE policy on top of its permissive tenant
 * policy:
 *
 *   - RESTRICTIVE means it ANDs with the tenant policy. (A second PERMISSIVE
 *     policy would OR with it and silently disable tenant isolation.)
 *   - `NULLIF(current_setting(...), '') IS NULL` ⇒ the policy passes when no
 *     project is set — background workers and org-level queries legitimately
 *     operate tenant-wide. Tenant isolation still applies regardless.
 *
 * The policy DDL lives in `drizzle/0001_rls.sql` (re-applied on every
 * migrate run) and MUST stay in lock-step with this list. rls.test.ts
 * round-trips a row per table here to prove project isolation.
 */
export const PROJECT_RLS_TABLES: readonly string[] = [
  "pipelines",
  "sources",
  "schemas",
  "classifiers",
  "model_endpoints",
  "parse_endpoints",
  "provider_credentials",
  "webhook_targets",
  "jobs",
  "review_items",
  "agent_sessions",
];

/**
 * Project-scoped tables whose `project_id` is NULLABLE, so they get a
 * null-AWARE variant of the project policy — `project_id IS NULL` always
 * passes — rather than the strict predicate the tables above use. Deliberately
 * NOT in PROJECT_RLS_TABLES (whose policy is strict); rls.test.ts covers the
 * null-aware behavior separately. See `drizzle/0001_rls.sql`.
 *
 *   - `notifications`: tenant-level notifications (queue failures, billing)
 *     belong to no project and must stay visible in every project view.
 *   - `api_keys`: an all-access key has a NULL project_id (it belongs to no
 *     single project) and must stay visible/manageable from every project view,
 *     exactly like a tenant-wide notification. Single/multi keys keep a
 *     non-null project_id and are narrowed normally.
 */
export const PROJECT_NULLABLE_RLS_TABLES: readonly string[] = ["notifications", "api_keys"];

/**
 * Tables intentionally global (not tenant-scoped). RLS is NOT enabled on
 * these. Keep the list here for visibility — a migration review that sees a
 * new table outside this set should double-check it has an `RLS_POLICIES`
 * entry.
 */
export const GLOBAL_TABLES: readonly string[] = [
  "users", // A user can belong to multiple tenants.
  "sessions", // Auth sessions — user-scoped, not tenant-scoped.
  "password_resets", // Password reset tokens — user-scoped.
  "memberships", // The user ↔ tenant join; RLS on the tenant column is enforced application-side.
  "playground_sessions", // Anonymous marketing demo.
  "playground_extractions",
  "playground_rate_limits",
  "parse_cache", // Shared by content hash — same file = same parse regardless of tenant.
  "model_catalog", // Global model catalog, not tenant-specific.
  "background_jobs", // System-level job queue, not tenant-scoped data.
];
