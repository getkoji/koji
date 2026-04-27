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
- normalize: iso8601 | minor_units | uppercase | lowercase | trim | us_phone | email | url
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
    : "<document_context>\nNo document selected. Help the user design a schema based on their description.\n</document_context>";

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
export function parseAgentResponse(raw: string): {
  yaml: string | null;
  explanation: string;
  doc_type: string | null;
} {
  const yamlMatch = raw.match(/<yaml>([\s\S]*?)<\/yaml>/);
  const explanationMatch = raw.match(/<explanation>([\s\S]*?)<\/explanation>/);
  const docTypeMatch = raw.match(/<doc_type>([\s\S]*?)<\/doc_type>/);

  return {
    yaml: yamlMatch?.[1]?.trim() ?? null,
    explanation: explanationMatch?.[1]?.trim() ?? raw.trim().slice(0, 200),
    doc_type: docTypeMatch?.[1]?.trim() ?? null,
  };
}
