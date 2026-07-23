ALTER TABLE "model_endpoints" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "parse_endpoints" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_endpoints_shared_slug_idx" ON "model_endpoints" USING btree ("tenant_id","slug") WHERE project_id IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parse_endpoints_shared_slug_idx" ON "parse_endpoints" USING btree ("tenant_id","slug") WHERE project_id IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_shared_slug_idx" ON "provider_credentials" USING btree ("tenant_id","slug") WHERE project_id IS NULL AND deleted_at IS NULL;