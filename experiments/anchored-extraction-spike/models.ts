/**
 * THROWAWAY SPIKE HARNESS — NOT PRODUCTION CODE (oss-331).
 *
 * Minimal direct model callers (native fetch, JSON mode), mirroring how
 * `api/src/extract/providers.ts` talks to OpenAI / Anthropic. No SDK deps.
 * Returns raw text; the runner parses JSON.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResult {
  text: string;
  usage: Usage;
}

export async function callOpenAI(prompt: string, model = "gpt-4o-mini"): Promise<ModelResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as any;
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

export async function callAnthropic(prompt: string, model = "claude-haiku-4-5"): Promise<ModelResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0,
      // Nudge JSON-only output; we parse the first {...} block defensively.
      system: "Respond with a single JSON object and nothing else.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as any;
  const text = (json.content ?? []).map((b: any) => b.text ?? "").join("");
  return {
    text,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}

/** Extract the first balanced top-level JSON object from a model reply. */
export function parseJsonObject(text: string): any {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`unbalanced JSON in reply: ${text.slice(0, 200)}`);
}
