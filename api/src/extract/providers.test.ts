import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  OLLAMA_DEFAULT_CONTEXT_TOKENS,
  AzureOpenAIProvider,
  createProvider,
  ProviderHttpError,
  ProviderTransportError,
  TRANSPORT_RETRY,
  isSystemicProviderError,
  isContextLengthError,
  isTransportError,
} from "./providers";
import { DEFAULT_CONTEXT_TOKENS, completionReserve } from "./context-budget";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

function mockFetchErr(status: number, text: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(text),
  } as unknown as Response);
}

// Retryable statuses (429/5xx) now back off before giving up — collapse the
// delay to zero so the suite doesn't sleep through it.
const REAL_RETRY_DELAY = TRANSPORT_RETRY.baseDelayMs;
beforeEach(() => {
  TRANSPORT_RETRY.baseDelayMs = 0;
});
afterEach(() => {
  TRANSPORT_RETRY.baseDelayMs = REAL_RETRY_DELAY;
});

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

describe("OpenAIProvider", () => {
  let original: typeof globalThis.fetch;

  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("sends correct request to /chat/completions", async () => {
    const body = { choices: [{ message: { content: '{"a":1}' } }] };
    const fakeFetch = mockFetchOk(body);
    globalThis.fetch = fakeFetch;

    const provider = new OpenAIProvider("gpt-4o", "sk-test", "https://api.example.com/v1");
    const result = await provider.generate("extract this", true);

    expect(result).toBe('{"a":1}');

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("gpt-4o");
    expect(payload.messages).toEqual([{ role: "user", content: "extract this" }]);
    expect(payload.temperature).toBe(0);
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format when jsonMode is false", async () => {
    const body = { choices: [{ message: { content: "hello" } }] };
    const fakeFetch = mockFetchOk(body);
    globalThis.fetch = fakeFetch;

    const provider = new OpenAIProvider("gpt-4o", "sk-test");
    await provider.generate("hello", false);

    const payload = JSON.parse(fakeFetch.mock.calls[0]![1].body);
    expect(payload.response_format).toBeUndefined();
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = mockFetchErr(429, "rate limited");
    const provider = new OpenAIProvider("gpt-4o", "sk-test");
    await expect(provider.generate("test")).rejects.toThrow("OpenAI 429: rate limited");
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  let original: typeof globalThis.fetch;

  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("sends correct request to /messages", async () => {
    const body = { content: [{ type: "text", text: '{"b":2}' }] };
    const fakeFetch = mockFetchOk(body);
    globalThis.fetch = fakeFetch;

    const provider = new AnthropicProvider("claude-3-opus", "sk-ant-test", "https://api.anthropic.com/v1");
    const result = await provider.generate("extract this", true);

    expect(result).toBe('{"b":2}');

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");

    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("claude-3-opus");
    expect(payload.messages[0].content).toContain("Respond with ONLY a JSON object.");
  });

  it("does not append JSON suffix when jsonMode is false", async () => {
    const body = { content: [{ type: "text", text: "hello" }] };
    globalThis.fetch = mockFetchOk(body);

    const provider = new AnthropicProvider("claude-3-opus", "sk-ant-test");
    await provider.generate("hello", false);

    const payload = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(payload.messages[0].content).toBe("hello");
  });

  it("returns empty string when response has no text blocks", async () => {
    const body = { content: [{ type: "image", data: "abc" }] };
    globalThis.fetch = mockFetchOk(body);

    const provider = new AnthropicProvider("claude-3-opus", "sk-ant-test");
    const result = await provider.generate("test");
    expect(result).toBe("");
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = mockFetchErr(500, "server error");
    const provider = new AnthropicProvider("claude-3-opus", "sk-ant-test");
    await expect(provider.generate("test")).rejects.toThrow("Anthropic 500: server error");
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------

describe("OllamaProvider", () => {
  let original: typeof globalThis.fetch;

  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("sends correct request to /api/generate", async () => {
    const body = { response: '{"c":3}' };
    const fakeFetch = mockFetchOk(body);
    globalThis.fetch = fakeFetch;

    const provider = new OllamaProvider("llama3", "http://localhost:11434");
    const result = await provider.generate("extract this", true);

    expect(result).toBe('{"c":3}');

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/generate");

    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("llama3");
    expect(payload.prompt).toBe("extract this");
    expect(payload.stream).toBe(false);
    expect(payload.format).toBe("json");
  });

  it("omits format when jsonMode is false", async () => {
    globalThis.fetch = mockFetchOk({ response: "hi" });
    const provider = new OllamaProvider("llama3", "http://localhost:11434");
    await provider.generate("hello", false);

    const payload = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(payload.format).toBeUndefined();
  });

  it("returns empty string when response field is missing", async () => {
    globalThis.fetch = mockFetchOk({});
    const provider = new OllamaProvider("llama3", "http://localhost:11434");
    const result = await provider.generate("test");
    expect(result).toBe("");
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = mockFetchErr(404, "model not found");
    const provider = new OllamaProvider("llama3", "http://localhost:11434");
    await expect(provider.generate("test")).rejects.toThrow("Ollama 404: model not found");
  });
});

// ---------------------------------------------------------------------------
// AzureOpenAIProvider
// ---------------------------------------------------------------------------

describe("AzureOpenAIProvider", () => {
  let original: typeof globalThis.fetch;

  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("builds the correct URL with deployment name and api version", async () => {
    const body = { choices: [{ message: { content: '{"d":4}' } }] };
    const fakeFetch = mockFetchOk(body);
    globalThis.fetch = fakeFetch;

    const provider = new AzureOpenAIProvider(
      "gpt-4",
      "az-key",
      "https://myresource.openai.azure.com/",
      "gpt-4-deployment",
      "2024-02-01",
    );
    const result = await provider.generate("extract", true);

    expect(result).toBe('{"d":4}');

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe(
      "https://myresource.openai.azure.com/openai/deployments/gpt-4-deployment/chat/completions?api-version=2024-02-01",
    );
    expect(init.headers["api-key"]).toBe("az-key");
  });

  it("strips trailing slashes from base URL", async () => {
    const body = { choices: [{ message: { content: "{}" } }] };
    globalThis.fetch = mockFetchOk(body);

    const provider = new AzureOpenAIProvider(
      "gpt-4",
      "key",
      "https://example.com///",
      "dep",
      "2024-02-01",
    );
    await provider.generate("test");

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("https://example.com/openai/deployments/dep/");
  });
});

// ---------------------------------------------------------------------------
// createProvider factory
// ---------------------------------------------------------------------------

describe("createProvider", () => {
  it("returns OpenAIProvider from endpoint config", () => {
    const provider = createProvider("anything", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "sk-test",
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("returns AnthropicProvider from endpoint config", () => {
    const provider = createProvider("anything", {
      provider: "anthropic",
      model: "claude-3-opus",
      api_key: "sk-ant-test",
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("returns OllamaProvider from endpoint config", () => {
    const provider = createProvider("anything", {
      provider: "ollama",
      model: "llama3",
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("returns AzureOpenAIProvider from endpoint config", () => {
    const provider = createProvider("anything", {
      provider: "azure-openai",
      model: "gpt-4",
      api_key: "key",
      base_url: "https://example.com",
      deployment_name: "dep",
      api_version: "2024-02-01",
    });
    expect(provider).toBeInstanceOf(AzureOpenAIProvider);
  });

  it("throws for unknown endpoint provider", () => {
    expect(() =>
      createProvider("anything", { provider: "bedrock", model: "test" }),
    ).toThrow("unknown endpoint provider: bedrock");
  });

  it("throws when openai endpoint has no api_key", () => {
    expect(() =>
      createProvider("anything", { provider: "openai", model: "gpt-4o" }),
    ).toThrow("openai endpoint requires api_key");
  });

  it("throws when anthropic endpoint has no api_key", () => {
    expect(() =>
      createProvider("anything", { provider: "anthropic", model: "claude-3" }),
    ).toThrow("anthropic endpoint requires api_key");
  });

  it("throws when azure-openai endpoint is missing fields", () => {
    expect(() =>
      createProvider("anything", {
        provider: "azure-openai",
        model: "gpt-4",
        api_key: "key",
      }),
    ).toThrow("azure-openai endpoint missing: base_url, deployment_name, api_version");
  });

  // Model string routing (no endpoint config)

  it("routes gpt-* to OpenAIProvider", () => {
    const provider = createProvider("gpt-4o");
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("routes o1-* to OpenAIProvider", () => {
    const provider = createProvider("o1-preview");
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("routes claude* to AnthropicProvider", () => {
    const provider = createProvider("claude-3-sonnet");
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("routes openai/model to OpenAIProvider", () => {
    const provider = createProvider("openai/gpt-4o-mini");
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("routes ollama/model to OllamaProvider", () => {
    const provider = createProvider("ollama/llama3");
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("routes anthropic/model to AnthropicProvider", () => {
    const provider = createProvider("anthropic/claude-3-opus");
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("routes unknown prefix/model to OpenAIProvider (generic fallback)", () => {
    const provider = createProvider("custom/my-model");
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("routes bare unknown model to OllamaProvider", () => {
    const provider = createProvider("llama3");
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("prefers endpoint config over model string", () => {
    const provider = createProvider("claude-3-opus", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "sk-test",
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});

describe("ProviderHttpError / isSystemicProviderError (oss-346)", () => {
  it("classifies auth/model 4xx as systemic (surface, don't swallow)", () => {
    expect(isSystemicProviderError(new ProviderHttpError(404, "OpenAI 404: model not found"))).toBe(true);
    expect(isSystemicProviderError(new ProviderHttpError(401, "OpenAI 401: bad key"))).toBe(true);
    expect(isSystemicProviderError(new ProviderHttpError(400, "bad request"))).toBe(true);
    expect(isSystemicProviderError(new ProviderHttpError(403, "forbidden"))).toBe(true);
  });

  it("does not classify 5xx / transient / non-provider errors as systemic", () => {
    expect(isSystemicProviderError(new ProviderHttpError(500, "server error"))).toBe(false);
    expect(isSystemicProviderError(new ProviderHttpError(429, "rate limited"))).toBe(false);
    expect(isSystemicProviderError(new Error("network timeout"))).toBe(false);
    expect(isSystemicProviderError(null)).toBe(false);
  });

  it("OpenAIProvider throws a ProviderHttpError carrying the status on a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("The model `gpt-4o-2024-11-20` does not exist", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const p = new OpenAIProvider("gpt-4o-2024-11-20", "sk-test");
      await expect(p.generate("hi")).rejects.toMatchObject({ status: 404 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isContextLengthError (oss-434)", () => {
  it("recognizes a context_length_exceeded 400 as recoverable", () => {
    expect(
      isContextLengthError(
        new ProviderHttpError(
          400,
          'OpenAI 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 285896 tokens.","code":"context_length_exceeded"}}',
        ),
      ),
    ).toBe(true);
  });

  it("does not treat other 400s (or non-400s) as context-length errors", () => {
    expect(isContextLengthError(new ProviderHttpError(400, "OpenAI 400: invalid_request_error — bad schema"))).toBe(
      false,
    );
    expect(isContextLengthError(new ProviderHttpError(413, "context_length_exceeded"))).toBe(false);
    expect(isContextLengthError(new ProviderHttpError(401, "bad key"))).toBe(false);
    expect(isContextLengthError(new Error("context length"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-model context window (oss-465)
// ---------------------------------------------------------------------------

describe("contextTokens (oss-465)", () => {
  let original: typeof globalThis.fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("hosted providers default to the mainstream window", () => {
    expect(new OpenAIProvider("gpt-4o", "sk").contextTokens).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(new AnthropicProvider("claude", "sk").contextTokens).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(new AzureOpenAIProvider("m", "k", "https://x", "d", "v1").contextTokens).toBe(
      DEFAULT_CONTEXT_TOKENS,
    );
  });

  it("Ollama defaults to a small local window, not the hosted one", () => {
    // The bug: assuming 128k for a local model meant the engine built prompts
    // Ollama silently truncated to its own default.
    expect(new OllamaProvider("llama3").contextTokens).toBe(OLLAMA_DEFAULT_CONTEXT_TOKENS);
    expect(OLLAMA_DEFAULT_CONTEXT_TOKENS).toBeLessThan(DEFAULT_CONTEXT_TOKENS);
  });

  it("takes the window from endpoint config when declared", () => {
    const p = createProvider("llama3", {
      provider: "ollama",
      model: "llama3",
      base_url: "http://localhost:11434",
      context_tokens: 32_768,
    });
    expect(p.contextTokens).toBe(32_768);

    const openai = createProvider("gpt-4o", {
      provider: "openai",
      model: "gpt-4o",
      api_key: "sk-test",
      context_tokens: 1_000_000,
    });
    expect(openai.contextTokens).toBe(1_000_000);
  });

  it("ignores a nonsense configured window rather than collapsing the budget", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const p = createProvider("llama3", {
        provider: "ollama",
        model: "llama3",
        context_tokens: bad,
      });
      expect(p.contextTokens).toBe(OLLAMA_DEFAULT_CONTEXT_TOKENS);
    }
  });

  it("OllamaProvider sends num_ctx so the server allocates the window we budgeted for", async () => {
    // Without num_ctx, Ollama falls back to its own small default and drops the
    // rest of the prompt with no error (a 90k-token prompt came back with
    // prompt_eval_count: 8192).
    const fakeFetch = mockFetchOk({ response: "{}" });
    globalThis.fetch = fakeFetch;

    const provider = new OllamaProvider("llama3", "http://localhost:11434", 32_768);
    await provider.generate("extract this", true);

    const payload = JSON.parse(fakeFetch.mock.calls[0]![1].body);
    expect(payload.options.num_ctx).toBe(32_768);
    // num_predict must match the reserve the budgeter subtracted.
    expect(payload.options.num_predict).toBe(completionReserve(32_768));
  });

  it("Ollama's num_ctx follows its default when nothing is configured", async () => {
    const fakeFetch = mockFetchOk({ response: "{}" });
    globalThis.fetch = fakeFetch;
    await new OllamaProvider("llama3", "http://localhost:11434").generate("hi");
    const payload = JSON.parse(fakeFetch.mock.calls[0]![1].body);
    expect(payload.options.num_ctx).toBe(OLLAMA_DEFAULT_CONTEXT_TOKENS);
  });

  it("hosted providers send max_tokens equal to the budgeter's reserve", async () => {
    const fakeFetch = mockFetchOk({ choices: [{ message: { content: "{}" } }] });
    globalThis.fetch = fakeFetch;
    await new OpenAIProvider("gpt-4o", "sk", "https://api.example.com/v1").generate("hi");
    const payload = JSON.parse(fakeFetch.mock.calls[0]![1].body);
    expect(payload.max_tokens).toBe(completionReserve(DEFAULT_CONTEXT_TOKENS));
  });
});

// ---------------------------------------------------------------------------
// Transport retry (oss-472)
// ---------------------------------------------------------------------------

describe("transport retry (oss-472)", () => {
  let original: typeof globalThis.fetch;
  let originalRetry: typeof TRANSPORT_RETRY.baseDelayMs;

  beforeEach(() => {
    original = globalThis.fetch;
    originalRetry = TRANSPORT_RETRY.baseDelayMs;
    TRANSPORT_RETRY.baseDelayMs = 0; // don't actually sleep in tests
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = original;
    TRANSPORT_RETRY.baseDelayMs = originalRetry;
    vi.restoreAllMocks();
  });

  /** A response whose body read blows up — a socket abort mid-download. */
  function bodyAbortResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.reject(new TypeError("terminated")),
      text: () => Promise.reject(new TypeError("terminated")),
    } as unknown as Response;
  }

  function okResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  it("retries a socket abort during the response-body read and succeeds", async () => {
    // This is the whole point of the fix: the fetch resolved fine, the body
    // read is where it died. Retrying the request alone would not have helped.
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(bodyAbortResponse())
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: '{"a":1}' } }] }));
    globalThis.fetch = fakeFetch;

    const out = await new OpenAIProvider("gpt-4o", "sk", "https://api.example.com/v1").generate("hi");
    expect(out).toBe('{"a":1}');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a network-level fetch failure", async () => {
    const fakeFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okResponse({ response: "ok" }));
    globalThis.fetch = fakeFetch;

    expect(await new OllamaProvider("llama3", "http://localhost:11434").generate("hi")).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 and a 5xx", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(okResponse({ content: [{ type: "text", text: "hi" }] }));
    globalThis.fetch = fakeFetch;

    expect(await new AnthropicProvider("claude", "sk").generate("hi")).toBe("hi");
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("throws a ProviderTransportError once retries are exhausted", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(bodyAbortResponse());
    globalThis.fetch = fakeFetch;

    const err = await new OpenAIProvider("gpt-4o", "sk", "https://api.example.com/v1")
      .generate("hi")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderTransportError);
    expect(isTransportError(err)).toBe(true);
    // Not confusable with the classes callers swallow.
    expect(isSystemicProviderError(err)).toBe(false);
    expect(isContextLengthError(err)).toBe(false);
    expect(fakeFetch).toHaveBeenCalledTimes(TRANSPORT_RETRY.attempts);
  });

  it("does not retry a 4xx — it is an answer about the request", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response("no such model", { status: 404 }));
    globalThis.fetch = fakeFetch;

    await expect(
      new OpenAIProvider("nope", "sk", "https://api.example.com/v1").generate("hi"),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed JSON body", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    } as unknown as Response);
    globalThis.fetch = fakeFetch;

    await expect(
      new OpenAIProvider("gpt-4o", "sk", "https://api.example.com/v1").generate("hi"),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("isTransportError only matches exhausted transport failures", () => {
    expect(isTransportError(new ProviderTransportError("x", 3))).toBe(true);
    expect(isTransportError(new ProviderHttpError(500, "server error"))).toBe(false);
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });
});
