-- Project isolation: denormalized project_id on every directly-listed
-- resource. Hand-tuned from the drizzle-kit output: the columns are added
-- nullable, backfilled to each tenant's default project, then set NOT NULL —
-- a straight ADD COLUMN NOT NULL would fail on any non-empty install.
--
-- The matching RESTRICTIVE RLS policies live in 0001_rls.sql (re-applied
-- after the journaled migrations on every migrate run, so the columns are
-- guaranteed to exist by the time the policies reference them).

DROP INDEX "api_keys_tenant_name_idx";--> statement-breakpoint
DROP INDEX "schemas_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "classifiers_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "pipelines_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "sources_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "model_endpoints_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "parse_endpoints_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "provider_credentials_tenant_slug_idx";--> statement-breakpoint
DROP INDEX "webhook_targets_tenant_slug_idx";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "schemas" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "classifiers" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "model_endpoints" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "parse_endpoints" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_targets" ADD COLUMN "project_id" uuid;--> statement-breakpoint

-- Every tenant needs a default project to backfill into. The setup flow has
-- always created one whose slug mirrors the tenant slug, but guard against
-- tenants that predate it (created_by falls back to the earliest member,
-- then any user — cosmetic on an auto-created row).
INSERT INTO projects (tenant_id, slug, display_name, created_by)
SELECT t.id, t.slug, t.display_name,
  COALESCE(
    (SELECT user_id FROM memberships WHERE tenant_id = t.id ORDER BY created_at ASC LIMIT 1),
    (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  )
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = t.id AND p.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM users);--> statement-breakpoint

-- Backfill: the tenant's default project is the one whose slug matches the
-- tenant slug, falling back to the oldest live project.
UPDATE api_keys x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE schemas x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE classifiers x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE pipelines x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE sources x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE model_endpoints x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE parse_endpoints x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE provider_credentials x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE jobs x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE review_items x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint
UPDATE webhook_targets x SET project_id = dp.id FROM (SELECT DISTINCT ON (p.tenant_id) p.tenant_id, p.id FROM projects p JOIN tenants t ON t.id = p.tenant_id WHERE p.deleted_at IS NULL ORDER BY p.tenant_id, (p.slug = t.slug) DESC, p.created_at ASC, p.id ASC) dp WHERE dp.tenant_id = x.tenant_id AND x.project_id IS NULL;--> statement-breakpoint

ALTER TABLE "api_keys" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schemas" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "classifiers" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_endpoints" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "parse_endpoints" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "review_items" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_targets" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schemas" ADD CONSTRAINT "schemas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifiers" ADD CONSTRAINT "classifiers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_endpoints" ADD CONSTRAINT "model_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parse_endpoints" ADD CONSTRAINT "parse_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_targets" ADD CONSTRAINT "webhook_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_project_name_idx" ON "api_keys" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schemas_project_slug_idx" ON "schemas" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "schemas_project_idx" ON "schemas" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "classifiers_project_slug_idx" ON "classifiers" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "classifiers_project_idx" ON "classifiers" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_project_slug_idx" ON "pipelines" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "pipelines_project_idx" ON "pipelines" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_project_slug_idx" ON "sources" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "sources_project_idx" ON "sources" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_endpoints_project_slug_idx" ON "model_endpoints" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "model_endpoints_project_idx" ON "model_endpoints" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parse_endpoints_project_slug_idx" ON "parse_endpoints" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "parse_endpoints_project_idx" ON "parse_endpoints" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_project_slug_idx" ON "provider_credentials" USING btree ("project_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "provider_credentials_project_idx" ON "provider_credentials" USING btree ("project_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "jobs_project_created_idx" ON "jobs" USING btree ("project_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "review_items_project_status_idx" ON "review_items" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_targets_project_slug_idx" ON "webhook_targets" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "webhook_targets_project_idx" ON "webhook_targets" USING btree ("project_id") WHERE status = 'active';
