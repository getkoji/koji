-- Add billing-related columns to the tenants table.
-- Supports: Stripe linkage, per-tenant price overrides (grandfathering),
-- plan scheduling (downgrades at period end), trial, and billing alerts.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS price_override_usd DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS included_docs_override INT,
  ADD COLUMN IF NOT EXISTS overage_price_override_usd DECIMAL(10, 4),
  ADD COLUMN IF NOT EXISTS plan_scheduled VARCHAR(32),
  ADD COLUMN IF NOT EXISTS plan_scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_alerts_json JSONB,
  ADD COLUMN IF NOT EXISTS plan_overrides_json JSONB;

-- Index for Stripe customer lookup (webhook resolution)
CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_customer_idx
  ON tenants (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
