CREATE TABLE "pipeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"yaml_source" text NOT NULL,
	"dag_json" jsonb NOT NULL,
	"commit_message" varchar(500),
	"committed_by" uuid NOT NULL,
	"deployed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"step_id" varchar(64) NOT NULL,
	"step_type" varchar(32) NOT NULL,
	"step_order" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"error_message" text,
	"duration_ms" integer,
	"cost_usd" numeric(10, 6),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "pipeline_type" varchar(16) DEFAULT 'simple' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "dag_json" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_versions_pipeline_version_idx" ON "pipeline_versions" USING btree ("pipeline_id","version_number");--> statement-breakpoint
CREATE INDEX "pipeline_versions_pipeline_deployed_idx" ON "pipeline_versions" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "pipeline_versions_tenant_idx" ON "pipeline_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_step_runs_doc_step_idx" ON "pipeline_step_runs" USING btree ("document_id","step_id");--> statement-breakpoint
CREATE INDEX "pipeline_step_runs_job_idx" ON "pipeline_step_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "pipeline_step_runs_tenant_status_idx" ON "pipeline_step_runs" USING btree ("tenant_id","status");