CREATE TABLE "tune_score_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"pass" integer NOT NULL,
	"entry_id" uuid NOT NULL,
	"status" varchar(8) DEFAULT 'ok' NOT NULL,
	"extraction_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "phase" varchar(16);--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "scoring_pass" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "pending_yaml" text;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "pending_proposal_json" jsonb;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "docs_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD COLUMN "docs_scored" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tune_score_docs" ADD CONSTRAINT "tune_score_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tune_score_docs" ADD CONSTRAINT "tune_score_docs_run_id_tune_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tune_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tune_score_docs_pass_idx" ON "tune_score_docs" USING btree ("run_id","pass");--> statement-breakpoint
CREATE UNIQUE INDEX "tune_score_docs_entry_unique" ON "tune_score_docs" USING btree ("run_id","pass","entry_id");