import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { tenants } from "./tenants";

/**
 * Background job queue — Postgres-backed with SELECT...FOR UPDATE SKIP LOCKED.
 *
 * This is the queue table, not the user-facing "jobs" table (that's in jobs.ts
 * for extraction pipeline jobs). This table handles internal async work:
 * webhook delivery, schema validation runs, corpus scoring, etc.
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    priority: integer("priority").notNull().default(0), // higher = sooner
    attempt: integer("attempt").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(12),
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull().default(sql`NOW()`),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    errorMessage: text("error_message"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    createdAt: createdAt(),
  },
  (t) => ({
    pollIdx: index("bg_jobs_poll_idx")
      .on(t.status, t.priority, t.runAt, t.createdAt)
      .where(sql`status = 'pending'`),
    kindIdx: index("bg_jobs_kind_idx").on(t.tenantId, t.kind),
    idempotencyIdx: uniqueIndex("bg_jobs_idempotency_idx")
      .on(t.tenantId, t.kind, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL AND status NOT IN ('succeeded', 'failed_terminal')`),
  }),
);
