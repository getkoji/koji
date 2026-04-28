-- Add external_auth_id to tenants for provider-agnostic org mapping
-- (Clerk org ID on hosted platform, any external identity for self-hosted)
ALTER TABLE tenants ADD COLUMN external_auth_id VARCHAR(255);
CREATE UNIQUE INDEX tenants_external_auth_id_idx ON tenants (external_auth_id)
  WHERE external_auth_id IS NOT NULL AND deleted_at IS NULL;
