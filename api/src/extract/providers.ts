/**
 * LLM provider adapters — TypeScript port of services/extract/providers.py.
 *
 * Each provider exposes `generate(prompt, jsonMode)` which sends a prompt
 * to the model and returns the raw text response. Uses native fetch().
 *
 * Supported providers:
 * - OpenAI (+ any OpenAI-compatible endpoint: vLLM, TGI, LiteLLM)
 * - Anthropic (native Messages API)
 * - Ollama (local HTTP)
 * - Azure OpenAI (deployment-based routing)
 *
 * Bedrock is intentionally omitted — it requires SigV4 signing which
 * needs a dedicated AWS SDK dependency. Route Bedrock through an
 * OpenAI-compatible proxy for now.
 */

import type { ExtractEndpointPayload } from "./resolve-endpoint";

// ---------------------------------------------------------------------------
// Base interface
// ---------------------------------------------------------------------------

export interface ModelProvider {
  generate(prompt: string, jsonMode?: boolean): Promise<string>;
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

export class OllamaProvider implements ModelProvider {
  constructor(
    private model: string,
    private baseUrl: string = process.env.KOJI_OLLAMA_URL ?? "http://ollama:11434",
  ) {}

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 4096 },
    };
    if (jsonMode) payload.format = "json";

    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1_800_000),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
    const body = (await resp.json()) as { response?: string };
    return body.response ?? "";
  }
}

// ---------------------------------------------------------------------------
// OpenAI (+ OpenAI-compatible)
// ---------------------------------------------------------------------------

export class OpenAIProvider implements ModelProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(
    private model: string,
    apiKey?: string,
    baseUrl?: string,
  ) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? process.env.KOJI_OPENAI_URL ?? "https://api.openai.com/v1";
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 4096,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
    const body = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return body.choices[0].message.content;
  }
}

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------

export class AzureOpenAIProvider implements ModelProvider {
  constructor(
    private model: string,
    private apiKey: string,
    private baseUrl: string,
    private deploymentName: string,
    private apiVersion: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private url(): string {
    return `${this.baseUrl}/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 4096,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const resp = await fetch(this.url(), {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`Azure OpenAI ${resp.status}: ${await resp.text()}`);
    const body = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return body.choices[0].message.content;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  private static ANTHROPIC_VERSION = "2023-06-01";
  private static JSON_SUFFIX = "\n\nRespond with ONLY a JSON object.";

  constructor(
    private model: string,
    private apiKey: string,
    private baseUrl: string = "https://api.anthropic.com/v1",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private static extractText(body: { content?: Array<{ type: string; text?: string }> }): string {
    for (const block of body.content ?? []) {
      if (block.type === "text") return block.text ?? "";
    }
    return "";
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const effectivePrompt = jsonMode ? prompt + AnthropicProvider.JSON_SUFFIX : prompt;
    const payload = {
      model: this.model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: "user", content: effectivePrompt }],
    };

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": AnthropicProvider.ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    return AnthropicProvider.extractText(await resp.json());
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider from an endpoint config (the common path from the
 * Node API) or fall back to env-var defaults + model-string routing.
 */
export function createProvider(
  modelStr: string,
  endpointCfg?: ExtractEndpointPayload | null,
): ModelProvider {
  if (endpointCfg) {
    return buildFromEndpoint(endpointCfg);
  }
  return buildFromModelString(modelStr);
}

function buildFromEndpoint(cfg: ExtractEndpointPayload): ModelProvider {
  const provider = cfg.provider.toLowerCase();

  switch (provider) {
    case "openai":
      if (!cfg.api_key) throw new Error("openai endpoint requires api_key");
      return new OpenAIProvider(cfg.model, cfg.api_key, cfg.base_url);

    case "azure-openai": {
      const missing = (
        [
          ["api_key", cfg.api_key],
          ["base_url", cfg.base_url],
          ["deployment_name", cfg.deployment_name],
          ["api_version", cfg.api_version],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([n]) => n);
      if (missing.length > 0)
        throw new Error(`azure-openai endpoint missing: ${missing.join(", ")}`);
      return new AzureOpenAIProvider(
        cfg.model,
        cfg.api_key!,
        cfg.base_url!,
        cfg.deployment_name!,
        cfg.api_version!,
      );
    }

    case "anthropic":
      if (!cfg.api_key) throw new Error("anthropic endpoint requires api_key");
      return new AnthropicProvider(cfg.model, cfg.api_key, cfg.base_url ?? undefined);

    case "ollama":
      return new OllamaProvider(cfg.model, cfg.base_url ?? undefined);

    default:
      throw new Error(`unknown endpoint provider: ${provider}`);
  }
}

const OPENAI_PREFIXES = ["gpt-", "o1-", "o3-", "chatgpt-"];

function buildFromModelString(modelStr: string): ModelProvider {
  if (modelStr.includes("/")) {
    const [provider, ...rest] = modelStr.split("/");
    const model = rest.join("/");
    switch (provider.toLowerCase()) {
      case "openai":
        return new OpenAIProvider(model);
      case "ollama":
        return new OllamaProvider(model);
      case "anthropic":
        return new AnthropicProvider(model, process.env.ANTHROPIC_API_KEY ?? "");
      default:
        return new OpenAIProvider(model);
    }
  }

  if (OPENAI_PREFIXES.some((p) => modelStr.startsWith(p))) {
    return new OpenAIProvider(modelStr);
  }
  if (modelStr.startsWith("claude")) {
    return new AnthropicProvider(modelStr, process.env.ANTHROPIC_API_KEY ?? "");
  }
  return new OllamaProvider(modelStr);
}
