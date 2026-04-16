import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, updatedAt } from "./_shared";
import { users } from "./tenants";

/**
 * Playground tables are global (no `tenant_id`) — they belong to Koji as a
 * marketing expense, not to any customer tenant. They exist only on the
 * hosted platform.
 */
export const playgroundSessions = pgTable(
  "playground_sessions",
  {
    id: primaryKey(),
    anonymousId: varchar("anonymous_id", { length: 64 }).notNull(),
    userId: uuid("user_id").references(() => users.id),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => ({
    anonymousIdx: index("playground_anonymous_idx").on(t.anonymousId, t.createdAt),
  }),
);

export const playgroundExtractions = pgTable("playground_extractions", {
  id: primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => playgroundSessions.id, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 500 }),
  storageKey: varchar("storage_key", { length: 500 }),
  schemaYaml: text("schema_yaml"),
  resultJson: jsonb("result_json"),
  tokensUsed: integer("tokens_used"),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
  createdAt: createdAt(),
});

export const playgroundRateLimits = pgTable("playground_rate_limits", {
  anonymousId: varchar("anonymous_id", { length: 64 }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: updatedAt(),
});
