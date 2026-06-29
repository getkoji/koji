/**
 * MistralOcrProvider unit tests (PB-4).
 *
 * The Mistral OCR API is mocked via `globalThis.fetch` — these tests verify
 * the driver's request shaping, markdown stitching, and error handling without
 * hitting the network. Live-key validation against the real API is pending
 * (needs a Mistral key; tracked in the PR).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { MistralOcrProvider } from "./mistral-ocr";
import { createParseDriver, hasParseDriver } from "../drivers";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";

const payload: ParseEndpointPayload = {
  endpoint_id: "ep-1",
  provider: "mistral-ocr",
  model: "mistral-ocr-latest",
  api_key: "sk-test-key",
};

const pdfInput = {
  filename: "scan.pdf",
  mimeType: "application/pdf",
  fileBuffer: Buffer.from("fake-pdf-bytes"),
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const okBody = {
  pages: [
    { index: 1, markdown: "## Page two\n\nSecond page body." },
    { index: 0, markdown: "# Page one\n\nFirst page body." },
  ],
  model: "mistral-ocr-2505",
  usage_info: { pages_processed: 2, doc_size_bytes: 1234 },
};

describe("MistralOcrProvider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns stitched markdown in page order with the mistral-ocr engine", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(okBody));

    const provider = new MistralOcrProvider(payload);
    const result = await provider.parse(pdfInput);

    expect(result.engine).toBe("mistral-ocr");
    expect(result.pages).toBe(2);
    expect(result.ocr_skipped).toBe(false);
    // Pages stitched in ascending index order regardless of array order.
    expect(result.markdown).toBe(
      "# Page one\n\nFirst page body.\n\n## Page two\n\nSecond page body.",
    );
  });

  it("posts to /v1/ocr with bearer auth and a base64 document data URI", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody));
    globalThis.fetch = fetchMock;

    await new MistralOcrProvider(payload).parse(pdfInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-key",
    );
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("mistral-ocr-latest");
    expect(sent.document.type).toBe("document_url");
    expect(sent.document.document_url).toContain(
      `data:application/pdf;base64,${pdfInput.fileBuffer.toString("base64")}`,
    );
  });

  it("uses image_url for image mime types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody));
    globalThis.fetch = fetchMock;

    await new MistralOcrProvider(payload).parse({
      filename: "scan.png",
      mimeType: "image/png",
      fileBuffer: Buffer.from("png-bytes"),
    });

    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.document.type).toBe("image_url");
    expect(sent.document.image_url).toContain("data:image/png;base64,");
  });

  it("honors a base_url override and trims trailing slashes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody));
    globalThis.fetch = fetchMock;

    await new MistralOcrProvider({ ...payload, base_url: "https://proxy.example.com/" }).parse(
      pdfInput,
    );

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://proxy.example.com/v1/ocr",
    );
  });

  it("falls back to pages.length when usage_info is absent", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ pages: [{ index: 0, markdown: "# Only page" }] }),
    );

    const result = await new MistralOcrProvider(payload).parse(pdfInput);
    expect(result.pages).toBe(1);
    expect(result.markdown).toBe("# Only page");
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: "Unauthorized" }, 401),
    );

    await expect(new MistralOcrProvider(payload).parse(pdfInput)).rejects.toThrow(
      /OCR 401/,
    );
  });

  it("throws when the response has no pages", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ pages: [] }));

    await expect(new MistralOcrProvider(payload).parse(pdfInput)).rejects.toThrow(
      /no pages/,
    );
  });

  it("throws at construction when no api_key is present", () => {
    expect(() => new MistralOcrProvider({ provider: "mistral-ocr" })).toThrow(
      /api_key is required/,
    );
  });
});

describe("driver registry — mistral-ocr", () => {
  it("registers a driver under the mistral-ocr slug", () => {
    expect(hasParseDriver("mistral-ocr")).toBe(true);
  });

  it("createParseDriver builds a MistralOcrProvider from a resolved payload", () => {
    const driver = createParseDriver(payload);
    expect(driver).toBeInstanceOf(MistralOcrProvider);
  });
});
