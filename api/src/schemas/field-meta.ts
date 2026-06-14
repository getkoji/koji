/**
 * Schema YAML → FieldMeta[] normalizer.
 *
 * Takes raw schema YAML and returns a stable JSON shape the dashboard (and
 * any other client) can consume without ever parsing YAML in the browser.
 *
 * Three input shapes are supported (in priority order if a field is declared
 * in more than one):
 *   1. `fields: { name: {...} }`     — the typical Koji shape
 *   2. `properties: { name: {...} }` — json-schema-style
 *   3. Top-level `name: {...}`       — legacy shape
 *
 * Unknown YAML keys on a field are silently dropped (forward-compat). Invalid
 * YAML yields an empty array — callers always get back something walkable.
 *
 * Pure function, no I/O. Unit-testable in isolation.
 */
import { parse as parseYaml } from "yaml";

export interface FieldMeta {
  name: string;
  /** Schema-declared type. Permissive `string` for forward-compat with future types. */
  type: string;
  description?: string;
  required?: boolean;
  /** Enum values, coerced to strings + deduped. Empty arrays are omitted. */
  enum?: string[];
  /**
   * Legacy `options` alias, surfaced only when it's present in the YAML and
   * NOT equivalent to `enum` (i.e. a schema that declares both `enum: [a]`
   * and `options: [a]` gets `enum` only — the redundancy is collapsed).
   */
  options?: string[];
  /** Bucket key → aliases. Bucket keys are the canonical/normalized values. */
  mappings?: Record<string, string[]>;
  /** Validate regex, if declared (`validate.regex` or top-level `pattern`). */
  pattern?: string;
}

const TOP_LEVEL_SKIP = new Set([
  "name",
  "description",
  "categories",
  "fields",
  "properties",
  "extends",
  "version",
  "type", // when used at the top level for json-schema-style docs
]);

/**
 * Top-level entry point. Returns `[]` for empty/invalid YAML so callers can
 * always iterate.
 */
export function extractFieldMetas(yamlSource: string): FieldMeta[] {
  if (!yamlSource || typeof yamlSource !== "string") return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];

  // Collect candidate field definitions from the three supported shapes,
  // honouring precedence: `fields` > `properties` > top-level.
  const seen = new Map<string, Record<string, unknown>>();

  // 3. top-level legacy (lowest precedence)
  for (const [key, value] of Object.entries(parsed)) {
    if (TOP_LEVEL_SKIP.has(key)) continue;
    if (isRecord(value) && looksLikeField(value)) {
      seen.set(key, value);
    }
  }

  // 2. `properties:` (overrides top-level)
  if (isRecord(parsed.properties)) {
    for (const [key, value] of Object.entries(parsed.properties)) {
      if (isRecord(value)) seen.set(key, value);
    }
  }

  // 1. `fields:` (highest precedence)
  if (isRecord(parsed.fields)) {
    for (const [key, value] of Object.entries(parsed.fields)) {
      if (isRecord(value)) seen.set(key, value);
    }
  }

  const metas: FieldMeta[] = [];
  for (const [name, def] of seen) {
    metas.push(buildFieldMeta(name, def));
  }
  return metas;
}

/** Heuristic: only treat top-level entries that look like field definitions. */
function looksLikeField(node: Record<string, unknown>): boolean {
  return (
    typeof node.type === "string" ||
    "enum" in node ||
    "options" in node ||
    "values" in node ||
    "mappings" in node ||
    "required" in node ||
    "description" in node
  );
}

function buildFieldMeta(name: string, def: Record<string, unknown>): FieldMeta {
  const meta: FieldMeta = {
    name,
    type: typeof def.type === "string" ? def.type : "string",
  };

  if (typeof def.description === "string") meta.description = def.description;
  if (typeof def.required === "boolean") meta.required = def.required;

  // enum — accept `enum:` or (when type is `enum`) `values:` as the canonical
  // list. Coerce scalars to strings, dedup, drop non-scalar entries.
  const enumSource =
    pickArray(def.enum) ??
    (def.type === "enum" ? pickArray(def.values) : undefined);
  if (enumSource && enumSource.length > 0) {
    meta.enum = enumSource;
  }

  // options — surface only if NOT equivalent to enum.
  const optionsSource = pickArray(def.options);
  if (optionsSource && optionsSource.length > 0) {
    if (!meta.enum || !sameStringArray(meta.enum, optionsSource)) {
      meta.options = optionsSource;
    }
  }

  // mappings — bucket-key → aliases (strings)
  const mappings = pickMappings(def.mappings);
  if (mappings && Object.keys(mappings).length > 0) {
    meta.mappings = mappings;
  }

  // pattern — `validate.regex` (Koji convention) or top-level `pattern`
  if (isRecord(def.validate) && typeof def.validate.regex === "string") {
    meta.pattern = def.validate.regex;
  } else if (typeof def.pattern === "string") {
    meta.pattern = def.pattern;
  }

  return meta;
}

function pickArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const s = String(v);
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

function pickMappings(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [bucket, aliases] of Object.entries(value)) {
    if (!bucket) continue;
    if (Array.isArray(aliases)) {
      const list: string[] = [];
      for (const a of aliases) {
        if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") {
          list.push(String(a));
        }
      }
      out[bucket] = list;
    } else {
      // bucket declared with no aliases — keep the bucket key, empty alias list
      out[bucket] = [];
    }
  }
  return out;
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
