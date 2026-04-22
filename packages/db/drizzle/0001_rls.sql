-- Row-Level Security policies.
--
-- This file is hand-written (Drizzle Kit does not emit RLS DDL). Every
-- tenant-scoped table from `database-schema.md` §3-15 gets the same
-- two-step treatment:
--
--   1. ENABLE + FORCE row level security so even the table owner can't
--      bypass the policy accidentally.
--   2. A single `FOR ALL` policy that matches the table's `tenant_id`
--      against `current_setting('app.current_tenant_id', true)::uuid`.
--      The `true` flag on `current_setting` means "missing_ok" — a
--      connection that forgot to `SET LOCAL app.current_tenant_id`
--      returns NULL, which never matches a real UUID, so the safe
--      default is zero rows.
--
-- The list of tables here MUST stay in lock-step with the `RLS_POLICIES`
-- array exported from `src/index.ts`. The test suite round-trips a row
-- per table to prove isolation; add new tables to both places or you
-- will leak data.
--
-- The file is re-run on every `runMigrations(...)` call, which happens
-- on every API boot. Postgres does NOT support CREATE POLICY IF NOT
-- EXISTS, so each CREATE POLICY is paired with a preceding
-- DROP POLICY IF EXISTS. That makes the file idempotent: the first run
-- creates the policies, subsequent runs drop-and-recreate without
-- changing behaviour. No warnings on restart, no risk of drifting
-- policy definitions across deploys.

-- ---------------------------------------------------------------------------
-- tenants
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_isolation ON tenants;
CREATE POLICY tenants_self_isolation ON tenants FOR ALL
  USING (id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);

-- Tenant-scoped tables: every row carries a `tenant_id` column and the
-- policy filters on it directly.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
CREATE POLICY api_keys_tenant_isolation ON api_keys FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invites_tenant_isolation ON invites;
CREATE POLICY invites_tenant_isolation ON invites FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE schemas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schemas_tenant_isolation ON schemas;
CREATE POLICY schemas_tenant_isolation ON schemas FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE schema_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_versions_tenant_isolation ON schema_versions;
CREATE POLICY schema_versions_tenant_isolation ON schema_versions FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE schema_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_samples FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_samples_tenant_isolation ON schema_samples;
CREATE POLICY schema_samples_tenant_isolation ON schema_samples FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE corpus_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corpus_entries_tenant_isolation ON corpus_entries;
CREATE POLICY corpus_entries_tenant_isolation ON corpus_entries FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE corpus_entry_ground_truth ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus_entry_ground_truth FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corpus_entry_ground_truth_tenant_isolation ON corpus_entry_ground_truth;
CREATE POLICY corpus_entry_ground_truth_tenant_isolation ON corpus_entry_ground_truth FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE corpus_entry_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus_entry_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corpus_entry_tags_tenant_isolation ON corpus_entry_tags;
CREATE POLICY corpus_entry_tags_tenant_isolation ON corpus_entry_tags FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE corpus_version_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus_version_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corpus_version_results_tenant_isolation ON corpus_version_results;
CREATE POLICY corpus_version_results_tenant_isolation ON corpus_version_results FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE schema_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_runs_tenant_isolation ON schema_runs;
CREATE POLICY schema_runs_tenant_isolation ON schema_runs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE schema_run_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_run_models FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_run_models_tenant_isolation ON schema_run_models;
CREATE POLICY schema_run_models_tenant_isolation ON schema_run_models FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipelines_tenant_isolation ON pipelines;
CREATE POLICY pipelines_tenant_isolation ON pipelines FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sources_tenant_isolation ON sources;
CREATE POLICY sources_tenant_isolation ON sources FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE ingestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ingestions_tenant_isolation ON ingestions;
CREATE POLICY ingestions_tenant_isolation ON ingestions FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_tenant_isolation ON jobs;
CREATE POLICY jobs_tenant_isolation ON jobs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE traces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS traces_tenant_isolation ON traces;
CREATE POLICY traces_tenant_isolation ON traces FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE trace_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_stages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trace_stages_tenant_isolation ON trace_stages;
CREATE POLICY trace_stages_tenant_isolation ON trace_stages FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_items_tenant_isolation ON review_items;
CREATE POLICY review_items_tenant_isolation ON review_items FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE model_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_endpoints_tenant_isolation ON model_endpoints;
CREATE POLICY model_endpoints_tenant_isolation ON model_endpoints FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE endpoint_usage_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoint_usage_rollups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS endpoint_usage_rollups_tenant_isolation ON endpoint_usage_rollups;
CREATE POLICY endpoint_usage_rollups_tenant_isolation ON endpoint_usage_rollups FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_sessions_tenant_isolation ON agent_sessions;
CREATE POLICY agent_sessions_tenant_isolation ON agent_sessions FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_messages_tenant_isolation ON agent_messages;
CREATE POLICY agent_messages_tenant_isolation ON agent_messages FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE agent_proposed_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_proposed_edits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_proposed_edits_tenant_isolation ON agent_proposed_edits;
CREATE POLICY agent_proposed_edits_tenant_isolation ON agent_proposed_edits FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE webhook_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_targets_tenant_isolation ON webhook_targets;
CREATE POLICY webhook_targets_tenant_isolation ON webhook_targets FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant_isolation ON webhook_deliveries FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Billing tables (enterprise_contracts, billable_events, invoices, stripe_events)
-- are NOT part of the core product. Their RLS policies live in
-- platform/packages/billing/drizzle/0001_billing_rls.sql and are applied by
-- the commercial hosting layer's migration runner.
