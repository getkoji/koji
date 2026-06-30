/**
 * Extraction-seam helper tests (oss-310).
 *
 * The seam (`resolveParse` → `parseDocument` → `extractDocument`) is the single
 * shared path every surface uses to turn a stored doc + schema into a correct
 * extraction. These are pure unit tests of the seam's control flow:
 *
 *   - `resolveTenantParse` is mocked so resolution is deterministic (no DB,
 *     no decryption, no driver registry) — the REAL `buildEffectiveParseProvider`
 *     runs, so the dormant identity-return guarantee is exercised end to end.
 *   - `getOrParse` is mocked so we control the parse payload and assert the
 *     flat→nested text_map conversion + cache-flag passthrough without a real
 *     parse service.
 *   - `extractFields` is mocked (toProvenanceTextMap stays REAL) so we assert
 *     the seam forwards textMap + chunks and merges parse metadata.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseProvider } from "../parse/provider";
import type { ResolvedTenantParse } from "../parse/resolve-tenant-parse";
import type { ParseConfig } from "../parse/factory";
import type { ModelProvider } from "../extract";
import { DEFAULT_PARSE_FINGERPRINT } from "../parse/cache-fingerprint";

// Control what the tenant resolver "finds".
const resolveTenantParseMock = vi.fn<
  (db: unknown, tenantId: string, opts: { parseProviderId: string | null }) => Promise<ResolvedTenantParse | null>
>();
vi.mock("../parse/resolve-tenant-parse", () => ({
  resolveTenantParse: (db: unknown, tenantId: string, opts: { parseProviderId: string | null }) =>
    resolveTenantParseMock(db, tenantId, opts),
}));

// Override only getOrParse; keep the REAL buildEffectiveParseProvider so the
// dormant identity-return is genuinely exercised by resolveParse.
const getOrParseMock = vi.fn();
vi.mock("./process", async (importActual) => {
  const actual = await importActual<typeof import("./process")>();
  return { ...actual, getOrParse: (...args: unknown[]) => getOrParseMock(...args) };
});

// Override only extractFields; toProvenanceTextMap + types stay real.
const extractFieldsMock = vi.fn();
vi.mock("../extract", async (importActual) => {
  const actual = await importActual<typeof import("../extract")>();
  return { ...actual, extractFields: (...args: unknown[]) => extractFieldsMock(...args) };
});

import { resolveParse, parseDocument, extractDocument } from "./seam";

const dockerConfig: ParseConfig = { backend: "docker", dockerUrl: "http://parse:8000" };
const defaultProvider: ParseProvider = {
  parse: async () => ({ markdown: "default", pages: 1, ocr_skipped: false, engine: "docling" }),
};
const tenantProvider: ParseProvider = {
  parse: async () => ({ markdown: "tenant", pages: 1, ocr_skipped: false, engine: "mistral-ocr" }),
};
const dummyModel = { generate: async () => "" } as unknown as ModelProvider;

const seamDoc = {
  id: "doc_1",
  storageKey: "tenant_1/doc_1.pdf",
  filename: "doc_1.pdf",
  mimeType: "application/pdf",
  contentHash: "hash_abc",
};

beforeEach(() => {
  resolveTenantParseMock.mockReset();
  getOrParseMock.mockReset();
  extractFieldsMock.mockReset();
  // Skip the chunk wrapper so the rebuilt provider is the SmartParseProvider.
  process.env.KOJI_CHUNK_PARSE_THRESHOLD = "0";
});

describe("resolveParse — dormant-until-configured", () => {
  it("returns the EXACT default provider + default fingerprint when parseConfig is null", async () => {
    const { provider, fingerprint } = await resolveParse({} as never, "tenant_1", {
      defaultProvider,
      parseConfig: null,
    });
    expect(provider).toBe(defaultProvider); // identity — zero behavior change
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    expect(resolveTenantParseMock).not.toHaveBeenCalled(); // no config → no resolution attempt
  });

  it("returns the default provider when the tenant has no parse endpoint", async () => {
    resolveTenantParseMock.mockResolvedValue(null);
    const { provider, fingerprint } = await resolveParse({} as never, "tenant_1", {
      defaultProvider,
      parseConfig: dockerConfig,
    });
    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
    expect(resolveTenantParseMock).toHaveBeenCalledWith({}, "tenant_1", { parseProviderId: null });
  });

  it("falls back to the default provider when resolution throws", async () => {
    resolveTenantParseMock.mockRejectedValue(new Error("boom"));
    const { provider, fingerprint } = await resolveParse({} as never, "tenant_1", {
      defaultProvider,
      parseConfig: dockerConfig,
    });
    expect(provider).toBe(defaultProvider);
    expect(fingerprint).toBe(DEFAULT_PARSE_FINGERPRINT);
  });
});

describe("resolveParse — configured provider", () => {
  it("rebuilds a non-default provider + provider-aware fingerprint when one resolves", async () => {
    resolveTenantParseMock.mockResolvedValue({
      provider: tenantProvider,
      kind: "markdown",
      providerSlug: "mistral-ocr",
      endpointId: "pe_42",
      endpointUpdatedAt: "2026-06-27T00:00:00.000Z",
    });
    const { provider, fingerprint } = await resolveParse({} as never, "tenant_1", {
      defaultProvider,
      parseConfig: dockerConfig,
    });
    expect(provider).not.toBe(defaultProvider);
    expect(typeof provider.parse).toBe("function");
    expect(fingerprint).not.toBe(DEFAULT_PARSE_FINGERPRINT);
  });

  it("honors a pinned parseProviderId", async () => {
    resolveTenantParseMock.mockResolvedValue({ provider: tenantProvider, kind: "structured" });
    await resolveParse({} as never, "tenant_1", {
      defaultProvider,
      parseConfig: dockerConfig,
      parseProviderId: "pe_42",
    });
    expect(resolveTenantParseMock).toHaveBeenCalledWith({}, "tenant_1", { parseProviderId: "pe_42" });
  });
});

describe("parseDocument — cache + flat→nested provenance shaping", () => {
  const args = {
    db: {} as never,
    storage: {} as never,
    tenantId: "tenant_1",
    document: seamDoc,
    provider: defaultProvider,
    fingerprint: DEFAULT_PARSE_FINGERPRINT,
  };

  it("surfaces the cached flag and parse metadata from getOrParse", async () => {
    getOrParseMock.mockResolvedValue({
      markdown: "# hello",
      textMap: [],
      engine: "docling",
      chunks: undefined,
      pages: 3,
      ocr_skipped: true,
      cached: true,
    });
    const res = await parseDocument(args);
    expect(res.markdown).toBe("# hello");
    expect(res.cached).toBe(true);
    expect(res.pages).toBe(3);
    expect(res.ocr_skipped).toBe(true);
    expect(res.engine).toBe("docling");
    // An empty text_map yields no provenance (not an empty array).
    expect(res.textMap).toBeUndefined();
  });

  it("converts a flat text_map to the nested provenance shape", async () => {
    getOrParseMock.mockResolvedValue({
      markdown: "INV-1",
      textMap: [{ text: "INV-1", page: 1, x: 10, y: 20, w: 30, h: 8, md_offset: 0, md_length: 5 }],
      engine: "pdfjs",
      pages: 1,
      ocr_skipped: false,
      cached: false,
    });
    const res = await parseDocument(args);
    expect(res.cached).toBe(false);
    expect(res.textMap).toEqual([
      { text: "INV-1", page: 1, bbox: { x: 10, y: 20, w: 30, h: 8 }, md_offset: 0, md_length: 5 },
    ]);
  });

  it("keeps a bbox-less segment (non-finite coords) without crashing", async () => {
    getOrParseMock.mockResolvedValue({
      markdown: "x",
      textMap: [
        { text: "good", page: 1, x: 1, y: 2, w: 3, h: 4 },
        { text: "noco", page: 1, x: NaN, y: NaN, w: NaN, h: NaN },
      ],
      engine: "pdfjs",
      pages: 1,
      ocr_skipped: false,
      cached: false,
    });
    const res = await parseDocument(args);
    expect(res.textMap).toHaveLength(2);
    expect(res.textMap?.[0]?.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(res.textMap?.[1]?.bbox).toBeUndefined(); // survives, just no highlight
    expect(res.textMap?.[1]?.text).toBe("noco");
  });

  it("falls back to DEFAULT_PARSE_FINGERPRINT when an empty fingerprint is passed", async () => {
    getOrParseMock.mockResolvedValue({ markdown: "", textMap: [], pages: 0, ocr_skipped: false, cached: false });
    await parseDocument({ ...args, fingerprint: "" });
    // getOrParse is called positionally; the 6th arg is the fingerprint.
    expect(getOrParseMock.mock.calls[0]![5]).toBe(DEFAULT_PARSE_FINGERPRINT);
  });
});

describe("extractDocument — full seam", () => {
  it("parses, forwards textMap + chunks to extractFields, and merges parse metadata", async () => {
    const chunks = [{ id: "c1" }] as never;
    getOrParseMock.mockResolvedValue({
      markdown: "DOC BODY",
      textMap: [{ text: "DOC", page: 1, x: 1, y: 2, w: 3, h: 4 }],
      engine: "google-docai",
      chunks,
      pages: 2,
      ocr_skipped: false,
      cached: true,
    });
    extractFieldsMock.mockResolvedValue({
      extracted: { invoice_no: "INV-1" },
      validation: { ok: true, issues: [] },
      normalization: { applied: [], warnings: [] },
    });

    const res = await extractDocument({
      db: {} as never,
      storage: {} as never,
      tenantId: "tenant_1",
      document: seamDoc,
      provider: defaultProvider,
      fingerprint: DEFAULT_PARSE_FINGERPRINT,
      schemaDef: { fields: {} },
      modelProvider: dummyModel,
      model: "gpt-4o-mini",
    });

    // extractFields received the NESTED textMap + the chunks (provenance forwarded).
    const callArgs = extractFieldsMock.mock.calls[0]!;
    expect(callArgs[0]).toBe("DOC BODY"); // markdown
    expect(callArgs[4]).toEqual([{ text: "DOC", page: 1, bbox: { x: 1, y: 2, w: 3, h: 4 } }]);
    expect(callArgs[5]).toBe(chunks);

    // Result merges the extraction output with parse metadata.
    expect(res.extracted).toEqual({ invoice_no: "INV-1" });
    expect(res.markdown).toBe("DOC BODY");
    expect(res.engine).toBe("google-docai");
    expect(res.cached).toBe(true);
    expect(res.pages).toBe(2);
    expect(res.ocr_skipped).toBe(false);
  });
});
