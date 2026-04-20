import { integer, pgTable, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { createdAt, primaryKey, tenantId } from "./_shared";
import { tenants } from "./tenants";

/**
 * Parse cache — maps file content hash to stored parse results in S3.
 *
 * Key: (tenant_id, file_hash). The file_hash is SHA-256 of the raw file bytes.
 * Value: storage_key pointing to `cache/{tenant_id}/{file_hash}.json` in S3.
 *
 * Tenant-scoped to prevent any cross-tenant data leakage.
 */
export const parseCache = pgTable(
  "parse_cache",
  {
    id: primaryKey(),
    tenantId: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    fileHash: varchar("file_hash", { length: 64 }).notNull(), // SHA-256 hex
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    pages: integer("pages").notNull(),
    ocrSkipped: varchar("ocr_skipped", { length: 8 }).default("false").notNull(),
    parseDurationMs: integer("parse_duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("parse_cache_tenant_hash_idx").on(t.tenantId, t.fileHash),
  ],
);
