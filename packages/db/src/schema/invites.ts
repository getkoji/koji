import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { bytea, createdAt, primaryKey, tenantId } from "./_shared";
import { tenants, users } from "./tenants";

export const invites = pgTable(
  "invites",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    roles: text("roles").array().notNull(),
    tokenHash: bytea("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("invites_token_idx")
      .on(t.tokenHash)
      .where(sql`accepted_at IS NULL`),
    tenantEmailIdx: index("invites_tenant_email_idx").on(t.tenantId, t.email),
  }),
);
