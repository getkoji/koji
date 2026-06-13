import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModalParseProvider } from "./modal";

// ── Helpers ─────────────────────────────────────────────────────────

const MODAL_URL = "https://test--koji-parse-parse-http.modal.run";
const TOKEN_ID = "test-token-id";
const TOKEN_SECRET = "test-token-secret";

function makeProvider(timeoutMs = 30_000) {
  return new ModalParseProvider({
    url: MODAL_URL,
    tokenId: TOKEN_ID,
    tokenSecret: TOKEN_SECRET,
    timeoutMs,
  });
}

const input = {
  filename: "test.pdf",
  mimeType: "application/pdf",
  fileBuffer: Buffer.from("fake-pdf-content"),
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number) {
  return new Response(body, { status });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ModalParseProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns parsed response on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ markdown: "# Hello", pages: 1, ocr_skipped: false }),
    );

    const provider = makeProvider();
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# Hello");
    expect(result.pages).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on transient urlopen error and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        textResponse('{"error":"<urlopen error [Errno -2] ...>"}', 422),
      )
      .mockResolvedValueOnce(
        jsonResponse({ markdown: "# Retry worked", pages: 1, ocr_skipped: false }),
      );
    globalThis.fetch = mockFetch;

    const provider = makeProvider();
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# Retry worked");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 502 and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(textResponse("Bad Gateway", 502))
      .mockResolvedValueOnce(
        jsonResponse({ markdown: "# OK", pages: 1, ocr_skipped: false }),
      );
    globalThis.fetch = mockFetch;

    const provider = makeProvider();
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# OK");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on connection error and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(
        jsonResponse({ markdown: "# Reconnected", pages: 2, ocr_skipped: true }),
      );
    globalThis.fetch = mockFetch;

    const provider = makeProvider();
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# Reconnected");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-transient 400 error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      textResponse("Bad Request: invalid file", 400),
    );

    const provider = makeProvider();
    await expect(provider.parse(input)).rejects.toThrow("parse 400 (modal)");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws after retry exhaustion", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        textResponse('{"error":"<urlopen error [Errno -2]>"}', 422),
      )
      .mockResolvedValueOnce(
        textResponse('{"error":"<urlopen error [Errno -2]>"}', 422),
      );
    globalThis.fetch = mockFetch;

    const provider = makeProvider();
    await expect(provider.parse(input)).rejects.toThrow("parse 422 (modal)");
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry = 2 attempts
  });

  it("follows 303 redirect polling", async () => {
    // URL resolution adds a trailing slash: new URL("?param", "https://host") → "https://host/?param"
    const pollUrl = `${MODAL_URL}/?__modal_function_call_id=fc-123`;
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { Location: "?__modal_function_call_id=fc-123" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ markdown: "# Polled", pages: 3, ocr_skipped: false }),
      );
    globalThis.fetch = mockFetch;

    const provider = makeProvider();
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# Polled");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should be GET to the poll URL
    const secondCall = mockFetch.mock.calls[1]!;
    expect(secondCall[0]).toBe(pollUrl);
    expect(secondCall[1]?.method).toBe("GET");
  });
});
