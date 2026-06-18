-- Endpoint health tracking: every LLM call updates these columns on the
-- corresponding model_endpoints row. The application transitions an
-- endpoint to health_state='unhealthy' after THRESHOLD consecutive
-- failures and back to 'healthy' on the next success — emitting
-- endpoint.unhealthy / endpoint.recovered events on the transition.
--
-- These are deliberately denormalized counters (no separate event log
-- table). Querying current health is fast and the columns survive the
-- soft-delete pattern via deleted_at.

ALTER TABLE "model_endpoints"
  ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0,
  ADD COLUMN "last_success_at" timestamp with time zone,
  ADD COLUMN "last_failure_at" timestamp with time zone,
  ADD COLUMN "last_failure_reason" text,
  ADD COLUMN "health_state" varchar(16) NOT NULL DEFAULT 'healthy';
