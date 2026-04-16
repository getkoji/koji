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

import { bytea, createdAt, primaryKey, tenantId, updatedAt } from "./_shared";
import { tenants, users } from "./tenants";

export const webhookTargets = pgTable(
  "webhook_targets",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    url: varchar("url", { length: 2048 }).notNull(),
    secretEncrypted: bytea("secret_encrypted").notNull(),
    subscribedEvents: text("subscribed_events").array().notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("webhook_targets_tenant_slug_idx").on(t.tenantId, t.slug),
    tenantActiveIdx: index("webhook_targets_tenant_idx")
      .on(t.tenantId)
      .where(sql`status = 'active'`),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => webhookTargets.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull(),
    httpStatus: integer("http_status"),
    responseBody: text("response_body"),
    responseHeaders: jsonb("response_headers"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    targetIdx: index("webhook_deliveries_target_idx").on(
      t.targetId,
      sql`${t.createdAt} DESC`,
    ),
    retryIdx: index("webhook_deliveries_retry_idx")
      .on(t.nextRetryAt)
      .where(sql`status = 'pending'`),
  }),
);
