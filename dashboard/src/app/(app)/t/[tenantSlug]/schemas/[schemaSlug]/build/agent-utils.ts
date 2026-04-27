/**
 * Client-side utilities for parsing agent responses.
 */

export function parseAgentResponse(raw: string): {
  yaml: string | null;
  explanation: string;
  doc_type: string | null;
} {
  const yamlMatch = raw.match(/<yaml>([\s\S]*?)<\/yaml>/);
  const explanationMatch = raw.match(/<explanation>([\s\S]*?)<\/explanation>/);
  const docTypeMatch = raw.match(/<doc_type>([\s\S]*?)<\/doc_type>/);

  // Fallback: strip all XML tags and use the remaining text as explanation
  const fallbackExplanation = raw
    .replace(/<yaml>[\s\S]*?<\/yaml>/g, "")
    .replace(/<explanation>[\s\S]*?<\/explanation>/g, "")
    .replace(/<doc_type>[\s\S]*?<\/doc_type>/g, "")
    .replace(/<\/?[a-z_]+>/g, "")
    .trim()
    .slice(0, 300);

  return {
    yaml: yamlMatch?.[1]?.trim() ?? null,
    explanation: explanationMatch?.[1]?.trim() ?? (fallbackExplanation || "Schema updated."),
    doc_type: docTypeMatch?.[1]?.trim() ?? null,
  };
}
