CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"config_json" jsonb NOT NULL,
	"auth_json" jsonb,
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
CREATE TABLE "tenant_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"model" varchar(64) NOT NULL,
	"capability" varchar(16) DEFAULT 'chat' NOT NULL,
	"slug" varchar(64),
	"display_name" varchar(255),
	"pricing_mode" varchar(16) DEFAULT 'default' NOT NULL,
	"pricing_override_json" jsonb,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_models" ADD CONSTRAINT "tenant_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_models" ADD CONSTRAINT "tenant_models_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_tenant_slug_idx" ON "provider_credentials" USING btree ("tenant_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "provider_credentials_tenant_idx" ON "provider_credentials" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_models_credential_model_idx" ON "tenant_models" USING btree ("credential_id","model") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_models_tenant_idx" ON "tenant_models" USING btree ("tenant_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_models_credential_idx" ON "tenant_models" USING btree ("credential_id");