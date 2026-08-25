ALTER TABLE "review_items" ADD COLUMN "edited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill history (oss-494). Rows resolved before this column existed have
-- only one signal available: whether the reviewer's final value differs from
-- what Koji proposed. `/approve` wrote final_value = proposed_value, and
-- `/override` wrote the reviewer's own value, so the comparison reconstructs
-- the distinction exactly for past rows. Rejected items changed nothing.
UPDATE "review_items"
SET "edited" = true
WHERE "status" = 'completed'
  AND "resolution" = 'approved'
  AND "final_value" IS DISTINCT FROM "proposed_value";
