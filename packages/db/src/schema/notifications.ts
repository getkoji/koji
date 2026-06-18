import { index, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { tenants } from "./tenants";

export const notifications = pgTable(
  "notifications",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    dataJson: jsonb("data_json"),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantCreatedIdx: index("notifications_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);
