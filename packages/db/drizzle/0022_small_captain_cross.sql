CREATE TABLE "parse_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"model" varchar(64) NOT NULL,
	"config_json" jsonb NOT NULL,
	"auth_json" jsonb,
	"pricing_mode" varchar(16) DEFAULT 'default' NOT NULL,
	"pricing_override_json" jsonb,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"health_state" varchar(16) DEFAULT 'healthy' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "parse_endpoints" ADD CONSTRAINT "parse_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parse_endpoints" ADD CONSTRAINT "parse_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parse_endpoints_tenant_slug_idx" ON "parse_endpoints" USING btree ("tenant_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "parse_endpoints_tenant_idx" ON "parse_endpoints" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
-- RLS: parse_endpoints is tenant-scoped and stores encrypted BYO-parse
-- credentials. Drizzle Kit does not emit ENABLE ROW LEVEL SECURITY /
-- CREATE POLICY, so the policy DDL is appended here (same pattern as
-- 0013_rls_missing_tables and 0020_credential_model_backfill_rls). The
-- DROP POLICY IF EXISTS makes re-runs idempotent (Postgres has no
-- CREATE POLICY IF NOT EXISTS).
ALTER TABLE "parse_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parse_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS parse_endpoints_tenant_isolation ON parse_endpoints;--> statement-breakpoint
CREATE POLICY parse_endpoints_tenant_isolation ON parse_endpoints FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);