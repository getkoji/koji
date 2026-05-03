/**
 * Form-based extraction — takes coordinate extraction results and runs
 * them through the same normalize → validate → confidence pipeline
 * as LLM extraction.
 *
 * Coordinate results are treated as pre-extracted chunks: the text at
 * known positions is the initial extraction. The existing pipeline
 * handles normalization (dates, currency, etc.) and validation.
 *
 * For fields that fail normalization or are null despite being required,
 * an optional LLM pass can resolve them using the raw text as context.
 */

import { normalizeExtracted } from "./normalize";
import { validateExtracted } from "./validate";
import type { ProvenanceMap, BBox } from "./provenance";
import type { ExtractionResult } from "./pipeline";
import { validateField } from "./pipeline";

interface CoordinateResult {
  value: unknown;
  page?: number;
  bbox?: BBox;
  mapping_type?: string;
  value_type?: string;
  error?: string;
}

/**
 * Convert coordinate extraction results into the standard ExtractionResult
 * shape by running through normalize → validate → confidence.
 */
export function formExtractToResult(
  coordinateResults: Record<string, CoordinateResult>,
  schemaDef: Record<string, unknown>,
): ExtractionResult {
  const start = Date.now();
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const schemaName = (schemaDef.name as string) ?? "form";

  // Build the raw extracted values from coordinate results
  const rawExtracted: Record<string, unknown> = {};
  for (const [fieldName, result] of Object.entries(coordinateResults)) {
    rawExtracted[fieldName] = result.value;
  }

  // Run field validation (type coercion: string→number, string→date, etc.)
  const extracted: Record<string, unknown> = {};
  for (const [fieldName, spec] of Object.entries(fields)) {
    const rawValue = rawExtracted[fieldName] ?? null;
    const [validated] = validateField(fieldName, rawValue, spec);
    extracted[fieldName] = validated;
  }

  // Normalize (schema-level transforms like iso8601, mappings, etc.)
  const [normalized, normReport] = normalizeExtracted(extracted, schemaDef);

  // Validate (schema-level validation rules)
  const validationReport = validateExtracted(normalized, schemaDef);

  // Build provenance from coordinate positions
  const provenance: ProvenanceMap = {};
  for (const [fieldName, result] of Object.entries(coordinateResults)) {
    if (result.value != null && result.page) {
      provenance[fieldName] = {
        offset: -1, // No markdown offset — extracted from coordinates
        length: 0,
        chunk: typeof result.value === "string" ? result.value : String(result.value),
        page: result.page,
        bbox: result.bbox,
      };
    } else {
      provenance[fieldName] = null;
    }
  }

  // Build confidence scores
  // Coordinate extraction gets high base confidence (direct read from PDF)
  const confidence: Record<string, string> = {};
  const confidenceScores: Record<string, number> = {};

  const failedFields = new Set(
    (validationReport.issues ?? []).filter((i) => i.field).map((i) => i.field!),
  );

  for (const fieldName of Object.keys(fields)) {
    const value = normalized[fieldName];
    const coordResult = coordinateResults[fieldName];

    if (value == null) {
      confidenceScores[fieldName] = 0;
      confidence[fieldName] = "not_found";
    } else if (coordResult?.error) {
      confidenceScores[fieldName] = 0.3;
      confidence[fieldName] = "low";
    } else if (failedFields.has(fieldName)) {
      confidenceScores[fieldName] = 0.5;
      confidence[fieldName] = "medium";
    } else {
      // Direct coordinate read — high confidence
      confidenceScores[fieldName] = 0.98;
      confidence[fieldName] = "high";
    }
  }

  return {
    model: "coordinates",
    strategy: "form-mapping",
    schema: schemaName,
    elapsed_ms: Date.now() - start,
    extracted: normalized,
    confidence,
    confidence_scores: confidenceScores,
    normalization: {
      applied: normReport.applied,
      warnings: normReport.warnings,
    },
    validation: {
      ok: validationReport.ok,
      issues: validationReport.issues,
    },
    provenance,
  };
}

/**
 * Identify fields that need LLM interpretation —
 * null required fields, failed validations, or fields with errors.
 */
export function fieldsNeedingLlm(
  result: ExtractionResult,
  schemaDef: Record<string, unknown>,
): string[] {
  const fields = (schemaDef.fields ?? {}) as Record<string, Record<string, unknown>>;
  const needsLlm: string[] = [];

  for (const [fieldName, spec] of Object.entries(fields)) {
    const value = result.extracted[fieldName];
    const score = result.confidence_scores[fieldName] ?? 0;

    // Required field is null
    if (value == null && spec.required) {
      needsLlm.push(fieldName);
      continue;
    }

    // Low confidence
    if (score < 0.5 && value != null) {
      needsLlm.push(fieldName);
    }
  }

  return needsLlm;
}
