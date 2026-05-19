-- Shadow memberships: hidden staff access to customer tenants.
-- Shadow members have full auth but are invisible in customer-facing
-- member lists. Used when Koji staff service customer accounts.
ALTER TABLE "memberships" ADD COLUMN "is_shadow" boolean DEFAULT false NOT NULL;
