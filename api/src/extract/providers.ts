/**
 * LLM provider adapters — creates provider instances for extraction.
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
import { DEFAULT_CONTEXT_TOKENS, completionReserve } from "./context-budget";

// ---------------------------------------------------------------------------
// Base interface
// ---------------------------------------------------------------------------

export interface ModelProvider {
  /**
   * The context window, in tokens, this provider will actually honor for a
   * call. Required: the budgeting layer (`context-budget.ts`) splits prompts
   * against this number, and a provider that doesn't report its real window
   * gets prompts sized for someone else's — which is silent truncation on a
   * small-window model, not an error.
   */
  readonly contextTokens: number;
  generate(prompt: string, jsonMode?: boolean): Promise<string>;
  /** Generate with an image (vision). Base64 PNG + text prompt. */
  generateWithImage?(prompt: string, imageBase64: string, jsonMode?: boolean): Promise<string>;
  /**
   * Stream generation token-by-token: `onToken` receives each text delta as it
   * arrives; the full concatenated text is returned. Optional — callers should
   * fall back to `generate` when a provider doesn't implement it.
   */
  generateStream?(
    prompt: string,
    onToken: (delta: string) => void,
    jsonMode?: boolean,
  ): Promise<string>;
}

/**
 * An HTTP error from a model provider, carrying the status code so callers can
 * distinguish a systemic misconfiguration (bad model name → 404, bad key → 401)
 * — which every extraction call will hit identically and should surface as a
 * clear error — from a transient failure worth tolerating.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/** Status codes that mean "your request/config is wrong" — surface, don't swallow. */
export function isSystemicProviderError(e: unknown): boolean {
  return e instanceof ProviderHttpError && [400, 401, 403, 404].includes(e.status);
}

/**
 * A `context_length_exceeded` 400 — the prompt was larger than the model's
 * context window. Unlike other 400s (malformed request, bad params) this is
 * *recoverable* by splitting the input into smaller calls, so callers that can
 * re-split should retry rather than fail the document. Matched on the provider
 * message because the wire shape differs across OpenAI/Azure/compatible
 * endpoints, but the phrasing ("maximum context length", "context_length_exceeded",
 * "reduce the length", "too many tokens") is stable.
 */
export function isContextLengthError(e: unknown): boolean {
  return (
    e instanceof ProviderHttpError &&
    e.status === 400 &&
    /context[ _]length|maximum context|reduce the length|too many tokens|context window/i.test(
      e.message,
    )
  );
}

/**
 * A provider call that failed at the transport layer and stayed failed after
 * every retry: a socket reset, a DNS blip, a timeout, or a retryable status
 * (429 / 5xx) that never cleared.
 *
 * This is a distinct class from `ProviderHttpError` because the two demand
 * opposite handling. An HTTP 400 is an answer — the request was wrong. A dead
 * socket is *no answer at all*, and callers that treat "no answer" the same as
 * "the model found nothing" write nulls into the output as if they were facts.
 * Callers must surface this, never swallow it.
 */
export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProviderTransportError";
  }
}

/** Whether `e` is an exhausted transport failure — surface, never swallow. */
export function isTransportError(e: unknown): boolean {
  return e instanceof ProviderTransportError;
}

/**
 * Transport retry policy. Exported (and mutable) so tests can collapse the
 * backoff to zero; production never writes to it.
 */
export const TRANSPORT_RETRY = {
  /** Total attempts, including the first. */
  attempts: 3,
  /** First backoff step; doubles per retry up to `maxDelayMs`. */
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Statuses worth retrying: rate limits and server-side faults. Everything
 * else (4xx) is an answer about the request and retrying can't change it. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Whether a thrown value is a transient transport fault rather than a decision
 * by the server. Covers fetch's network errors (`TypeError: fetch failed`),
 * abort/timeout errors from `AbortSignal.timeout`, and the body-read failures
 * that surface as plain errors when a socket dies mid-response.
 *
 * `ProviderHttpError` is deliberately excluded — it means we got a status back.
 */
function isTransientFailure(e: unknown): boolean {
  if (e instanceof ProviderHttpError || e instanceof ProviderTransportError) return false;
  // A malformed body is a stable answer, not a blip — retrying re-reads the
  // same garbage. Callers already handle unparseable model output.
  if (e instanceof SyntaxError) return false;
  const name = e instanceof Error ? e.name : "";
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError;
  // an explicit abort gives AbortError.
  if (name === "AbortError" || name === "TimeoutError") return true;
  // undici raises socket faults as TypeError("fetch failed") and body-read
  // faults as TypeError("terminated"), both with a nested cause.
  if (e instanceof TypeError) return true;
  return (
    e instanceof Error &&
    /socket|network|econnreset|econnrefused|epipe|etimedout|enotfound|eai_again|terminated|premature close|fetch failed/i.test(
      e.message,
    )
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run one provider HTTP round trip — request *and* response consumption —
 * retrying transient failures with bounded exponential backoff.
 *
 * `consume` is part of the retried unit on purpose. The original bug was that
 * only `fetch()` was attempted once and `await resp.json()` sat outside any
 * error classification: a socket abort during the body read threw a bare
 * network error that matched neither `isSystemicProviderError` nor
 * `isContextLengthError`, so the group extractor swallowed it and returned an
 * empty extraction. Retrying the request alone would not have helped — the read
 * is where it broke.
 *
 * Non-ok responses: retryable statuses are retried, everything else throws
 * `ProviderHttpError` immediately. When attempts run out, the last failure is
 * wrapped in a `ProviderTransportError`.
 *
 * `init.signal` is deliberately reused across attempts: the caller's timeout is
 * a budget for the whole call, not per attempt, so retries can't extend how long
 * a single extraction hangs.
 */
async function providerRequest<T>(
  label: string,
  url: string,
  init: RequestInit,
  consume: (resp: Response) => Promise<T>,
  opts: {
    /**
     * Whether a failure inside `consume` is retryable. True for buffered reads
     * (`resp.json()`), false for streaming reads — those have already handed
     * tokens to the caller, so replaying the call would duplicate them.
     */
    retryConsume?: boolean;
  } = {},
): Promise<T> {
  const retryConsume = opts.retryConsume ?? true;
  const attempts = Math.max(1, TRANSPORT_RETRY.attempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        const err = new ProviderHttpError(resp.status, `${label} ${resp.status}: ${detail}`);
        if (!isRetryableStatus(resp.status)) throw err;
        lastError = err;
      } else if (retryConsume) {
        return await consume(resp);
      } else {
        try {
          return await consume(resp);
        } catch (e) {
          // Non-retryable read: surface as a transport failure so callers still
          // treat it as "no answer" rather than "the model found nothing".
          if (isTransientFailure(e)) {
            throw new ProviderTransportError(
              `${label}: response stream failed — ${e instanceof Error ? e.message : String(e)}`,
              attempt,
              e,
            );
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof ProviderHttpError) {
        if (!isRetryableStatus(e.status)) throw e;
        lastError = e;
      } else if (isTransientFailure(e)) {
        lastError = e;
      } else {
        throw e;
      }
    }

    if (attempt < attempts) {
      const delay = Math.min(
        TRANSPORT_RETRY.maxDelayMs,
        TRANSPORT_RETRY.baseDelayMs * 2 ** (attempt - 1),
      );
      console.warn(
        `[koji-extract] ${label}: transient transport failure (attempt ${attempt}/${attempts}), ` +
          `retrying in ${delay}ms — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
      if (delay > 0) await sleep(delay);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderTransportError(
    `${label}: transport failure after ${attempts} attempt(s) — ${reason}`,
    attempts,
    lastError,
  );
}

/** `providerRequest` specialized to a JSON body — the shape every non-streaming
 * provider call uses. The `resp.json()` happens inside the retried unit. */
function providerRequestJson<T>(label: string, url: string, init: RequestInit): Promise<T> {
  return providerRequest(label, url, init, (resp) => resp.json() as Promise<T>);
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

/**
 * Consume an OpenAI-style `chat/completions` SSE stream: each `data:` line is a
 * chunk with `choices[0].delta.content`. Calls `onToken` per delta and returns
 * the full concatenated text. Shared by OpenAI + Azure providers.
 */
async function consumeOpenAIStream(resp: Response, onToken: (delta: string) => void): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        // ignore keep-alives / partial lines
      }
    }
  }
  return full;
}

/**
 * Default context window for a local Ollama model. Deliberately small: Ollama
 * allocates a modest window per model unless `num_ctx` says otherwise, and it
 * *silently truncates* anything past it — a 90k-token prompt came back with
 * `prompt_eval_count: 8192`, i.e. 91% of the document discarded with no error.
 * Assuming a hosted-sized window here is the bug; operators with a large-window
 * local model raise it via the endpoint's `context_tokens` config.
 */
export const OLLAMA_DEFAULT_CONTEXT_TOKENS = 8_192;

export class OllamaProvider implements ModelProvider {
  readonly contextTokens: number;

  constructor(
    private model: string,
    private baseUrl: string = process.env.KOJI_OLLAMA_URL ?? "http://ollama:11434",
    contextTokens?: number,
  ) {
    this.contextTokens = contextTokens ?? OLLAMA_DEFAULT_CONTEXT_TOKENS;
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        // Without num_ctx the server falls back to its own (small) default and
        // drops everything past it without erroring. Ask for the window we
        // budgeted against so the prompt we built is the prompt it reads.
        num_ctx: this.contextTokens,
        num_predict: completionReserve(this.contextTokens),
      },
    };
    if (jsonMode) payload.format = "json";

    const body = await providerRequestJson<{ response?: string }>(
      "Ollama",
      `${this.baseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1_800_000),
      },
    );
    return body.response ?? "";
  }
}

// ---------------------------------------------------------------------------
// OpenAI (+ OpenAI-compatible)
// ---------------------------------------------------------------------------

/** OpenAI-style chat/completions response body. */
type ChatCompletion = { choices: Array<{ message: { content: string } }> };

export class OpenAIProvider implements ModelProvider {
  private apiKey: string;
  private baseUrl: string;
  readonly contextTokens: number;

  constructor(
    private model: string,
    apiKey?: string,
    baseUrl?: string,
    contextTokens?: number,
  ) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = baseUrl ?? process.env.KOJI_OPENAI_URL ?? "https://api.openai.com/v1";
    this.contextTokens = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: completionReserve(this.contextTokens),
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const body = await providerRequestJson<ChatCompletion>(
      "OpenAI",
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      },
    );
    return body.choices[0]!.message.content;
  }

  async generateStream(prompt: string, onToken: (delta: string) => void, jsonMode = false): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: completionReserve(this.contextTokens),
      stream: true,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };
    // Streaming can't retry the body read — tokens are already delivered to the
    // caller — but the request itself still routes through the retry helper.
    return providerRequest(
      "OpenAI",
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      },
      (resp) => consumeOpenAIStream(resp, onToken),
      { retryConsume: false },
    );
  }

  async generateWithImage(prompt: string, imageBase64: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
          { type: "text", text: prompt },
        ],
      }],
      temperature: 0,
      max_tokens: completionReserve(this.contextTokens),
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const body = await providerRequestJson<ChatCompletion>(
      "OpenAI vision",
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      },
    );
    return body.choices[0]!.message.content;
  }
}

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------

export class AzureOpenAIProvider implements ModelProvider {
  readonly contextTokens: number;

  constructor(
    private model: string,
    private apiKey: string,
    private baseUrl: string,
    private deploymentName: string,
    private apiVersion: string,
    contextTokens?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.contextTokens = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  private url(): string {
    return `${this.baseUrl}/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: completionReserve(this.contextTokens),
    };
    if (jsonMode) payload.response_format = { type: "json_object" };

    const body = await providerRequestJson<ChatCompletion>("Azure OpenAI", this.url(), {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    return body.choices[0]!.message.content;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

type AnthropicMessage = { content?: Array<{ type: string; text?: string }> };

export class AnthropicProvider implements ModelProvider {
  private static ANTHROPIC_VERSION = "2023-06-01";
  private static JSON_SUFFIX = "\n\nRespond with ONLY a JSON object.";
  readonly contextTokens: number;

  constructor(
    private model: string,
    private apiKey: string,
    private baseUrl: string = "https://api.anthropic.com/v1",
    contextTokens?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.contextTokens = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  private static extractText(body: AnthropicMessage): string {
    for (const block of body.content ?? []) {
      if (block.type === "text") return block.text ?? "";
    }
    return "";
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": AnthropicProvider.ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    };
  }

  async generate(prompt: string, jsonMode = true): Promise<string> {
    const effectivePrompt = jsonMode ? prompt + AnthropicProvider.JSON_SUFFIX : prompt;
    const payload = {
      model: this.model,
      max_tokens: completionReserve(this.contextTokens),
      temperature: 0,
      messages: [{ role: "user", content: effectivePrompt }],
    };

    const body = await providerRequestJson<AnthropicMessage>("Anthropic", `${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    return AnthropicProvider.extractText(body);
  }

  async generateStream(prompt: string, onToken: (delta: string) => void, jsonMode = false): Promise<string> {
    const effectivePrompt = jsonMode ? prompt + AnthropicProvider.JSON_SUFFIX : prompt;
    // Streaming: the request retries, the read does not (tokens already
    // delivered can't be replayed) — see `providerRequest`.
    return providerRequest(
      "Anthropic",
      `${this.baseUrl}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: completionReserve(this.contextTokens),
          temperature: 0,
          stream: true,
          messages: [{ role: "user", content: effectivePrompt }],
        }),
        signal: AbortSignal.timeout(300_000),
      },
      async (resp) => {
        // Anthropic SSE: `content_block_delta` events carry `delta.text`.
        const reader = resp.body?.getReader();
        if (!reader) return "";
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            try {
              const json = JSON.parse(trimmed.slice(5).trim()) as { type?: string; delta?: { text?: string } };
              if (json.type === "content_block_delta" && json.delta?.text) {
                full += json.delta.text;
                onToken(json.delta.text);
              }
            } catch {
              // ignore
            }
          }
        }
        return full;
      },
      { retryConsume: false },
    );
  }

  async generateWithImage(prompt: string, imageBase64: string, jsonMode = true): Promise<string> {
    const effectivePrompt = jsonMode ? prompt + AnthropicProvider.JSON_SUFFIX : prompt;
    const payload = {
      model: this.model,
      max_tokens: completionReserve(this.contextTokens),
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
          { type: "text", text: effectivePrompt },
        ],
      }],
    };

    const body = await providerRequestJson<AnthropicMessage>(
      "Anthropic vision",
      `${this.baseUrl}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      },
    );
    return AnthropicProvider.extractText(body);
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

/** Configured context window for an endpoint, if the operator declared one.
 * A non-positive or non-finite value is ignored so a typo can't collapse the
 * budget to zero — the provider's own default applies instead. */
function configuredContextTokens(cfg: ExtractEndpointPayload): number | undefined {
  const raw = cfg.context_tokens;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

function buildFromEndpoint(cfg: ExtractEndpointPayload): ModelProvider {
  const provider = cfg.provider.toLowerCase();
  const model = cfg.model || process.env.KOJI_EXTRACT_MODEL || "gpt-4o-mini";
  const ctx = configuredContextTokens(cfg);

  switch (provider) {
    case "openai":
      if (!cfg.api_key) throw new Error("openai endpoint requires api_key");
      return new OpenAIProvider(model, cfg.api_key, cfg.base_url, ctx);

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
        model,
        cfg.api_key!,
        cfg.base_url!,
        cfg.deployment_name!,
        cfg.api_version!,
        ctx,
      );
    }

    case "anthropic":
      if (!cfg.api_key) throw new Error("anthropic endpoint requires api_key");
      return new AnthropicProvider(model, cfg.api_key, cfg.base_url ?? undefined, ctx);

    case "ollama":
      return new OllamaProvider(model, cfg.base_url ?? undefined, ctx);

    default:
      throw new Error(`unknown endpoint provider: ${provider}`);
  }
}

const OPENAI_PREFIXES = ["gpt-", "o1-", "o3-", "chatgpt-"];

function buildFromModelString(modelStr: string): ModelProvider {
  if (modelStr.includes("/")) {
    const [provider, ...rest] = modelStr.split("/");
    const model = rest.join("/");
    switch (provider!.toLowerCase()) {
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
