/**
 * Agent prompt builder — constructs prompts for the schema-building agent.
 *
 * The agent helps users create and refine YAML extraction schemas by
 * analyzing documents and responding to natural language instructions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DocumentContext {
  markdown_head: string;
  kv_pairs: Array<{ label: string; value: string }>;
  doc_type?: string;
}

// ---------------------------------------------------------------------------
// Schema spec reference (compact, ~400 tokens)
// ---------------------------------------------------------------------------

const SCHEMA_SPEC = `## Koji Schema YAML Spec

Top-level keys: name (required), description, fields (required)

### Field properties:
- type: string | number | date | boolean | enum | array | object (required)
- required: true/false
- nullable: true/false
- description: human-readable description
- extraction_guidance: hint for the LLM extractor
- normalize: trim | lowercase | uppercase | title_case | slugify | collapse_spaces | remove_spaces | fix_punctuation_spacing | prose | iso8601 | minor_units | integer | decimal_amount | percent | digits_only | boolean | email | url | e164
- validate:
    regex: pattern
    min / max: numeric bounds
    min_length / max_length: string length bounds
    one_of: [list of valid values]
    on_fail: "null" | "flag" (default: flag)

### Type-specific requirements:
- enum: must include "values: [opt1, opt2, ...]"
- array: must include "items:" with a type definition
- object: must include "fields:" with nested field definitions

### Example:
\`\`\`yaml
name: invoice
description: Invoice extraction
fields:
  invoice_number:
    type: string
    required: true
  total:
    type: number
    validate:
      min: 0
  status:
    type: enum
    values: [paid, unpaid, partial]
  line_items:
    type: array
    items:
      type: object
      fields:
        description:
          type: string
        amount:
          type: number
\`\`\``;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Koji Schema Builder, an AI assistant that helps users create YAML extraction schemas for document processing.

You analyze documents and propose or refine YAML schemas. Your responses must include:

1. The complete updated YAML inside a <yaml> block (always return the FULL schema, not a diff)
2. A brief explanation (1-3 sentences) inside an <explanation> block
3. On first interaction when classifying a document, also return the doc type inside a <doc_type> block

${SCHEMA_SPEC}

RULES:
- Only use types and properties listed in the spec above. Do not invent new types or properties.
- Keep schemas concise — 5-15 fields for most documents.
- Field names should be snake_case.
- Only add fields the user explicitly requests or that are clearly present in the document.
- When modifying a schema, preserve all existing fields unless the user asks to remove them.
- Always return COMPLETE YAML in the <yaml> block, never partial or diff.

RESPONSE FORMAT (required):
<yaml>
name: ...
description: ...
fields:
  ...
</yaml>
<explanation>Brief description of what changed and why.</explanation>`;

// ---------------------------------------------------------------------------
// Tune prompt (score-aware) — the schema-tuning loop's proposal step
// ---------------------------------------------------------------------------

/** One field's measured failure, fed to the tuner so it edits with evidence. */
export interface TuneFieldReport {
  name: string;
  /** Ground-truth value (stringified for the prompt). */
  expected: string;
  /** What the current schema extracted (stringified; "(nothing)" when absent). */
  got: string;
  /**
   * Plain-language routing diagnosis. `answerInRoutedChunks: false` ⇒ the model
   * never saw the answer (fix which sections/hints route to this field);
   * `true` ⇒ it saw the text but chose wrong (fix the field description/prompt);
   * `null` ⇒ undeterminable.
   */
  routingHint: string;
}

export interface TuneContext {
  /** Overall accuracy on this exemplar before the edit (0–100). */
  accuracy: number;
  /** The fields that failed, worst first. */
  failing: TuneFieldReport[];
  /** Document excerpt for grounding (first ~2000 chars). */
  markdown_head: string;
  doc_type?: string;
  /** Summaries of edits already tried and rejected — do NOT repeat these. */
  rejected?: string[];
}

const TUNE_SYSTEM_PROMPT = `You are Koji Schema Tuner. You are given an extraction schema, one document, and a MEASURED report of how the current schema scored against known-correct ground truth on that document. Your job is to propose a minimal edit to the schema YAML that fixes the failing fields.

${SCHEMA_SPEC}

HOW TO REASON ABOUT EACH FAILURE:
- "model never saw the answer" → the correct text was not in the chunks routed to this field. Give the field a clearer \`extraction_guidance\` describing where the value lives / what it looks like so the extractor finds it. Do NOT just reword the description.
- "model saw the text but chose the wrong value" → the model misread intent. Sharpen the \`description\` or add a disambiguating \`extraction_guidance\` (e.g. "the grand total, not the subtotal") so the correct value is unambiguous.
- "could not determine" → use your judgment from the document excerpt.

RULES:
- Make the SMALLEST change that fixes the failing fields. Do not rewrite unrelated fields.
- Preserve every existing field and passing behavior unless a change is required to fix a failure.
- Only use properties defined in the spec above (e.g. \`extraction_guidance\` for a per-field hint). Do NOT invent properties.
- Always return the COMPLETE updated YAML, never a diff.

RESPONSE FORMAT (required):
<thinking>
Think out loud, briefly: which failing field you're tackling, what the document shows for it, why it's failing (routing vs. wording), and the specific change you'll make. A few sentences — this is shown to the user as you work.
</thinking>
<yaml>
name: ...
fields:
  ...
</yaml>
<explanation>1-3 sentences: which fields you changed and why (reference the diagnosis).</explanation>`;

/**
 * Build the score-aware tuning prompt: current schema + a measured failure
 * report (expected vs got + routing diagnosis per failing field) + a document
 * excerpt. This is what distinguishes the tuner from the free-form builder —
 * it edits against evidence, not a chat message.
 */
export function buildTunePrompt(currentYaml: string, ctx: TuneContext): string {
  const failingBlock = ctx.failing.length
    ? ctx.failing
        .map(
          (f) =>
            `- ${f.name}\n    expected: ${f.expected}\n    extracted: ${f.got}\n    diagnosis: ${f.routingHint}`,
        )
        .join("\n")
    : "  (no failing fields)";

  const reportBlock = `<extraction_report>
Accuracy on this document: ${ctx.accuracy.toFixed(1)}%
Failing fields (expected vs. what the current schema extracted):
${failingBlock}
</extraction_report>`;

  const docBlock = ctx.markdown_head
    ? `<document_excerpt>
${ctx.doc_type ? `Document type: ${ctx.doc_type}\n` : ""}${ctx.markdown_head}
</document_excerpt>`
    : "<document_excerpt>\n(unavailable)\n</document_excerpt>";

  const schemaBlock = currentYaml.trim()
    ? `<current_schema>\n${currentYaml}\n</current_schema>`
    : "<current_schema>\n(empty)\n</current_schema>";

  const rejectedBlock = ctx.rejected && ctx.rejected.length
    ? `<already_tried_and_rejected>\nThese edits were already tried and did NOT help (no improvement or a regression). Do not repeat them — try a different approach:\n${ctx.rejected.map((r) => `- ${r}`).join("\n")}\n</already_tried_and_rejected>`
    : "";

  return [
    TUNE_SYSTEM_PROMPT,
    "",
    reportBlock,
    "",
    rejectedBlock,
    rejectedBlock ? "" : null,
    docBlock,
    "",
    schemaBlock,
    "",
    "### Tuner",
  ].filter((x) => x !== null).join("\n");
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the full prompt string for the schema agent.
 *
 * Serializes conversation history, document context, and the current schema
 * into a single prompt that works with any provider (OpenAI, Anthropic, etc).
 */
export function buildAgentPrompt(
  history: AgentMessage[],
  userMessage: string,
  currentYaml: string,
  docContext: DocumentContext,
): string {
  // Build document context block
  const kvSample = docContext.kv_pairs
    .slice(0, 30)
    .map((p) => `  ${p.label}: ${p.value}`)
    .join("\n");

  const contextBlock = docContext.markdown_head
    ? `<document_context>
${docContext.doc_type ? `Document type: ${docContext.doc_type}\n` : ""}Key-value pairs found in document:
${kvSample || "  (none detected)"}

Document excerpt (first 2000 chars):
${docContext.markdown_head}
</document_context>`
    : `<document_context>
No document content available yet. Help the user design a schema based on their description.
If they ask to analyze a document, suggest they select a document and run extraction first.
</document_context>`;

  const schemaBlock = currentYaml.trim()
    ? `<current_schema>
${currentYaml}
</current_schema>`
    : "<current_schema>\n(empty — no schema yet)\n</current_schema>";

  // Serialize history (keep last 6 turns = 12 messages for context window)
  const recentHistory = history.slice(-12);
  const historyText = recentHistory
    .map((m) => `### ${m.role === "user" ? "User" : "Assistant"}\n${m.content}`)
    .join("\n\n");

  return [
    SYSTEM_PROMPT,
    "",
    contextBlock,
    "",
    schemaBlock,
    "",
    historyText ? `### Conversation history\n\n${historyText}\n` : "",
    `### User\n${userMessage}`,
    "",
    "### Assistant",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse the agent's response to extract YAML, explanation, and doc type.
 *
 * Uses XML-style tags rather than JSON because YAML content contains
 * characters that break JSON escaping.
 */
/**
 * Extract the YAML the model proposed. We ask for a `<yaml>` block, but models
 * (esp. smaller ones, and reliably on the larger tuning prompt) return a
 * ```yaml fenced block instead — so the tag-only match silently yielded `null`
 * and the whole proposal was dropped. Accept, in order: the `<yaml>` tag, a
 * ```yaml```/```yml``` fence, then a bare ``` fence that looks like a schema
 * (has a top-level `name:`/`fields:`). Exported for tests.
 */
export function extractProposedYaml(raw: string): string | null {
  const tag = raw.match(/<yaml>([\s\S]*?)<\/yaml>/);
  if (tag?.[1]?.trim()) return tag[1].trim();
  const yamlFence = raw.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (yamlFence?.[1]?.trim()) return yamlFence[1].trim();
  const bareFence = raw.match(/```\s*\n([\s\S]*?)```/);
  if (bareFence?.[1] && /(^|\n)\s*(name|fields)\s*:/.test(bareFence[1])) {
    return bareFence[1].trim();
  }
  return null;
}

export function parseAgentResponse(raw: string): {
  yaml: string | null;
  explanation: string;
  doc_type: string | null;
} {
  const explanationMatch = raw.match(/<explanation>([\s\S]*?)<\/explanation>/);
  const docTypeMatch = raw.match(/<doc_type>([\s\S]*?)<\/doc_type>/);

  return {
    yaml: extractProposedYaml(raw),
    explanation: explanationMatch?.[1]?.trim() ?? raw.trim().slice(0, 200),
    doc_type: docTypeMatch?.[1]?.trim() ?? null,
  };
}
