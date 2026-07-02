CREATE TABLE "schema_run_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schema_run_id" uuid NOT NULL,
	"corpus_entry_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"error_message" text,
	"routing_plan_json" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schema_runs" ADD COLUMN "result_json" jsonb;--> statement-breakpoint
ALTER TABLE "schema_run_docs" ADD CONSTRAINT "schema_run_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_run_docs" ADD CONSTRAINT "schema_run_docs_schema_run_id_schema_runs_id_fk" FOREIGN KEY ("schema_run_id") REFERENCES "public"."schema_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_run_docs" ADD CONSTRAINT "schema_run_docs_corpus_entry_id_corpus_entries_id_fk" FOREIGN KEY ("corpus_entry_id") REFERENCES "public"."corpus_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "schema_run_docs_run_entry_idx" ON "schema_run_docs" USING btree ("schema_run_id","corpus_entry_id");--> statement-breakpoint
CREATE INDEX "schema_run_docs_tenant_idx" ON "schema_run_docs" USING btree ("tenant_id");--> statement-breakpoint
-- RLS: schema_run_docs is tenant-scoped (per-doc validate progress + errors).
-- Drizzle Kit does not emit ENABLE ROW LEVEL SECURITY / CREATE POLICY, so the
-- policy DDL is appended here (same pattern as 0013_rls_missing_tables and
-- 0022_small_captain_cross). DROP POLICY IF EXISTS keeps re-runs idempotent.
ALTER TABLE "schema_run_docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schema_run_docs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS schema_run_docs_tenant_isolation ON schema_run_docs;--> statement-breakpoint
CREATE POLICY schema_run_docs_tenant_isolation ON schema_run_docs FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
