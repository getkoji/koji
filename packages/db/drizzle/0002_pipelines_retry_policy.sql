-- Per-pipeline retry policy override (platform-55).
--
-- Nullable jsonb column. NULL = use platform defaults; a populated object
-- carries `{ maxAttempts, backoffBaseMs, backoffMaxMs, retryTransient }` — the
-- `RetryPolicy` shape exported from @koji/types/db. Wiring into the motor/queue
-- is a follow-up after platform-53 (transient-error classifier).
--
-- Additive change only: no drops, no data migration. Re-running is safe thanks
-- to the IF NOT EXISTS guard, matching the idempotency convention of the other
-- hand-maintained SQL in this directory.

ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "retry_policy_json" jsonb;
