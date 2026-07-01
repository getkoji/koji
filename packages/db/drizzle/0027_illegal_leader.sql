CREATE TABLE "classifier_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"classifier_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"major" integer DEFAULT 0 NOT NULL,
	"minor" integer DEFAULT 0 NOT NULL,
	"patch" integer DEFAULT 0 NOT NULL,
	"prerelease" varchar(32),
	"yaml_source" text NOT NULL,
	"yaml_hash" char(64) NOT NULL,
	"parsed_json" jsonb NOT NULL,
	"commit_message" varchar(500),
	"committed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"description" text,
	"current_version_id" uuid,
	"draft_yaml" text,
	"draft_updated_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD COLUMN "classifier_id" uuid;--> statement-breakpoint
ALTER TABLE "classifier_versions" ADD CONSTRAINT "classifier_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_versions" ADD CONSTRAINT "classifier_versions_classifier_id_classifiers_id_fk" FOREIGN KEY ("classifier_id") REFERENCES "public"."classifiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_versions" ADD CONSTRAINT "classifier_versions_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifiers" ADD CONSTRAINT "classifiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifiers" ADD CONSTRAINT "classifiers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classifier_versions_classifier_version_idx" ON "classifier_versions" USING btree ("classifier_id","version_number");--> statement-breakpoint
CREATE INDEX "classifier_versions_classifier_idx" ON "classifier_versions" USING btree ("classifier_id","version_number" DESC);--> statement-breakpoint
CREATE INDEX "classifier_versions_tenant_idx" ON "classifier_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classifier_versions_released_semver_idx" ON "classifier_versions" USING btree ("classifier_id","major","minor","patch") WHERE prerelease IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "classifiers_tenant_slug_idx" ON "classifiers" USING btree ("tenant_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "classifiers_tenant_idx" ON "classifiers" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "corpus_entries" ADD CONSTRAINT "corpus_entries_classifier_id_classifiers_id_fk" FOREIGN KEY ("classifier_id") REFERENCES "public"."classifiers"("id") ON DELETE cascade ON UPDATE no action;