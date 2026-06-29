/**
 * Azure Document Intelligence provider tests (PB-5).
 *
 * The Azure REST API is mocked end-to-end (submit → 202 + Operation-Location,
 * then poll → running → succeeded) so the driver's request shape, polling, and
 * markdown pass-through are verified without a live key. Live-key validation
 * against a real Azure resource is pending (see PB-3 harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AzureDocIntelProvider } from "./azure-doc-intel";
import { createParseDriver, hasParseDriver } from "../drivers";

const ENDPOINT = "https://my-di.cognitiveservices.azure.com";
const API_KEY = "test-subscription-key";
const POLL_URL =
  `${ENDPOINT}/documentintelligence/documentModels/prebuilt-layout/` +
  `analyzeResults/op-123?api-version=2024-11-30`;

const input = {
  filename: "scan.pdf",
  mimeType: "application/pdf",
  fileBuffer: Buffer.from("fake pdf bytes"),
};

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AzureDocIntelProvider.parse", () => {
  it("submits the document and returns the polled markdown content", async () => {
    // 1. submit → 202 with Operation-Location header
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 202, headers: { "Operation-Location": POLL_URL } }),
    );
    // 2. first poll → still running
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "running" }));
    // 3. second poll → succeeded with markdown
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: "succeeded",
        analyzeResult: {
          content: "# Heading\n\nBody text from Azure layout.",
          pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
        },
      }),
    );

    const provider = new AzureDocIntelProvider({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      pollIntervalMs: 0,
    });
    const result = await provider.parse(input);

    expect(result.markdown).toBe("# Heading\n\nBody text from Azure layout.");
    expect(result.pages).toBe(2);
    expect(result.ocr_skipped).toBe(false);
    expect(result.engine).toBe("azure-document-intel");

    // The submit call hits the prebuilt-layout analyze endpoint with the
    // markdown output format and the subscription-key header.
    const [submitUrl, submitInit] = fetchMock.mock.calls[0]!;
    expect(submitUrl).toContain(
      "/documentintelligence/documentModels/prebuilt-layout:analyze",
    );
    expect(submitUrl).toContain("outputContentFormat=markdown");
    expect(submitUrl).toContain("api-version=2024-11-30");
    expect(submitInit.method).toBe("POST");
    expect(submitInit.headers["Ocp-Apim-Subscription-Key"]).toBe(API_KEY);
    expect(JSON.parse(submitInit.body as string)).toEqual({
      base64Source: input.fileBuffer.toString("base64"),
    });

    // The poll call uses the Operation-Location URL and the same key header.
    const [polledUrl, pollInit] = fetchMock.mock.calls[1]!;
    expect(polledUrl).toBe(POLL_URL);
    expect(pollInit.headers["Ocp-Apim-Subscription-Key"]).toBe(API_KEY);
  });

  it("throws when the analyze operation fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 202, headers: { "Operation-Location": POLL_URL } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: { message: "InvalidContent" } }),
    );

    const provider = new AzureDocIntelProvider({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      pollIntervalMs: 0,
    });
    await expect(provider.parse(input)).rejects.toThrow(/analyze failed: InvalidContent/);
  });

  it("throws on a non-202 submit response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad key" }, { status: 401 }));

    const provider = new AzureDocIntelProvider({ endpoint: ENDPOINT, apiKey: API_KEY });
    await expect(provider.parse(input)).rejects.toThrow(/analyze 401/);
  });

  it("throws when a succeeded operation returns no markdown", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 202, headers: { "Operation-Location": POLL_URL } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "succeeded", analyzeResult: { content: "" } }),
    );

    const provider = new AzureDocIntelProvider({
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      pollIntervalMs: 0,
    });
    await expect(provider.parse(input)).rejects.toThrow(/no markdown content/);
  });

  it("requires endpoint and apiKey", () => {
    expect(() => new AzureDocIntelProvider({ endpoint: "", apiKey: API_KEY })).toThrow(
      /endpoint is required/,
    );
    expect(() => new AzureDocIntelProvider({ endpoint: ENDPOINT, apiKey: "" })).toThrow(
      /apiKey is required/,
    );
  });
});

describe("driver registry — azure-document-intel", () => {
  it("registers a driver under the azure-document-intel slug", () => {
    expect(hasParseDriver("azure-document-intel")).toBe(true);
  });

  it("createParseDriver builds an AzureDocIntelProvider from a resolved payload", () => {
    const driver = createParseDriver({
      provider: "azure-document-intel",
      base_url: ENDPOINT,
      api_key: API_KEY,
    });
    expect(driver).toBeInstanceOf(AzureDocIntelProvider);
  });

  it("returns null is avoided — a configured payload yields a real provider", () => {
    const driver = createParseDriver({
      provider: "azure-document-intel",
      model: "prebuilt-layout",
      base_url: ENDPOINT,
      api_key: API_KEY,
      config: { api_version: "2024-11-30" },
    });
    expect(driver).not.toBeNull();
  });
});
