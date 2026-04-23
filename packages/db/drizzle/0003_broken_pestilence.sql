CREATE TABLE "model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model_id" varchar(128) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"context_window" integer,
	"supports_vision" varchar(8) DEFAULT 'false',
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 12 NOT NULL,
	"run_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"idempotency_key" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parse_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"pages" integer NOT NULL,
	"ocr_skipped" varchar(8) DEFAULT 'false' NOT NULL,
	"parse_duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"schema_version_id" uuid,
	"schema_run_id" uuid,
	"corpus_entry_id" uuid NOT NULL,
	"model" varchar(128) NOT NULL,
	"schema_yaml_hash" varchar(64),
	"extracted_json" jsonb NOT NULL,
	"confidence_json" jsonb,
	"confidence_scores_json" jsonb,
	"parse_seconds" numeric(10, 2),
	"extract_ms" integer,
	"ocr_skipped" varchar(8) DEFAULT 'false',
	"cached" varchar(8) DEFAULT 'false',
	"triggered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "yaml_source" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "parsed_json" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "trigger_type" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "trigger_config_json" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "schema_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "active_schema_version_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "model_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "config_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "retry_policy_json" jsonb;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "review_threshold" varchar(8) DEFAULT '0.9' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parse_cache" ADD CONSTRAINT "parse_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_schema_version_id_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."schema_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_schema_run_id_schema_runs_id_fk" FOREIGN KEY ("schema_run_id") REFERENCES "public"."schema_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_corpus_entry_id_corpus_entries_id_fk" FOREIGN KEY ("corpus_entry_id") REFERENCES "public"."corpus_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_tenant_provider_model_idx" ON "model_catalog" USING btree ("tenant_id","provider","model_id");--> statement-breakpoint
CREATE INDEX "model_catalog_tenant_provider_idx" ON "model_catalog" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "bg_jobs_poll_idx" ON "background_jobs" USING btree ("status","priority","run_at","created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "bg_jobs_kind_idx" ON "background_jobs" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "bg_jobs_idempotency_idx" ON "background_jobs" USING btree ("tenant_id","kind","idempotency_key") WHERE idempotency_key IS NOT NULL AND status NOT IN ('succeeded', 'failed_terminal');--> statement-breakpoint
CREATE UNIQUE INDEX "parse_cache_tenant_hash_idx" ON "parse_cache" USING btree ("tenant_id","file_hash");--> statement-breakpoint
CREATE INDEX "extraction_runs_corpus_entry_idx" ON "extraction_runs" USING btree ("corpus_entry_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "extraction_runs_schema_idx" ON "extraction_runs" USING btree ("schema_id","created_at" DESC);