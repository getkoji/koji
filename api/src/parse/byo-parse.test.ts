/**
 * BYO-parse hook tests (oss-267 / PB-2).
 *
 * Verifies the keystone guardrail: the parse factory's `tenantHeavy` hook is
 * additive and dormant. When a tenant-resolved heavy provider is supplied it
 * replaces the default heavy provider; when it's absent the system default
 * (docker / modal) is used unchanged. Also verifies the driver registry is
 * empty today, so resolution always falls back to the default until a vendor
 * driver lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ParseProvider, ParseResponse } from "./provider";

// Mock the document classifier so we control routing deterministically.
vi.mock("./classify", () => ({ classifyDocument: vi.fn() }));
// Mock the default heavy backend so we can assert whether it was used.
const defaultHeavyParse = vi.fn();
vi.mock("./docker", () => ({
  DockerParseProvider: vi.fn().mockImplementation(() => ({ parse: defaultHeavyParse })),
}));

import { classifyDocument } from "./classify";
import { createParseProvider } from "./factory";
import { createParseDriver, hasParseDriver } from "./drivers";

const mockClassify = vi.mocked(classifyDocument);

const heavyResponse: ParseResponse = {
  markdown:
    "# Scanned doc\n\nOCR content from a heavy provider with enough words to pass the " +
    "corruption heuristic threshold of fifty tokens minimum across the whole document body.",
  pages: 4,
  ocr_skipped: false,
  engine: "docling",
};

const dockerConfig = { backend: "docker" as const, dockerUrl: "http://parse:8000" };
const input = {
  filename: "scan.pdf",
  mimeType: "application/pdf",
  fileBuffer: Buffer.from("fake pdf"),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Disable the ChunkedParseProvider wrapper so routing is exercised directly.
  process.env.KOJI_CHUNK_PARSE_THRESHOLD = "0";
});

describe("createParseProvider — tenantHeavy hook", () => {
  it("routes the heavy path to the tenant provider when tenantHeavy is supplied", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    const tenantHeavy: ParseProvider = { parse: vi.fn().mockResolvedValue(heavyResponse) };

    const provider = await createParseProvider(dockerConfig, { tenantHeavy });
    const result = await provider.parse(input);

    expect(tenantHeavy.parse).toHaveBeenCalledWith(input);
    expect(defaultHeavyParse).not.toHaveBeenCalled();
    expect(result.engine).toBe("docling");
  });

  it("falls back to the default heavy provider when no tenantHeavy is supplied", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    defaultHeavyParse.mockResolvedValue(heavyResponse);

    const provider = await createParseProvider(dockerConfig);
    await provider.parse(input);

    expect(defaultHeavyParse).toHaveBeenCalledWith(input);
  });

  it("falls back to the default heavy provider when tenantHeavy is null", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    defaultHeavyParse.mockResolvedValue(heavyResponse);

    const provider = await createParseProvider(dockerConfig, { tenantHeavy: null });
    await provider.parse(input);

    expect(defaultHeavyParse).toHaveBeenCalledWith(input);
  });
});

describe("createParseDriver — registry is dormant", () => {
  it("returns null for an unregistered provider (no drivers ship in PB-2)", () => {
    const driver = createParseDriver({ provider: "mistral-ocr", model: "mistral-ocr-latest" });
    expect(driver).toBeNull();
  });

  it("hasParseDriver is false for every provider slug today", () => {
    for (const p of ["mistral-ocr", "azure-document-intel", "textract", "google-docai"]) {
      expect(hasParseDriver(p)).toBe(false);
    }
  });
});
