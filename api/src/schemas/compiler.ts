/**
 * Schema YAML compiler — validates and compiles schema YAML into
 * the parsed JSON representation used at extraction time.
 *
 * Strict validation: rejects unknown properties, unknown types,
 * invalid references. Catches errors at commit time, not extraction time.
 */

import { parse as parseYaml } from "yaml";
import { arrayItemProperties, objectProperties } from "../extract/schema-tree";

export interface CompileResult {
  ok: true;
  parsed: Record<string, unknown>;
}

export interface CompileError {
  ok: false;
  errors: Array<{ field?: string; message: string; line?: number }>;
}

const VALID_TYPES = new Set(["string", "number", "date", "boolean", "enum", "mapping", "array", "object"]);

const VALID_FIELD_PROPS = new Set([
  "type", "required", "nullable", "importance", "review_below",
  "extraction_guidance", "extraction_hint", "extraction_hint_by",
  "validate", "normalize", "derived_from", "depends_on",
  "method", "values", "items", "fields", "merge", "description",
  "format", "default", "hints", "options", "signals", "resolve",
  "verbatim", "mappings", "properties", "enum",
  "vocab_by", "vocab_default", "keep_raw",
]);

const VALID_NORMALIZE = new Set([
  "trim", "lowercase", "uppercase", "title_case", "slugify",
  "collapse_spaces", "remove_spaces", "fix_punctuation_spacing", "prose",
  "iso8601",
  "minor_units", "integer", "decimal_amount", "percent",
  "digits_only", "boolean",
  "email", "url", "e164",
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

    // Conditional vocabulary supplies values per branch, so it satisfies the
    // "enum/mapping needs a vocabulary" requirement on its own.
    const hasVocabBy = def.vocab_by && typeof def.vocab_by === "object" && !Array.isArray(def.vocab_by);

    // Enum must have values, options, mappings, or vocab_by
    if (def.type === "enum") {
      const enumValues = def.values ?? def.options;
      const hasMappings = def.mappings && typeof def.mappings === "object" && Object.keys(def.mappings as object).length > 0;
      if (!hasVocabBy && !hasMappings && (!enumValues || !Array.isArray(enumValues))) {
        errors.push({ field: name, message: `Field '${name}': enum type requires 'values', 'options', 'mappings', or 'vocab_by'` });
      }
    }

    // Mapping type requires mappings property (or vocab_by)
    if (def.type === "mapping") {
      const hasMappings = def.mappings && typeof def.mappings === "object" && Object.keys(def.mappings as object).length > 0;
      if (!hasVocabBy && !hasMappings) {
        errors.push({ field: name, message: `Field '${name}': mapping type requires a 'mappings' object or 'vocab_by'` });
      }
    }

    // vocab_by shape + sibling-existence is validated recursively after this
    // loop by validateVocabTree, so it covers nested array-item / object fields
    // with each level's own field names as the sibling scope.

    // Array must have items
    if (def.type === "array") {
      if (!def.items || typeof def.items !== "object") {
        errors.push({ field: name, message: `Field '${name}': array type requires 'items' definition` });
      }
    }

    // Object must declare its child fields. `properties` is canonical (matches
    // array items); `fields` is accepted as an alias so the two never diverge.
    if (def.type === "object") {
      const childProps = def.properties ?? def.fields;
      if (!childProps || typeof childProps !== "object" || Array.isArray(childProps)) {
        errors.push({ field: name, message: `Field '${name}': object type requires a 'properties' (or 'fields') definition` });
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

  // Validate vocab_by shape + sibling-existence at every depth. Each level's
  // own field names are the sibling scope, so a vocab_by inside an array item
  // must reference another property of the same item.
  validateVocabTree(fields, errors, "");

  // Top-level `forms:` — deterministic form-table grammars (oss-367).
  if (doc.forms !== undefined) {
    if (!Array.isArray(doc.forms)) {
      errors.push({ message: "'forms' must be a list of form-table specs" });
    } else {
      (doc.forms as unknown[]).forEach((raw, i) => {
        const f = raw as Record<string, unknown>;
        const label = `forms[${i}]`;
        if (!f || typeof f !== "object") {
          errors.push({ message: `${label}: must be a mapping` });
          return;
        }
        for (const req of ["field", "anchor"]) {
          if (typeof f[req] !== "string" || !f[req]) {
            errors.push({ message: `${label}: '${req}' is required and must be a string` });
          }
        }
        const row = f.row as Record<string, unknown> | undefined;
        if (!row || typeof row !== "object" || typeof row.pattern !== "string" || !row.pattern) {
          errors.push({ message: `${label}: 'row.pattern' is required and must be a string` });
        } else {
          try {
            new RegExp(row.pattern as string, "g");
          } catch (e) {
            errors.push({ message: `${label}: 'row.pattern' is not a valid regex: ${e instanceof Error ? e.message : "parse error"}` });
          }
        }
        const target = typeof f.field === "string" ? (fields[f.field] as Record<string, unknown> | undefined) : undefined;
        if (typeof f.field === "string" && !target) {
          errors.push({ message: `${label}: field '${f.field}' is not declared in 'fields'` });
        } else if (target && target.type !== "array") {
          errors.push({ message: `${label}: field '${f.field}' must be an array field` });
        }
        if (f.set !== undefined && (typeof f.set !== "object" || Array.isArray(f.set))) {
          errors.push({ message: `${label}: 'set' must be a mapping of sub-field rules` });
        }
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, parsed: doc };
}

/**
 * Recursively validate every field's `vocab_by` / `vocab_default`, descending
 * into array-item properties and nested object properties. `siblings` for a
 * field are the other fields in its own scope (the same object/item), so a
 * typo'd sibling reference is caught at any depth.
 */
function validateVocabTree(
  fields: Record<string, unknown>,
  errors: Array<{ field?: string; message: string }>,
  pathPrefix: string,
): void {
  const scopeNames = new Set(Object.keys(fields));
  for (const [name, rawDef] of Object.entries(fields)) {
    if (!rawDef || typeof rawDef !== "object") continue;
    const def = rawDef as Record<string, unknown>;
    const label = pathPrefix ? `${pathPrefix}.${name}` : name;

    if (def.vocab_by !== undefined) {
      const ok = def.vocab_by && typeof def.vocab_by === "object" && !Array.isArray(def.vocab_by);
      if (!ok) {
        errors.push({ field: label, message: `Field '${label}': vocab_by must be a mapping of sibling field → value → vocabulary` });
      } else {
        for (const [sibling, cases] of Object.entries(def.vocab_by as Record<string, unknown>)) {
          if (!cases || typeof cases !== "object" || Array.isArray(cases)) {
            errors.push({ field: label, message: `Field '${label}': vocab_by.${sibling} must be a mapping of sibling value → vocabulary` });
            continue;
          }
          if (!scopeNames.has(sibling)) {
            errors.push({ field: label, message: `Field '${label}': vocab_by references sibling '${sibling}' which is not a field in the same scope` });
          }
          for (const [value, vocab] of Object.entries(cases as Record<string, unknown>)) {
            if (!isVocab(vocab)) {
              errors.push({ field: label, message: `Field '${label}': vocab_by.${sibling}.${value} must declare 'mappings', 'options', or 'values'` });
            }
          }
        }
      }
      if (def.vocab_default !== undefined && !isVocab(def.vocab_default)) {
        errors.push({ field: label, message: `Field '${label}': vocab_default must declare 'mappings', 'options', or 'values'` });
      }
    }

    const itemProps = arrayItemProperties(def);
    if (itemProps) validateVocabTree(itemProps, errors, label);
    const objProps = objectProperties(def);
    if (objProps) validateVocabTree(objProps, errors, label);
  }
}

/** True when a value looks like a vocabulary block (declares mappings/options/values). */
function isVocab(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const hasMappings = o.mappings && typeof o.mappings === "object" && !Array.isArray(o.mappings);
  const hasOptions = Array.isArray(o.options) || Array.isArray(o.values) || Array.isArray(o.enum);
  return Boolean(hasMappings || hasOptions);
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
