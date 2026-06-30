import { integer, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { tenants } from "./tenants";

/**
 * Parse cache — maps file content hash to stored parse results in S3.
 *
 * Key: (tenant_id, file_hash, provider_fingerprint). The file_hash is SHA-256
 * of the raw file bytes. The provider_fingerprint identifies the resolved parse
 * provider that produced the markdown (provider slug + endpoint id + endpoint
 * updatedAt, or "default" for the system default heavy provider). Including it
 * in the key means switching/editing a parse provider re-parses instead of
 * returning the previous provider's stale markdown (oss-298).
 * Value: storage_key pointing to `cache/{tenant_id}/{file_hash}[.{fp}].json`.
 *
 * Tenant-scoped to prevent any cross-tenant data leakage.
 */
export const parseCache = pgTable(
  "parse_cache",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    fileHash: varchar("file_hash", { length: 64 }).notNull(), // SHA-256 hex
    /**
     * Stable fingerprint of the parse provider that produced this entry.
     * "default" for the system default heavy provider; otherwise
     * `<provider>:<endpointId>:<updatedAt>`. See api `parse/cache-fingerprint`.
     */
    providerFingerprint: varchar("provider_fingerprint", { length: 200 })
      .default("default")
      .notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    pages: integer("pages").notNull(),
    ocrSkipped: varchar("ocr_skipped", { length: 8 }).default("false").notNull(),
    parseDurationMs: integer("parse_duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("parse_cache_tenant_hash_provider_idx").on(
      t.tenantId,
      t.fileHash,
      t.providerFingerprint,
    ),
  ],
);
