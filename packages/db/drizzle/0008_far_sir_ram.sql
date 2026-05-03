ALTER TABLE "documents" ADD COLUMN "group_key" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "references_json" jsonb;--> statement-breakpoint
CREATE INDEX "documents_group_key_idx" ON "documents" USING btree ("tenant_id","group_key");