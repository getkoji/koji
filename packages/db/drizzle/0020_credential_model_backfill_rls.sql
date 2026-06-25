-- Credential→model split (expand phase, oss-232).
--
-- Backfill provider_credentials + tenant_models from model_endpoints, then
-- enable RLS on the two new tables. NOTHING reads or writes these tables yet —
-- model_endpoints stays the source of truth. This proves the migration
-- end-to-end and seeds data for the follow-up read/write cutover.
--
-- model_endpoints has FORCE ROW LEVEL SECURITY, and migrations run as the table
-- owner (not a superuser) on managed Postgres — so a plain SELECT here would
-- see zero rows (app.current_tenant_id is unset during a migration). Drop FORCE
-- for the backfill read, then restore it. The whole file runs in one
-- transaction, and migrate.ts re-applies 0001_rls.sql after every run, so FORCE
-- is restored even if this migration were to abort.
ALTER TABLE "model_endpoints" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- One credential per old endpoint. The credential id is derived deterministically
-- from the endpoint id (md5) so the tenant_models insert below can reference it
-- without a correlation table, and so a re-run (the PR2 cutover re-backfill) is
-- idempotent via ON CONFLICT.
INSERT INTO "provider_credentials" (
  id, tenant_id, slug, display_name, provider, config_json, auth_json, status,
  last_health_check_at, consecutive_failures, last_success_at, last_failure_at,
  last_failure_reason, health_state, created_by, created_at, updated_at, deleted_at
)
SELECT
  md5('cred:' || id::text)::uuid, tenant_id, slug, display_name, provider, config_json, auth_json, status,
  last_health_check_at, consecutive_failures, last_success_at, last_failure_at,
  last_failure_reason, health_state, created_by, created_at, updated_at, deleted_at
FROM "model_endpoints"
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- One tenant_model per old endpoint, REUSING the endpoint id as the model id so
-- every existing reference (pipelines.model_provider_id, runs.model_endpoint_id,
-- endpoint usage rollups, the legibility fallback_model_id) stays valid by value
-- with no FK rewrite. capability defaults to 'chat' — old rows carry no
-- capability signal; it gets refined when the catalog UI lands.
INSERT INTO "tenant_models" (
  id, tenant_id, credential_id, model, capability, slug, display_name,
  pricing_mode, pricing_override_json, status, created_at, updated_at, deleted_at
)
SELECT
  id, tenant_id, md5('cred:' || id::text)::uuid, model, 'chat', slug, display_name,
  pricing_mode, pricing_override_json, status, created_at, updated_at, deleted_at
FROM "model_endpoints"
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

ALTER TABLE "model_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- RLS on the two new tables. drizzle-kit does not emit RLS DDL; same
-- DROP-then-CREATE idempotent pattern as 0013_rls_missing_tables.sql. Mirror
-- the table list in RLS_POLICIES (packages/db/src/index.ts) — the rls.test.ts
-- meta-test fails if the two diverge.
ALTER TABLE "provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS provider_credentials_tenant_isolation ON "provider_credentials";--> statement-breakpoint
CREATE POLICY provider_credentials_tenant_isolation ON "provider_credentials" FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "tenant_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_models" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_models_tenant_isolation ON "tenant_models";--> statement-breakpoint
CREATE POLICY tenant_models_tenant_isolation ON "tenant_models" FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);