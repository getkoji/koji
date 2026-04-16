import { sql } from "drizzle-orm";
import {
  decimal,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { documents } from "./jobs";
import { schemas } from "./schemas";
import { tenants, users } from "./tenants";

export const reviewItems = pgTable(
  "review_items",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id),
    fieldName: varchar("field_name", { length: 128 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    proposedValue: jsonb("proposed_value"),
    confidence: decimal("confidence", { precision: 6, scale: 4 }),
    validationRule: varchar("validation_rule", { length: 128 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolution: varchar("resolution", { length: 16 }),
    finalValue: jsonb("final_value"),
    note: text("note"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    tenantStatusIdx: index("review_items_tenant_status_idx").on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
    assignedIdx: index("review_items_assigned_idx")
      .on(t.assignedTo, t.status)
      .where(sql`status IN ('pending', 'in_review')`),
    documentIdx: index("review_items_document_idx").on(t.documentId),
  }),
);
