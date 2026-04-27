ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_subscription_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "price_override_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "included_docs_override" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "overage_price_override_usd" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_overrides_json" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_scheduled" varchar(32);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_alerts_json" jsonb;