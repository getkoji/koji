CREATE TABLE "classifier_run_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"classifier_run_id" uuid NOT NULL,
	"corpus_entry_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"expected_label" varchar(128),
	"predicted_label" varchar(128),
	"confidence" numeric(6, 4),
	"method" varchar(16),
	"tier_used" integer,
	"evidence_page" integer,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classifier_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"classifier_id" uuid NOT NULL,
	"classifier_version_id" uuid NOT NULL,
	"baseline_version_id" uuid,
	"triggered_by" uuid,
	"status" varchar(16) NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"docs_total" integer DEFAULT 0 NOT NULL,
	"docs_correct" integer DEFAULT 0 NOT NULL,
	"docs_failed" integer DEFAULT 0 NOT NULL,
	"accuracy" numeric(6, 4),
	"cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"error_message" text,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classifier_run_docs" ADD CONSTRAINT "classifier_run_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_run_docs" ADD CONSTRAINT "classifier_run_docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_run_docs" ADD CONSTRAINT "classifier_run_docs_classifier_run_id_classifier_runs_id_fk" FOREIGN KEY ("classifier_run_id") REFERENCES "public"."classifier_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_run_docs" ADD CONSTRAINT "classifier_run_docs_corpus_entry_id_corpus_entries_id_fk" FOREIGN KEY ("corpus_entry_id") REFERENCES "public"."corpus_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_classifier_id_classifiers_id_fk" FOREIGN KEY ("classifier_id") REFERENCES "public"."classifiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_classifier_version_id_classifier_versions_id_fk" FOREIGN KEY ("classifier_version_id") REFERENCES "public"."classifier_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_baseline_version_id_classifier_versions_id_fk" FOREIGN KEY ("baseline_version_id") REFERENCES "public"."classifier_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_runs" ADD CONSTRAINT "classifier_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classifier_run_docs_run_entry_idx" ON "classifier_run_docs" USING btree ("classifier_run_id","corpus_entry_id");--> statement-breakpoint
CREATE INDEX "classifier_run_docs_tenant_idx" ON "classifier_run_docs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "classifier_run_docs_project_idx" ON "classifier_run_docs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "classifier_runs_classifier_created_idx" ON "classifier_runs" USING btree ("classifier_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "classifier_runs_tenant_status_idx" ON "classifier_runs" USING btree ("tenant_id","status") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "classifier_runs_project_idx" ON "classifier_runs" USING btree ("project_id");