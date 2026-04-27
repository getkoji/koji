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

  return {
    yaml: yamlMatch?.[1]?.trim() ?? null,
    explanation: explanationMatch?.[1]?.trim() ?? raw.trim().slice(0, 200),
    doc_type: docTypeMatch?.[1]?.trim() ?? null,
  };
}
