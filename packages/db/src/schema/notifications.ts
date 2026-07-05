import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { projects, tenants } from "./tenants";

export const notifications = pgTable(
  "notifications",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    // The project this notification belongs to. NULLABLE, unlike the other
    // project tables: some notifications are tenant-level (queue failures,
    // billing) and belong to no project — those stay visible in every project
    // (see the null-aware RLS policy). Project notifications show only in
    // their project.
    projectId: uuid("project_id").references(() => projects.id),
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
    projectCreatedIdx: index("notifications_project_created_idx").on(
      t.projectId,
      t.createdAt,
    ),
  }),
);
