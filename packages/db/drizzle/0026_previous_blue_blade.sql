DROP INDEX "parse_cache_tenant_hash_idx";--> statement-breakpoint
ALTER TABLE "parse_cache" ADD COLUMN "provider_fingerprint" varchar(200) DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parse_cache_tenant_hash_provider_idx" ON "parse_cache" USING btree ("tenant_id","file_hash","provider_fingerprint");