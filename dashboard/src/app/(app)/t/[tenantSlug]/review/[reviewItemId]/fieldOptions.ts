/**
 * Extract the dropdown options for a single field from a schema's YAML
 * source.
 *
 * The previous implementation was a hand-rolled regex that matched any
 * indented `key:` followed by `[` and treated those keys as options — so
 * schema metadata like `patterns: [...]` or `examples: [...]` would leak
 * into the override dropdown as if they were enum values. This module
 * uses the `yaml` package to actually parse the document and only
 * surfaces options when the field declares one of:
 *
 *  1. `enum: [...]`           — an enum constraint
 *  2. `options: [...]`        — an explicit option list (legacy alias)
 *  3. `mappings: {KEY: [...]}` — a bucketed normalizer block; the bucket
 *                                keys are the canonical values
 *
 * Anything else returns `null` and the override input falls back to a
 * free-text textbox.
 *
 * Pure function, no I/O — unit-testable in isolation.
 */

import YAML from "yaml";

const OPTION_KEYS = ["enum", "options"] as const;
const MAPPING_KEYS = ["mappings", "mapping"] as const;

export function extractFieldOptionsFromSchemaYaml(
  yamlSource: string,
  fieldName: string,
): string[] | null {
  if (!yamlSource || !fieldName) return null;

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlSource);
  } catch {
    return null;
  }

  const fieldNode = findFieldDefinition(parsed, fieldName);
  if (!isRecord(fieldNode)) return null;

  // 1. Direct `enum` / `options` array.
  for (const key of OPTION_KEYS) {
    const value = fieldNode[key];
    if (Array.isArray(value)) {
      const options = value
        .filter((v): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        .map((v) => String(v));
      if (options.length > 0) return dedup(options);
    }
  }

  // 2. `mappings` block — the KEYS are the canonical values.
  for (const key of MAPPING_KEYS) {
    const value = fieldNode[key];
    if (isRecord(value)) {
      const keys = Object.keys(value).filter((k) => k.length > 0);
      if (keys.length > 0) return dedup(keys);
    }
  }

  return null;
}

/**
 * Schemas live under either `fields: { fieldName: {...} }` (typical
 * Koji shape) or directly at the top level (`fieldName: {...}` — older
 * schemas). Walk both.
 */
function findFieldDefinition(parsed: unknown, fieldName: string): unknown {
  if (!isRecord(parsed)) return undefined;

  // Typical shape: `fields: { fieldName: {...} }`
  if (isRecord(parsed.fields) && parsed.fields[fieldName] !== undefined) {
    return parsed.fields[fieldName];
  }

  // Legacy: field declared directly at top level.
  if (parsed[fieldName] !== undefined) {
    return parsed[fieldName];
  }

  // Some schemas wrap fields under `properties` (json-schema style).
  if (isRecord(parsed.properties) && parsed.properties[fieldName] !== undefined) {
    return parsed.properties[fieldName];
  }

  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedup(values: string[]): string[] {
  return Array.from(new Set(values));
}
