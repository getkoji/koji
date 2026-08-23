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
// Mock the content-shape classifier so doc-type routing is deterministic.
vi.mock("./content-shape", () => ({ classifyContentShape: vi.fn() }));
// Mock the default heavy backend so we can assert whether it was used.
const defaultHeavyParse = vi.fn();
// The real DockerParseProvider implements pageImages; the mock carries it too so
// the platform-capability fallback (oss-489) is exercised end to end.
const defaultHeavyPageImages = vi.fn();
vi.mock("./docker", () => ({
  DockerParseProvider: vi
    .fn()
    .mockImplementation(() => ({ parse: defaultHeavyParse, pageImages: defaultHeavyPageImages })),
}));

import { classifyDocument } from "./classify";
import { classifyContentShape } from "./content-shape";
import { createParseProvider } from "./factory";
import { createParseDriver, hasParseDriver, parseDriverKind } from "./drivers";

const mockClassify = vi.mocked(classifyDocument);
const mockShape = vi.mocked(classifyContentShape);

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
  // Safe default: text-heavy → never routes to a structured provider unless a
  // test opts into table-heavy explicitly.
  mockShape.mockResolvedValue("text_heavy");
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

  // oss-489: BYO parse replaces text extraction, not the platform's PDF
  // utilities. No BYO driver implements pageImages / analyzePages / slicePdf /
  // extractCoordinates, so before this the classifier's vision tier, split
  // detection, and provenance bboxes silently went dark the moment a tenant
  // configured a parse endpoint.
  it("keeps the platform's page renderer when the tenant provider has none", async () => {
    const tenantHeavy: ParseProvider = { parse: vi.fn().mockResolvedValue(heavyResponse) };
    defaultHeavyPageImages.mockResolvedValue({ images: ["b64"] });

    const provider = await createParseProvider(dockerConfig, { tenantHeavy });

    expect(provider.pageImages).toBeDefined();
    await provider.pageImages!({
      fileBuffer: Buffer.alloc(0),
      filename: "scan.pdf",
      mimeType: "application/pdf",
      maxPages: 1,
    });
    expect(defaultHeavyPageImages).toHaveBeenCalledOnce();
  });

  it("falls back to the default heavy provider when tenantHeavy is null", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    defaultHeavyParse.mockResolvedValue(heavyResponse);

    const provider = await createParseProvider(dockerConfig, { tenantHeavy: null });
    await provider.parse(input);

    expect(defaultHeavyParse).toHaveBeenCalledWith(input);
  });
});

describe("createParseProvider — tenantStructured hook (PB-10)", () => {
  it("routes table-heavy docs to the tenant structured provider", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    mockShape.mockResolvedValue("table_heavy");
    const tenantStructured: ParseProvider = {
      parse: vi.fn().mockResolvedValue({ ...heavyResponse, chunks: [] }),
    };

    const provider = await createParseProvider(dockerConfig, { tenantStructured });
    await provider.parse(input);

    expect(tenantStructured.parse).toHaveBeenCalledWith(input);
    expect(defaultHeavyParse).not.toHaveBeenCalled();
  });

  it("routes text-heavy docs to the default heavy provider even when structured is set", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    mockShape.mockResolvedValue("text_heavy");
    defaultHeavyParse.mockResolvedValue(heavyResponse);
    const tenantStructured: ParseProvider = { parse: vi.fn() };

    const provider = await createParseProvider(dockerConfig, { tenantStructured });
    await provider.parse(input);

    expect(defaultHeavyParse).toHaveBeenCalledWith(input);
    expect(tenantStructured.parse).not.toHaveBeenCalled();
  });

  it("DORMANT: no tenantStructured ⇒ content shape is never classified, default heavy used", async () => {
    mockClassify.mockResolvedValue("scanned_pdf");
    defaultHeavyParse.mockResolvedValue(heavyResponse);

    const provider = await createParseProvider(dockerConfig, { tenantStructured: null });
    await provider.parse(input);

    expect(mockShape).not.toHaveBeenCalled();
    expect(defaultHeavyParse).toHaveBeenCalledWith(input);
  });
});

describe("createParseDriver — registry", () => {
  it("returns null for a provider with no registered driver", () => {
    const driver = createParseDriver({ provider: "no-such-provider", model: "default" });
    expect(driver).toBeNull();
  });

  it("hasParseDriver is false for slugs with no registered driver", () => {
    for (const p of ["no-such-provider"]) {
      expect(hasParseDriver(p)).toBe(false);
    }
  });

  it("hasParseDriver is true for mistral-ocr (PB-4)", () => {
    expect(hasParseDriver("mistral-ocr")).toBe(true);
  });

  it("hasParseDriver is true for azure-document-intel (PB-5)", () => {
    expect(hasParseDriver("azure-document-intel")).toBe(true);
  });

  it("hasParseDriver is true for google-docai (PB-7)", () => {
    expect(hasParseDriver("google-docai")).toBe(true);
  });

  it("builds a TextractProvider for the textract slug (PB-8)", () => {
    expect(hasParseDriver("textract")).toBe(true);
    const driver = createParseDriver({ provider: "textract", region: "us-east-1" });
    expect(driver).not.toBeNull();
    expect(typeof driver?.parse).toBe("function");
  });
});

describe("parseDriverKind — output-class seam", () => {
  it("defaults unknown / markdown providers to the markdown slot", () => {
    expect(parseDriverKind("mistral-ocr")).toBe("markdown");
    expect(parseDriverKind("azure-document-intel")).toBe("markdown");
    expect(parseDriverKind("something-new")).toBe("markdown");
  });
});
