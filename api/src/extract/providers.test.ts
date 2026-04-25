import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  AzureOpenAIProvider,
  createProvider,
} from "./providers";

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

    const [url, init] = fakeFetch.mock.calls[0];
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

    const payload = JSON.parse(fakeFetch.mock.calls[0][1].body);
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

    const [url, init] = fakeFetch.mock.calls[0];
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

    const [url, init] = fakeFetch.mock.calls[0];
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

    const [url, init] = fakeFetch.mock.calls[0];
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
