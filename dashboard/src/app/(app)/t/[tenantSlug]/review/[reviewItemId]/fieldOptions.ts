/**
 * Derive the override-dropdown options for a single review field from the
 * server-side schema field metadata.
 *
 * The dashboard used to fetch raw schema YAML and parse it client-side to
 * build these options — see commit history for the regex-based and then
 * yaml-parser versions. Both shapes had the same downside: the browser had
 * to know the schema YAML grammar. We now ship a stable JSON shape from the
 * API (`GET /api/schemas/:slug/fields` → `SchemaFieldMeta[]`) and this
 * helper just walks it.
 *
 * Three sources of options, in priority order:
 *   1. `enum`     — explicit enum constraint
 *   2. `options`  — legacy alias (only surfaced when not equivalent to enum)
 *   3. `mappings` — bucket-key → aliases; the keys are the canonical values
 *
 * Anything else returns `null` and the override input falls back to a
 * free-text textbox.
 *
 * Pure function, no I/O — unit-testable in isolation.
 */

import type { SchemaFieldMeta } from "@/lib/api";

export function deriveFieldOptions(
  fields: SchemaFieldMeta[] | null | undefined,
  fieldName: string,
): string[] | null {
  if (!fields || !fieldName) return null;

  const meta = fields.find((f) => f.name === fieldName);
  if (!meta) return null;

  if (meta.enum && meta.enum.length > 0) return dedup(meta.enum);
  if (meta.options && meta.options.length > 0) return dedup(meta.options);
  if (meta.mappings) {
    const keys = Object.keys(meta.mappings).filter((k) => k.length > 0);
    if (keys.length > 0) return dedup(keys);
  }
  return null;
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}
