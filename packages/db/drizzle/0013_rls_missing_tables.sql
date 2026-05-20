-- Add RLS policies to tenant-scoped tables that were missing them.
-- These tables had tenant_id columns but no RLS enforcement, allowing
-- cross-tenant data leakage.

ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS extraction_runs_tenant_isolation ON extraction_runs;
CREATE POLICY extraction_runs_tenant_isolation ON extraction_runs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE form_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS form_mappings_tenant_isolation ON form_mappings;
CREATE POLICY form_mappings_tenant_isolation ON form_mappings FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE pipeline_step_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_step_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_step_runs_tenant_isolation ON pipeline_step_runs;
CREATE POLICY pipeline_step_runs_tenant_isolation ON pipeline_step_runs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE pipeline_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_versions_tenant_isolation ON pipeline_versions;
CREATE POLICY pipeline_versions_tenant_isolation ON pipeline_versions FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
