CREATE TABLE "tune_run_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"accuracy" real,
	"docs_passed" integer,
	"docs_total" integer,
	"accepted" boolean DEFAULT false NOT NULL,
	"focus_doc" varchar(500),
	"fixing_json" jsonb,
	"regressions_json" jsonb,
	"explanation" text,
	"thinking" text,
	"proposed_yaml" text,
	"yaml_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tune_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schema_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"start_yaml" text NOT NULL,
	"best_yaml" text NOT NULL,
	"baseline_accuracy" real,
	"best_accuracy" real,
	"best_snapshot_json" jsonb,
	"max_iterations" integer DEFAULT 5 NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"stop_reason" varchar(32),
	"model" varchar(128),
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tune_run_rounds" ADD CONSTRAINT "tune_run_rounds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tune_run_rounds" ADD CONSTRAINT "tune_run_rounds_run_id_tune_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tune_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD CONSTRAINT "tune_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD CONSTRAINT "tune_runs_schema_id_schemas_id_fk" FOREIGN KEY ("schema_id") REFERENCES "public"."schemas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tune_runs" ADD CONSTRAINT "tune_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tune_run_rounds_run_idx" ON "tune_run_rounds" USING btree ("run_id","n");--> statement-breakpoint
CREATE INDEX "tune_runs_schema_idx" ON "tune_runs" USING btree ("schema_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "tune_runs_status_idx" ON "tune_runs" USING btree ("status");