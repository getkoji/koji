/**
 * Schema YAML compiler — validates and compiles schema YAML into
 * the parsed JSON representation used at extraction time.
 *
 * Strict validation: rejects unknown properties, unknown types,
 * invalid references. Catches errors at commit time, not extraction time.
 */

import { parse as parseYaml } from "yaml";

export interface CompileResult {
  ok: true;
  parsed: Record<string, unknown>;
}

export interface CompileError {
  ok: false;
  errors: Array<{ field?: string; message: string; line?: number }>;
}

const VALID_TYPES = new Set(["string", "number", "date", "boolean", "enum", "array", "object"]);

const VALID_FIELD_PROPS = new Set([
  "type", "required", "nullable", "importance", "review_below",
  "extraction_guidance", "validate", "normalize", "derived_from",
  "method", "values", "items", "fields", "merge", "description",
  "format", "default", "hints", "options", "signals",
]);

const VALID_NORMALIZE = new Set([
  "iso8601", "minor_units", "uppercase", "lowercase", "trim",
  "us_phone", "email", "url",
]);

const VALID_VALIDATE_PROPS = new Set([
  "regex", "min", "max", "min_length", "max_length", "min_words",
  "max_words", "on_fail", "on_miss", "snap_closest", "one_of",
]);

/**
 * Compile and validate schema YAML.
 */
export function compileSchema(yamlSource: string): CompileResult | CompileError {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlSource);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Invalid YAML";
    return { ok: false, errors: [{ message: `YAML parse error: ${msg}` }] };
  }

  if (!doc || typeof doc !== "object") {
    return { ok: false, errors: [{ message: "Schema must be a YAML mapping" }] };
  }

  const errors: Array<{ field?: string; message: string }> = [];

  // Top-level fields
  if (!doc.name || typeof doc.name !== "string") {
    errors.push({ message: "'name' is required and must be a string" });
  }

  if (!doc.fields || typeof doc.fields !== "object") {
    errors.push({ message: "'fields' is required and must be a mapping" });
    return { ok: false, errors };
  }

  const fields = doc.fields as Record<string, unknown>;
  const fieldNames = new Set(Object.keys(fields));

  for (const [name, rawDef] of Object.entries(fields)) {
    if (!rawDef || typeof rawDef !== "object") {
      errors.push({ field: name, message: `Field '${name}': definition must be a mapping` });
      continue;
    }

    const def = rawDef as Record<string, unknown>;

    // Check for unknown properties
    for (const prop of Object.keys(def)) {
      if (!VALID_FIELD_PROPS.has(prop)) {
        const suggestion = findClosest(prop, VALID_FIELD_PROPS);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        errors.push({ field: name, message: `Field '${name}': unknown property '${prop}'${hint}` });
      }
    }

    // Type is required
    if (!def.type) {
      errors.push({ field: name, message: `Field '${name}': 'type' is required` });
      continue;
    }

    if (!VALID_TYPES.has(def.type as string)) {
      errors.push({ field: name, message: `Field '${name}': unknown type '${def.type}'. Valid: ${[...VALID_TYPES].join(", ")}` });
    }

    // Enum must have values
    if (def.type === "enum") {
      if (!def.values || !Array.isArray(def.values)) {
        errors.push({ field: name, message: `Field '${name}': enum type requires 'values' array` });
      }
    }

    // Array must have items
    if (def.type === "array") {
      if (!def.items || typeof def.items !== "object") {
        errors.push({ field: name, message: `Field '${name}': array type requires 'items' definition` });
      }
    }

    // Object must have fields
    if (def.type === "object") {
      if (!def.fields || typeof def.fields !== "object") {
        errors.push({ field: name, message: `Field '${name}': object type requires 'fields' definition` });
      }
    }

    // derived_from must reference existing field
    if (def.derived_from && typeof def.derived_from === "string") {
      if (!fieldNames.has(def.derived_from)) {
        errors.push({ field: name, message: `Field '${name}': derived_from references '${def.derived_from}' which is not defined as a field` });
      }
    }

    // Normalize must be valid
    if (def.normalize && typeof def.normalize === "string") {
      if (!VALID_NORMALIZE.has(def.normalize)) {
        errors.push({ field: name, message: `Field '${name}': unknown normalize value '${def.normalize}'. Valid: ${[...VALID_NORMALIZE].join(", ")}` });
      }
    }

    // Validate properties check
    if (def.validate && typeof def.validate === "object") {
      const val = def.validate as Record<string, unknown>;
      for (const vProp of Object.keys(val)) {
        if (!VALID_VALIDATE_PROPS.has(vProp)) {
          const suggestion = findClosest(vProp, VALID_VALIDATE_PROPS);
          const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
          errors.push({ field: name, message: `Field '${name}': unknown validate property '${vProp}'${hint}` });
        }
      }

      // regex must compile
      if (val.regex && typeof val.regex === "string") {
        try {
          new RegExp(val.regex);
        } catch {
          errors.push({ field: name, message: `Field '${name}': regex pattern does not compile: '${val.regex}'` });
        }
      }

      // min/max must be numbers
      if (val.min !== undefined && typeof val.min !== "number") {
        errors.push({ field: name, message: `Field '${name}': validate.min must be a number` });
      }
      if (val.max !== undefined && typeof val.max !== "number") {
        errors.push({ field: name, message: `Field '${name}': validate.max must be a number` });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, parsed: doc };
}

/** Find the closest match from a set (Levenshtein distance ≤ 3). */
function findClosest(input: string, candidates: Set<string>): string | null {
  let best: string | null = null;
  let bestDist = 4;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}
