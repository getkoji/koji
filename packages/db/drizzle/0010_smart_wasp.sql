CREATE TABLE "form_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"description" text,
	"sample_storage_key" varchar(500),
	"sample_page_count" integer,
	"mappings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint_json" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "form_mappings" ADD CONSTRAINT "form_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_mappings" ADD CONSTRAINT "form_mappings_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_mappings" ADD CONSTRAINT "form_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_mappings_tenant_schema_slug_idx" ON "form_mappings" USING btree ("tenant_id","schema_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "form_mappings_schema_idx" ON "form_mappings" USING btree ("schema_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "form_mappings_tenant_status_idx" ON "form_mappings" USING btree ("tenant_id","status") WHERE deleted_at IS NULL;