/**
 * Extraction pipeline — TypeScript port of services/extract/pipeline.py.
 *
 * Builds a prompt from schema fields + document markdown, calls the LLM
 * with JSON mode, parses the response into field values with confidence
 * scores, then applies normalization and validation.
 *
 * This is a streamlined single-pass extraction (no document map / routing /
 * gap-fill) that matches the Python pipeline's prompt format and response
 * shape. The full intelligent pipeline (chunking, routing, multi-group)
 * stays in Python until it is fully ported.
 */

import type { ModelProvider } from "./providers";
import { normalizeExtracted } from "./normalize";
import { validateExtracted } from "./validate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  model: string;
  strategy: string;
  schema: string;
  elapsed_ms: number;
  extracted: Record<string, unknown>;
  confidence: Record<string, string>;
  confidence_scores: Record<string, number>;
  normalization?: {
    applied: Array<{ field: string; transform: string }>;
    warnings: string[];
  };
  validation?: {
    ok: boolean;
    issues: Array<{ rule: string; field: string | null; message: string }>;
  };
  /** All key-value pairs found in the document via pattern matching (no LLM). */
  kv_pairs?: Array<{ label: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Prompt building — matches Python build_group_prompt format
// ---------------------------------------------------------------------------

function describeArrayItem(spec: Record<string, unknown>): string {
  const itemSpec = spec.items as Record<string, unknown> | undefined;
  if (!itemSpec || typeof itemSpec !== "object") return "";

  const itemType = itemSpec.type as string | undefined;
  if (itemType === "object") {
    const properties = itemSpec.properties as Record<string, unknown> | undefined;
    if (!properties) return " of objects";
    const parts = Object.entries(properties).map(([n, s]) => describeProperty(n, s));
    return ` of objects with properties {${parts.join(", ")}}`;
  }
  if (itemType === "array") return " of arrays" + describeArrayItem(itemSpec);
  if (itemType) return ` of ${itemType}`;
  return "";
}

function describeProperty(name: string, spec: unknown): string {
  if (!spec || typeof spec !== "object") return `${name}: string`;
  const s = spec as Record<string, unknown>;
  const t = (s.type as string) ?? "string";
  if (t === "array") return `${name}: array${describeArrayItem(s)}`;
  if (t === "object") {
    const nested = s.properties as Record<string, unknown> | undefined;
    if (!nested) return `${name}: object`;
    const parts = Object.entries(nested).map(([n, sp]) => describeProperty(n, sp));
    return `${name}: object with properties {${parts.join(", ")}}`;
  }
  return `${name}: ${t}`;
}

function buildPrompt(
  markdown: string,
  schemaDef: Record<string, unknown>,
): string {
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const schemaName = (schemaDef.name as string) ?? "document";

  const fieldDescriptions: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!spec || typeof spec !== "object") continue;
    const fieldType = (spec.type as string) ?? "string";
    const required = Boolean(spec.required);
    const description = (spec.description as string) ?? "";
    const reqLabel = required ? " (REQUIRED)" : "";
    let descLabel = description ? ` \u2014 ${description}` : "";

    let typeLabel = fieldType;
    if (fieldType === "array") typeLabel = "array" + describeArrayItem(spec);

    const mappings = spec.mappings as Record<string, unknown[]> | undefined;
    const options = (spec.options ?? spec.enum) as unknown[] | undefined;

    if (mappings && typeof mappings === "object") {
      const parts: string[] = [];
      for (const [canonical, aliases] of Object.entries(mappings)) {
        const aliasList = (aliases as unknown[])
          .filter((a) => String(a) !== String(canonical))
          .map(String)
          .join(", ");
        parts.push(aliasList ? `${canonical} (${aliasList})` : String(canonical));
      }
      descLabel += ` [pick from: ${parts.join(", ")}]`;
    } else if (Array.isArray(options) && options.length > 0) {
      descLabel += ` [pick from: ${options.map(String).join(", ")}]`;
    }

    fieldDescriptions.push(`  - ${name}: ${typeLabel}${reqLabel}${descLabel}`);
  }

  const fieldsBlock = fieldDescriptions.join("\n");

  // Extraction notes (hints)
  const noteLines: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hint = typeof spec === "object" ? (spec as any)?.extraction_hint : undefined;
    if (typeof hint === "string" && hint.trim()) {
      noteLines.push(`- **${name}**: ${hint.trim()}`);
    }
  }
  const notesSection = noteLines.length > 0
    ? `\n## Extraction notes\n\n${noteLines.join("\n")}\n`
    : "";

  // Schema config extras
  const cfg = schemaDef as Record<string, unknown>;
  const extraInstructions: string[] = [];

  const locale = (cfg.locale ?? {}) as Record<string, unknown>;
  const localeFallback = (locale.fallback ?? {}) as Record<string, string>;
  const dateLocale = localeFallback.date_format ?? (cfg.date_locale as string);
  const defaultCurrency = localeFallback.currency ?? (cfg.default_currency as string);

  if (dateLocale) {
    extraInstructions.push(
      `Dates in this document use ${dateLocale} format. ` +
      `When you encounter an ambiguous date like 04/06/2018, ` +
      `interpret it according to ${dateLocale} ordering. ` +
      `Output all dates as YYYY-MM-DD regardless of input format.`,
    );
  }
  if (defaultCurrency) {
    extraInstructions.push(`When no explicit currency code is present, assume ${defaultCurrency}.`);
  }
  if (cfg.blank_form_aware) {
    extraInstructions.push(
      "If this document appears to be a BLANK unfilled form with placeholder text " +
      "(underscores, empty brackets, 'MM/DD/YYYY' placeholders, '___________'), " +
      "return null for ALL fields. Do not extract from form labels or instructions \u2014 " +
      "only extract actual filled-in data.",
    );
  }

  let dateInstruction = "Dates as YYYY-MM-DD.";
  if (dateLocale) dateInstruction = `Dates as YYYY-MM-DD (input uses ${dateLocale}).`;
  const extraBlock = extraInstructions.length > 0 ? "\n\n" + extraInstructions.join("\n") : "";

  return `Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract

${fieldsBlock}
${notesSection}
## Document sections

${markdown}

## Instructions

Return a FLAT JSON object with the listed field NAMES as top-level keys \u2014 do NOT nest the result under a schema name or a wrapper object. Example: return \`{"field_a": ..., "field_b": ...}\`, not \`{"${schemaName}": {"field_a": ..., "field_b": ...}}\`. ${dateInstruction} Numbers as numbers (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data \u2014 only extract what is explicitly in the text.${extraBlock}

JSON:`;
}

// ---------------------------------------------------------------------------
// JSON parsing with fallback
// ---------------------------------------------------------------------------

function parseJsonResponse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract JSON object from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Unwrap a result the LLM wrapped under a single non-field key.
 * See Python _unwrap_nested_result for rationale.
 */
function unwrapNestedResult(
  result: Record<string, unknown>,
  expectedFields: Set<string>,
): Record<string, unknown> {
  if (!result || expectedFields.size === 0) return result;
  // If any expected field is already top-level, it's already flat
  for (const f of expectedFields) {
    if (f in result) return result;
  }
  // Look for exactly one nested dict whose keys overlap with expected
  const candidates = Object.values(result).filter(
    (v): v is Record<string, unknown> =>
      v != null && typeof v === "object" && !Array.isArray(v) &&
      Object.keys(v).some((k) => expectedFields.has(k)),
  );
  if (candidates.length === 1) return candidates[0];
  return result;
}

// ---------------------------------------------------------------------------
// Confidence scoring — matches Python pipeline.reconcile
// ---------------------------------------------------------------------------

const ROUTE_SOURCE_WEIGHTS: Record<string, number> = {
  hint: 0.5,
  signal_inferred: 0.35,
  broadened: 0.15,
  fallback: 0.1,
};

function computeConfidenceScore(opts: {
  routeSource?: string;
  multiSourceAgree?: boolean;
  singleSource?: boolean;
  validationPassed?: boolean;
  hasRelevantSignals?: boolean;
}): number {
  let score = 0;
  if (opts.routeSource) score += ROUTE_SOURCE_WEIGHTS[opts.routeSource] ?? 0;
  if (opts.multiSourceAgree) score += 0.2;
  else if (opts.singleSource) score += 0.15;
  if (opts.validationPassed) score += 0.2;
  if (opts.hasRelevantSignals) score += 0.1;
  return Math.min(score, 1.0);
}

function scoreLabel(score: number): string {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  if (score > 0) return "low";
  return "not_found";
}

function buildConfidence(
  extracted: Record<string, unknown>,
  fields: Record<string, Record<string, unknown>>,
): { confidence: Record<string, string>; confidence_scores: Record<string, number> } {
  const confidence: Record<string, string> = {};
  const confidenceScores: Record<string, number> = {};

  for (const fieldName of Object.keys(fields)) {
    const value = extracted[fieldName];
    if (value == null) {
      confidence[fieldName] = "not_found";
      confidenceScores[fieldName] = 0;
      continue;
    }
    // Single-pass extraction: treat as hint-routed, single-source,
    // validation-passed for scoring parity with Python.
    const score = computeConfidenceScore({
      routeSource: "hint",
      singleSource: true,
      validationPassed: true,
      hasRelevantSignals: false,
    });
    confidenceScores[fieldName] = score;
    confidence[fieldName] = scoreLabel(score);
  }

  return { confidence, confidence_scores: confidenceScores };
}

// ---------------------------------------------------------------------------
// Validate field (matches Python pipeline.validate_field)
// ---------------------------------------------------------------------------

function validateField(
  name: string,
  value: unknown,
  spec: Record<string, unknown>,
): [unknown, boolean, string | null] {
  if (value == null) {
    if (spec.required) return [null, false, "required field is null"];
    return [null, true, null];
  }

  const fieldType = (spec.type as string) ?? "string";
  let issues: string | null = null;
  let result = value;

  if (fieldType === "date" && typeof result === "string") {
    const dateMatch = result.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dateMatch) {
      result = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    } else {
      issues = `could not parse date: ${result}`;
    }
  } else if (fieldType === "number") {
    if (typeof result === "string") {
      const cleaned = result.replace(/[$,]/g, "").trim();
      const num = parseFloat(cleaned);
      if (isNaN(num)) {
        issues = `could not parse number: ${result}`;
      } else {
        result = num === Math.floor(num) ? Math.floor(num) : num;
      }
    }
  } else if (fieldType === "enum") {
    const options = (spec.options ?? []) as unknown[];
    if (options.length > 0 && !options.includes(result)) {
      const valueLower = String(result).toLowerCase();
      let matched = false;
      for (const opt of options) {
        const optLower = String(opt).toLowerCase();
        if (optLower === valueLower || optLower.includes(valueLower) || valueLower.includes(optLower)) {
          result = opt;
          matched = true;
          break;
        }
      }
      if (!matched) issues = `value '${result}' not in allowed options`;
    }
  } else if (fieldType === "mapping") {
    const mappings = (spec.mappings ?? {}) as Record<string, unknown[]>;
    if (Object.keys(mappings).length > 0) {
      const valueStr = String(result);
      const valueLower = valueStr.toLowerCase();
      if (valueStr in mappings) {
        result = valueStr;
      } else {
        let matched = false;
        for (const [canonical, aliases] of Object.entries(mappings)) {
          if (valueLower === canonical.toLowerCase()) {
            result = canonical;
            matched = true;
            break;
          }
          for (const alias of aliases) {
            if (valueLower === String(alias).toLowerCase()) {
              result = canonical;
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (!matched) {
          for (const [canonical, aliases] of Object.entries(mappings)) {
            for (const alias of aliases) {
              const aliasLower = String(alias).toLowerCase();
              if (aliasLower.includes(valueLower) || valueLower.includes(aliasLower)) {
                result = canonical;
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (!matched) issues = `value '${result}' not in allowed mappings`;
        }
      }
    }
  }

  return [result, issues == null, issues];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract fields from markdown using the given schema and LLM provider.
 *
 * Builds a prompt, calls the provider, parses the JSON response, runs
 * field validation, normalization, and schema validation.
 *
 * Returns the same response shape as the Python extract service.
 */
export async function extractFields(
  markdown: string,
  schemaDef: Record<string, unknown>,
  provider: ModelProvider,
  model: string,
): Promise<ExtractionResult> {
  const start = Date.now();
  const schemaName = (schemaDef.name as string) ?? "unknown";

  // Extract KV pairs only if schema opts in
  const includeKVPairs = Boolean(schemaDef.include_kv_pairs);
  let kvPairs: Array<{ label: string; value: string }> = [];
  if (includeKVPairs) {
    const { extractKVPairs } = await import("./kv-pairs");
    kvPairs = extractKVPairs(markdown).map(({ label, value }) => ({ label, value }));
  }
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const fieldNames = new Set(Object.keys(fields));

  console.log(
    `[koji-extract] Request: model=${JSON.stringify(model)}, strategy=intelligent, ` +
    `markdown=${markdown.length} chars, fields=${JSON.stringify([...fieldNames])}`,
  );

  // Build prompt and call LLM
  const prompt = buildPrompt(markdown, schemaDef);
  const raw = await provider.generate(prompt, true);

  // Parse response
  let parsed = parseJsonResponse(raw);
  if (!parsed) {
    console.log("[koji-extract] LLM returned invalid JSON");
    return {
      model,
      strategy: "intelligent",
      schema: schemaName,
      elapsed_ms: Date.now() - start,
      extracted: Object.fromEntries([...fieldNames].map((f) => [f, null])),
      confidence: Object.fromEntries([...fieldNames].map((f) => [f, "not_found"])),
      confidence_scores: Object.fromEntries([...fieldNames].map((f) => [f, 0])),
      ...(includeKVPairs ? { kv_pairs: kvPairs } : {}),
    };
  }

  // Unwrap nested results
  parsed = unwrapNestedResult(parsed, fieldNames);

  // Field validation + type normalization
  const extracted: Record<string, unknown> = {};
  for (const [fieldName, spec] of Object.entries(fields)) {
    const rawValue = parsed[fieldName] ?? null;
    const [validated] = validateField(fieldName, rawValue, spec);
    extracted[fieldName] = validated;
  }

  // Confidence scoring
  const { confidence, confidence_scores } = buildConfidence(extracted, fields);

  // Post-extraction normalization
  const [normalized, normReport] = normalizeExtracted(extracted, schemaDef);

  // Post-extraction validation
  const validationReport = validateExtracted(normalized, schemaDef);

  const elapsedMs = Date.now() - start;
  console.log(`[koji-extract] Extracted ${Object.keys(normalized).length} fields in ${elapsedMs}ms`);

  return {
    model,
    strategy: "intelligent",
    schema: schemaName,
    elapsed_ms: elapsedMs,
    extracted: normalized,
    confidence,
    confidence_scores,
    normalization: {
      applied: normReport.applied,
      warnings: normReport.warnings,
    },
    validation: {
      ok: validationReport.ok,
      issues: validationReport.issues,
    },
    kv_pairs: kvPairs.map(({ label, value }) => ({ label, value })),
  };
}
