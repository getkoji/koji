/**
 * Group extraction — Phase 3 of the intelligent extraction pipeline.
 *
 * Builds focused extraction prompts for groups of co-located fields,
 * calls the LLM, parses JSON responses, and handles error recovery.
 *
 * TypeScript port of services/extract/pipeline.py:
 *   _describe_array_item, _describe_property, _collect_extraction_notes,
 *   _render_context_chunks, build_group_prompt, build_gap_fill_prompt,
 *   extract_group, fill_gap, _unwrap_nested_result,
 *   _extract_llm_confidence, _extract_source_texts.
 */

import type { Chunk } from "./document-map";
import type { RouteGroup } from "./router";
import type { ModelProvider } from "./providers";

// ---------------------------------------------------------------------------
// Shape rendering — recursive array/object description for prompts
// ---------------------------------------------------------------------------

/**
 * Render the shape of an array's items for the prompt.
 * Recurses into nested arrays and objects so the LLM sees the full shape.
 */
export function describeArrayItem(spec: Record<string, unknown>): string {
  const itemSpec = spec.items;
  if (!itemSpec || typeof itemSpec !== "object") return "";
  const item = itemSpec as Record<string, unknown>;

  const itemType = item.type as string | undefined;
  if (itemType === "object") {
    const properties = item.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) return " of objects";
    const parts: string[] = [];
    for (const [propName, propSpec] of Object.entries(properties)) {
      parts.push(describeProperty(propName, propSpec));
    }
    parts.push(
      "__source_text: string \u2014 copy the EXACT verbatim text from the document that this item was extracted from",
    );
    return ` of objects with properties {${parts.join(", ")}}`;
  }

  if (itemType === "array") {
    return " of arrays" + describeArrayItem(item);
  }

  if (itemType) return ` of ${itemType}`;
  return "";
}

/**
 * Render a single property name + type for use inside a nested object description.
 * Walks into nested arrays/objects via describeArrayItem.
 */
export function describeProperty(propName: string, propSpec: unknown): string {
  if (!propSpec || typeof propSpec !== "object") return `${propName}: string`;
  const s = propSpec as Record<string, unknown>;
  const propType = (s.type as string) ?? "string";
  if (propType === "array") {
    return `${propName}: array${describeArrayItem(s)}`;
  }
  if (propType === "object") {
    const nestedProps = s.properties as Record<string, unknown> | undefined;
    if (!nestedProps || Object.keys(nestedProps).length === 0) {
      return `${propName}: object`;
    }
    const nestedParts = Object.entries(nestedProps).map(([n, sp]) => describeProperty(n, sp));
    return `${propName}: object with properties {${nestedParts.join(", ")}}`;
  }
  return `${propName}: ${propType}`;
}

// ---------------------------------------------------------------------------
// Extraction notes
// ---------------------------------------------------------------------------

/**
 * Render per-field extraction_hint strings into a notes block.
 * Returns empty string if no field has a hint.
 */
export function collectExtractionNotes(
  fields: Record<string, Record<string, unknown>>,
): string {
  const notes: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const hint = typeof spec === "object" ? (spec.extraction_hint as string) : undefined;
    if (typeof hint === "string" && hint.trim()) {
      notes.push(`- **${name}**: ${hint.trim()}`);
    }
  }
  return notes.join("\n");
}

// ---------------------------------------------------------------------------
// Context chunks
// ---------------------------------------------------------------------------

/**
 * Render a `## Document context` section for non-routed context chunks.
 * Chunks already in the routed set (by index) are skipped.
 */
export function renderContextChunks(
  contextChunks: Chunk[] | null | undefined,
  routedChunks: Chunk[],
): string {
  if (!contextChunks || contextChunks.length === 0) return "";
  const routedIds = new Set(routedChunks.map((c) => c.index));
  const fresh = contextChunks.filter((c) => !routedIds.has(c.index));
  if (fresh.length === 0) return "";
  const blocks = fresh.map((c) => `### ${c.title}\n\n${c.content}`);
  const joined = blocks.join("\n\n---\n\n");
  return `\n## Document context\n\n${joined}\n`;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build a focused extraction prompt for a group of fields from specific chunks.
 * Faithful port of Python build_group_prompt.
 */
export function buildGroupPrompt(
  group: RouteGroup,
  schemaName: string,
  contextChunks?: Chunk[] | null,
  schemaConfig?: Record<string, unknown> | null,
): string {
  const fields = group.fieldSpecs;
  const chunks = group.chunks;

  const fieldDescriptions: string[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const fieldType = (spec.type as string) ?? "string";
    const required = Boolean(spec.required);
    const description = (spec.description as string) ?? "";
    const reqLabel = required ? " (REQUIRED)" : "";
    let descLabel = description ? ` \u2014 ${description}` : "";

    let typeLabel = fieldType;
    if (fieldType === "array") {
      typeLabel = "array" + describeArrayItem(spec);
    }

    const mappings = spec.mappings as Record<string, unknown[]> | undefined;
    const options = (spec.options ?? spec.enum) as unknown[] | undefined;

    if (mappings && typeof mappings === "object" && Object.keys(mappings).length > 0) {
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
  const notesBlock = collectExtractionNotes(fields);

  // Collect exclude_contains patterns from all fields in this group
  const excludePatterns: string[] = [];
  for (const spec of Object.values(fields)) {
    const hints = spec.hints as Record<string, unknown> | undefined;
    const excludeContains = (hints?.exclude_contains ?? []) as unknown[];
    for (const phrase of excludeContains) {
      if (typeof phrase === "string" && phrase.trim()) {
        excludePatterns.push(phrase.trim().toLowerCase());
      }
    }
  }

  // Combine chunk content
  const contentBlocks: string[] = [];
  for (const chunk of chunks) {
    let chunkText = chunk.content;
    if (excludePatterns.length > 0) {
      const filteredLines: string[] = [];
      for (const line of chunkText.split("\n")) {
        const lineLower = line.toLowerCase();
        if (excludePatterns.some((pat) => lineLower.includes(pat))) continue;
        filteredLines.push(line);
      }
      chunkText = filteredLines.join("\n");
    }
    contentBlocks.push(`### ${chunk.title}\n\n${chunkText}`);
  }
  const content = contentBlocks.join("\n\n---\n\n");

  const notesSection = notesBlock ? `\n## Extraction notes\n\n${notesBlock}\n` : "";
  const contextSection = renderContextChunks(contextChunks, chunks);

  const cfg = schemaConfig ?? {};
  const extraInstructions: string[] = [];

  // Locale: unified block or legacy standalone keys
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
  if (dateLocale) {
    dateInstruction = `Dates as YYYY-MM-DD (input uses ${dateLocale}).`;
  }
  let extraBlock = extraInstructions.join("\n");
  if (extraBlock) {
    extraBlock = "\n\n" + extraBlock;
  }

  return `Extract the following fields from the document sections below. Return ONLY valid JSON with the fields you find. If a field is not present, use null.

## Fields to extract

${fieldsBlock}
${notesSection}${contextSection}
## Document sections

${content}

## Instructions

Return a FLAT JSON object with the listed field NAMES as top-level keys \u2014 do NOT nest the result under a schema name or a wrapper object. Example: return \`{"field_a": ..., "field_b": ...}\`, not \`{"${schemaName}": {"field_a": ..., "field_b": ...}}\`. ${dateInstruction} Numbers as numbers (not strings). For enum/pick fields, choose the closest match from the allowed values. Do not invent data \u2014 only extract what is explicitly in the text. For each object in an array field, include a "__source_text" property with the EXACT verbatim text from the document where you found that item. Copy 1-3 consecutive lines exactly as they appear \u2014 do not paraphrase or reformat.${extraBlock}

JSON:`;
}

/**
 * Build a targeted prompt to find a single missing field across broadened chunks.
 * Faithful port of Python build_gap_fill_prompt.
 */
export function buildGapFillPrompt(
  fieldName: string,
  fieldSpec: Record<string, unknown>,
  chunks: Chunk[],
  schemaName: string,
  contextChunks?: Chunk[] | null,
): string {
  const fieldType = (fieldSpec.type as string) ?? "string";
  const required = Boolean(fieldSpec.required);
  const description = (fieldSpec.description as string) ?? "";
  const reqLabel = required ? " (REQUIRED)" : "";
  let descLabel = description ? ` \u2014 ${description}` : "";

  let typeLabel = fieldType;
  if (fieldType === "array") {
    typeLabel = "array" + describeArrayItem(fieldSpec);
  }

  const mappings = fieldSpec.mappings as Record<string, unknown[]> | undefined;
  const options = (fieldSpec.options ?? fieldSpec.enum) as unknown[] | undefined;

  if (mappings && typeof mappings === "object" && Object.keys(mappings).length > 0) {
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

  const fieldLine = `  - ${fieldName}: ${typeLabel}${reqLabel}${descLabel}`;

  const hint = typeof fieldSpec === "object" ? (fieldSpec.extraction_hint as string) : undefined;
  let notesSection = "";
  if (typeof hint === "string" && hint.trim()) {
    notesSection = `\n## Extraction notes\n\n- **${fieldName}**: ${hint.trim()}\n`;
  }

  const contentBlocks = chunks.map((c) => `### ${c.title}\n\n${c.content}`);
  const content = contentBlocks.join("\n\n---\n\n");

  const contextSection = renderContextChunks(contextChunks, chunks);

  return `The field below was not found in an earlier extraction pass. Search thoroughly in ALL sections below and extract it if present. Return ONLY valid JSON. If the field is truly not present, return {"${fieldName}": null}.

## Missing field to find

${fieldLine}
${notesSection}${contextSection}
## Document sections (broadened search)

${content}

## Instructions

Look carefully through every section. The value may be embedded in prose, tables, or key-value pairs. Return a FLAT JSON object with ONLY the single field \u2014 do NOT nest the result under a schema name or a wrapper object. Example: return \`{"${fieldName}": ...}\`, not \`{"${schemaName}": {"${fieldName}": ...}}\`. Dates as YYYY-MM-DD. Numbers as numbers (not strings). Do not invent data.

JSON:`;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a result the LLM wrapped under a single non-field key.
 * Port of Python _unwrap_nested_result.
 */
export function unwrapNestedResult(
  result: Record<string, unknown>,
  expectedFields: Set<string>,
): Record<string, unknown> {
  if (!result || typeof result !== "object" || Object.keys(result).length === 0 || expectedFields.size === 0) {
    return result;
  }
  // If any expected field is already top-level, it's already flat
  for (const f of expectedFields) {
    if (f in result) return result;
  }
  // Look for exactly one nested dict whose keys overlap with expected
  const candidates = Object.values(result).filter(
    (v): v is Record<string, unknown> =>
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v as Record<string, unknown>).some((k) => expectedFields.has(k)),
  );
  if (candidates.length === 1) return candidates[0]!;
  return result;
}

/**
 * Pop __confidence from a parsed LLM response and return per-field scores.
 * Returns a dict mapping field names to floats in [0.0, 1.0].
 * Port of Python _extract_llm_confidence.
 */
export function extractLlmConfidence(
  parsed: Record<string, unknown>,
  expectedFields: Set<string>,
): Record<string, number> {
  const raw = parsed.__confidence;
  delete parsed.__confidence;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (key in Object.fromEntries([...expectedFields].map((f) => [f, true])) === false) continue;
    if (!expectedFields.has(key)) continue;
    if (typeof val === "number") {
      result[key] = Math.max(0.0, Math.min(1.0, val));
    }
  }
  return result;
}

/**
 * Extract and strip __source_text from array-of-objects items.
 * Returns a map of field name -> source texts (one per array item).
 * Mutates `parsed` by deleting __source_text from each item.
 * Port of Python _extract_source_texts.
 */
export function extractSourceTexts(
  parsed: Record<string, unknown>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const texts: string[] = [];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const src = obj.__source_text;
        delete obj.__source_text;
        texts.push(typeof src === "string" ? src : "");
      } else {
        texts.push("");
      }
    }
    if (texts.some((t) => t.length > 0)) {
      result[field] = texts;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSON parsing with fallback
// ---------------------------------------------------------------------------

function parseJsonResponse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
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

// ---------------------------------------------------------------------------
// Extraction functions
// ---------------------------------------------------------------------------

/**
 * Extract fields from a group of co-located fields.
 * Port of Python extract_group (without semaphore — caller handles concurrency).
 */
export async function extractGroup(
  group: RouteGroup,
  schemaName: string,
  provider: ModelProvider,
  contextChunks?: Chunk[] | null,
  schemaConfig?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const prompt = buildGroupPrompt(group, schemaName, contextChunks, schemaConfig);
  const expectedFields = new Set(Object.keys(group.fieldSpecs ?? {}));

  try {
    const raw = await provider.generate(prompt, true);

    const parsed = parseJsonResponse(raw);
    if (!parsed) {
      console.log(`[koji-extract] Group ${JSON.stringify(group.fields)} returned invalid JSON, raw=${raw.slice(0, 200)}`);
      return {};
    }

    const llmConf = extractLlmConfidence(parsed, expectedFields);
    // Strip __source_text from array items and collect them
    const sourceTexts = extractSourceTexts(parsed);
    const result = unwrapNestedResult(parsed, expectedFields);
    if (Object.keys(llmConf).length > 0) {
      result.__llm_confidence = llmConf;
    }
    if (Object.keys(sourceTexts).length > 0) {
      result.__source_texts = sourceTexts;
    }

    // Log fields that came back null
    const nullFields = [...expectedFields].filter((f) => result[f] == null);
    if (nullFields.length > 0) {
      console.log(`[koji-extract] Group ${JSON.stringify(group.fields)} returned null for: ${JSON.stringify(nullFields)}`);
    }

    return result;
  } catch (e) {
    console.log(`[koji-extract] Group ${JSON.stringify(group.fields)} error: ${e}`);
    return {};
  }
}

/**
 * Attempt to extract a single missing field from broadened chunks.
 * Port of Python fill_gap (without semaphore — caller handles concurrency).
 */
export async function fillGap(
  fieldName: string,
  fieldSpec: Record<string, unknown>,
  chunks: Chunk[],
  schemaName: string,
  provider: ModelProvider,
  contextChunks?: Chunk[] | null,
): Promise<Record<string, unknown>> {
  const prompt = buildGapFillPrompt(fieldName, fieldSpec, chunks, schemaName, contextChunks);

  try {
    const raw = await provider.generate(prompt, true);

    const parsed = parseJsonResponse(raw);
    if (!parsed) {
      console.log(`[koji-extract] Gap fill for ${fieldName} returned invalid JSON`);
      return {};
    }

    const llmConf = extractLlmConfidence(parsed, new Set([fieldName]));
    const result = unwrapNestedResult(parsed, new Set([fieldName]));
    if (Object.keys(llmConf).length > 0) {
      result.__llm_confidence = llmConf;
    }
    return result;
  } catch (e) {
    console.log(`[koji-extract] Gap fill for ${fieldName} error: ${e}`);
    return {};
  }
}
