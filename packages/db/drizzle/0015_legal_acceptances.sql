-- Track customer agreement to legal documents (ToS, Privacy, AUP).
-- One row per (tenant, document, version) acceptance event; history
-- preserved across version bumps so we can prove acceptance evidence.

CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document" varchar(32) NOT NULL,
	"version" varchar(32) NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_by_user_id" uuid,
	"acceptance_method" varchar(32) NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "legal_acceptances"
	ADD CONSTRAINT "legal_acceptances_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "legal_acceptances"
	ADD CONSTRAINT "legal_acceptances_accepted_by_user_id_users_id_fk"
	FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id")
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "legal_acceptances_tenant_doc_version_idx"
	ON "legal_acceptances" USING btree ("tenant_id","document","version");
--> statement-breakpoint

CREATE INDEX "legal_acceptances_tenant_doc_latest_idx"
	ON "legal_acceptances" USING btree ("tenant_id","document","accepted_at");
--> statement-breakpoint

CREATE UNIQUE INDEX "legal_acceptances_unique_acceptance_idx"
	ON "legal_acceptances" USING btree ("tenant_id","document","version","accepted_by_user_id","accepted_at");
--> statement-breakpoint

-- RLS policy — tenant isolation enforced by Postgres so handlers cannot
-- accidentally leak acceptance records across tenants. Matches the
-- pattern used by every other tenant-scoped table; see
-- packages/db/src/rls.ts for the withRLS wrapper that sets the
-- app.current_tenant_id session variable.
ALTER TABLE "legal_acceptances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "legal_acceptances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "legal_acceptances_tenant_isolation" ON "legal_acceptances";
--> statement-breakpoint
CREATE POLICY "legal_acceptances_tenant_isolation" ON "legal_acceptances"
	FOR ALL
	USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
	WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
