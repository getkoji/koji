-- Add field_overrides column to review_items.
-- Stores a JSON map of { fieldName: newValue } for any non-flagged fields
-- the reviewer edited during review. Enables audit trail of all corrections,
-- not just the primary flagged field.
ALTER TABLE "review_items" ADD COLUMN "field_overrides" jsonb;
