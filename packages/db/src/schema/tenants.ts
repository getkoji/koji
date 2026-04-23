import { sql } from "drizzle-orm";
import {
  decimal,
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

import {
  bytea,
  createdAt,
  deletedAt,
  inet,
  primaryKey,
  tenantId,
  updatedAt,
} from "./_shared";

export const tenants = pgTable(
  "tenants",
  {
    id: primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    plan: varchar("plan", { length: 32 }).notNull().default("free"),
    billingEmail: varchar("billing_email", { length: 255 }),
    enterpriseContractId: uuid("enterprise_contract_id"),

    // Stripe linkage
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),

    // Per-tenant overrides (grandfathering, custom deals)
    priceOverrideUsd: decimal("price_override_usd", { precision: 10, scale: 2 }),
    includedDocsOverride: integer("included_docs_override"),
    overagePriceOverrideUsd: decimal("overage_price_override_usd", { precision: 10, scale: 4 }),

    // Per-tenant feature + limit overrides. Sparse JSONB — only keys present
    // are overridden; everything else falls through to the plan default.
    // Shape: Partial<PlanFeatures & PreflightLimits>
    // e.g. { "max_schemas": 10, "hitl_review": true, "max_pages": 1000 }
    planOverridesJson: jsonb("plan_overrides_json"),

    // Plan scheduling (downgrades take effect at period end)
    planScheduled: varchar("plan_scheduled", { length: 32 }),
    planScheduledAt: timestamp("plan_scheduled_at", { withTimezone: true, mode: "date" }),

    // Trial
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "date" }),

    // Billing alerts config
    billingAlertsJson: jsonb("billing_alerts_json"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug).where(sql`deleted_at IS NULL`),
  }),
);

export const users = pgTable(
  "users",
  {
    id: primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    avatarUrl: varchar("avatar_url", { length: 2048 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    authProvider: varchar("auth_provider", { length: 32 }).notNull(),
    authProviderId: varchar("auth_provider_id", { length: 255 }).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email).where(sql`deleted_at IS NULL`),
    providerIdx: uniqueIndex("users_auth_provider_idx").on(t.authProvider, t.authProviderId),
  }),
);

export const projects = pgTable(
  "projects",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    description: text("description"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tenantSlugIdx: uniqueIndex("projects_tenant_slug_idx")
      .on(t.tenantId, t.slug)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("projects_tenant_idx").on(t.tenantId).where(sql`deleted_at IS NULL`),
  }),
);

export const memberships = pgTable(
  "memberships",
  {
    id: primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    roles: text("roles").array().notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    userTenantIdx: uniqueIndex("memberships_user_tenant_idx").on(t.userId, t.tenantId),
    tenantIdx: index("memberships_tenant_idx").on(t.tenantId),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

export const passwordResets = pgTable(
  "password_resets",
  {
    id: primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("password_resets_token_hash_idx").on(t.tokenHash),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("sessions_token_hash_idx").on(t.tokenHash),
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
    keyHash: bytea("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    tenantNameIdx: uniqueIndex("api_keys_tenant_name_idx").on(t.tenantId, t.name),
    hashIdx: index("api_keys_hash_idx").on(t.keyHash).where(sql`revoked_at IS NULL`),
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    actorId: varchar("actor_id", { length: 64 }),
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 128 }).notNull(),
    traceId: varchar("trace_id", { length: 64 }),
    ipAddress: inet("ip_address"),
    userAgent: varchar("user_agent", { length: 512 }),
    detailsJson: jsonb("details_json"),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantCreatedIdx: index("audit_log_tenant_created_idx").on(t.tenantId, sql`${t.createdAt} DESC`),
    actorIdx: index("audit_log_actor_idx").on(t.tenantId, t.actorUserId, sql`${t.createdAt} DESC`),
    resourceIdx: index("audit_log_resource_idx").on(t.tenantId, t.resourceType, t.resourceId),
  }),
);
