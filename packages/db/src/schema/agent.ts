import { sql } from "drizzle-orm";
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

import { createdAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { tenants, users } from "./tenants";

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    context: varchar("context", { length: 32 }).notNull(),
    contextEntityId: varchar("context_entity_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    userContextIdx: index("agent_sessions_user_context_idx").on(
      t.userId,
      t.context,
      t.contextEntityId,
      sql`${t.updatedAt} DESC`,
    ),
  }),
);

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    toolCallsJson: jsonb("tool_calls_json"),
    toolResultsJson: jsonb("tool_results_json"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
    createdAt: createdAt(),
  },
  (t) => ({
    sessionCreatedIdx: index("agent_messages_session_created_idx").on(t.sessionId, t.createdAt),
  }),
);

export const agentProposedEdits = pgTable(
  "agent_proposed_edits",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => agentMessages.id),
    editKind: varchar("edit_kind", { length: 32 }).notNull(),
    targetId: varchar("target_id", { length: 128 }).notNull(),
    diffText: text("diff_text").notNull(),
    proposedChangeJson: jsonb("proposed_change_json").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    sessionStatusIdx: index("agent_edits_session_idx").on(t.sessionId, t.status),
  }),
);
