import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { createdAt, inet, primaryKey, tenantId } from "./_shared";
import { tenants, users } from "./tenants";

/**
 * `legal_acceptances` — audit trail of customer agreement to legal documents
 * (Terms of Service, Privacy Policy, Acceptable Use Policy).
 *
 * One row per (tenant, document, version) acceptance event. We keep the
 * full history so we can answer "did this tenant accept ToS v2026-06-13?"
 * and produce evidence of acceptance if a customer ever disputes their
 * contractual obligations.
 *
 * `acceptedByUserId` records WHO clicked accept on behalf of the tenant.
 * For backfills entered by Koji admins (e.g. when a tenant accepted
 * out-of-band before the UI was built), the column is nullable and the
 * `acceptanceMethod` distinguishes the source.
 */
export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),

    /** Which document — see LEGAL_DOCUMENT_TYPES below. */
    document: varchar("document", { length: 32 }).notNull(),

    /**
     * Which version was accepted. We use the document's effective date as
     * the version identifier (YYYY-MM-DD), keeping it stable and ordered.
     */
    version: varchar("version", { length: 32 }).notNull(),

    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    /** User who clicked accept. Nullable for admin backfills. */
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /** How the acceptance was captured. See ACCEPTANCE_METHODS below. */
    acceptanceMethod: varchar("acceptance_method", { length: 32 }).notNull(),

    /** Best-effort capture of the actor's IP at acceptance time. */
    ipAddress: inet("ip_address"),

    /** Best-effort capture of the actor's browser at acceptance time. */
    userAgent: text("user_agent"),

    /** Free-form note — used for admin backfills to record context. */
    notes: text("notes"),

    createdAt: createdAt(),
  },
  (t) => ({
    /**
     * Fast lookup for "has this tenant accepted document D at version V?"
     * Not unique — we keep history of re-acceptances on version bumps.
     */
    tenantDocumentVersionIdx: index("legal_acceptances_tenant_doc_version_idx").on(
      t.tenantId,
      t.document,
      t.version,
    ),

    /**
     * Fast lookup for "what's the latest acceptance for this tenant for
     * each document type?"
     */
    tenantDocumentLatestIdx: index("legal_acceptances_tenant_doc_latest_idx").on(
      t.tenantId,
      t.document,
      t.acceptedAt,
    ),

    /**
     * Guard against duplicate same-second acceptances of the same version
     * by the same user (e.g. double-clicked checkbox). The full audit
     * trail is preserved across version bumps and across actors.
     */
    uniqueAcceptanceIdx: uniqueIndex("legal_acceptances_unique_acceptance_idx").on(
      t.tenantId,
      t.document,
      t.version,
      t.acceptedByUserId,
      t.acceptedAt,
    ),
  }),
);

/**
 * Document types tracked in `legal_acceptances.document`.
 *
 * Adding a new document type? Add it here, add the document at the
 * matching path on the marketing site, and update the acceptance-gating
 * code that calls `requireLegalAcceptance` (or equivalent) in the
 * platform's billing / signup flow.
 */
export const LEGAL_DOCUMENT_TYPES = [
  "terms_of_service",
  "privacy_policy",
  "acceptable_use_policy",
] as const;

export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

/**
 * How an acceptance was captured. The `admin_backfill` method exists so
 * Koji staff can record out-of-band acceptance (e.g. for a first paid
 * customer that subscribed before the click-to-accept UI shipped).
 */
export const ACCEPTANCE_METHODS = [
  "signup_checkbox",
  "billing_flow",
  "api",
  "admin_backfill",
] as const;

export type AcceptanceMethod = (typeof ACCEPTANCE_METHODS)[number];

/**
 * Current version of all legal documents, used as the default when
 * recording an acceptance. The version string matches the document's
 * effective date as published on the marketing site.
 *
 * When publishing a new version of any legal document, bump this value
 * and force re-acceptance from active tenants in the next billing-flow
 * gating step.
 */
export const CURRENT_LEGAL_VERSION = "2026-06-13";
