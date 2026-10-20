/**
 * Per-tenant parse provider wiring tests (oss-274 / PB-10).
 *
 * These exercise the two ingestion-side helpers that decide which parse
 * provider a document is processed with:
 *
 *  - `readParseProviderPin` — pulls a pipeline's pinned parse endpoint id from
 *    its config_json (PB-9's "Override parse engine").
 *  - `buildEffectiveParseProvider` — the dormant-until-configured guarantee:
 *    with no resolved tenant provider (every tenant today), it returns the
 *    EXACT default provider instance, so behavior is identical to pre-BYO-parse.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  readParseProviderPin,
  buildEffectiveParseProvider,
} from "./process";
import type { ParseConfig } from "../parse/factory";
import type { ParseProvider } from "../parse/provider";

const dockerConfig: ParseConfig = { backend: "docker", dockerUrl: "http://parse:8000" };
const defaultProvider: ParseProvider = { parse: async () => ({ markdown: "", pages: 0, ocr_skipped: false, engine: "docling" }) };
const tenantProvider: ParseProvider = { parse: async () => ({ markdown: "", pages: 0, ocr_skipped: false, engine: "docling" }) };

/** Providers that announce which slot served a document, so a test can tell
 *  the tenant's vendor apart from the deployment default. */
const namedProvider = (engine: string): ParseProvider => ({
  parse: async () => ({ markdown: `parsed by ${engine}`, pages: 1, ocr_skipped: false, engine }),
});

beforeEach(() => {
  // Skip the chunk wrapper so the returned provider is the SmartParseProvider.
  process.env.KOJI_CHUNK_PARSE_THRESHOLD = "0";
});

describe("readParseProviderPin", () => {
  it("reads parse_provider_id from config_json", () => {
    expect(readParseProviderPin({ parse_provider_id: "pe_42" })).toBe("pe_42");
  });

  it("returns null when absent / empty / wrong type / non-object", () => {
    expect(readParseProviderPin({})).toBeNull();
    expect(readParseProviderPin({ parse_provider_id: "" })).toBeNull();
    expect(readParseProviderPin({ parse_provider_id: 123 })).toBeNull();
    expect(readParseProviderPin(null)).toBeNull();
    expect(readParseProviderPin(undefined)).toBeNull();
    expect(readParseProviderPin("nope")).toBeNull();
  });
});

describe("buildEffectiveParseProvider — dormant-until-configured", () => {
  it("returns the EXACT default provider when nothing resolves", async () => {
    const result = await buildEffectiveParseProvider(dockerConfig, defaultProvider, null);
    expect(result).toBe(defaultProvider); // identity — zero behavior change
  });

  it("returns the default provider when there is no parse config to rebuild from", async () => {
    const result = await buildEffectiveParseProvider(null, defaultProvider, {
      provider: tenantProvider,
      kind: "markdown",
    });
    expect(result).toBe(defaultProvider);
  });
});

describe("buildEffectiveParseProvider — slot selection", () => {
  it("builds a fresh provider (not the default) for a markdown tenant provider", async () => {
    const result = await buildEffectiveParseProvider(dockerConfig, defaultProvider, {
      provider: tenantProvider,
      kind: "markdown",
    });
    expect(result).not.toBe(defaultProvider);
    expect(typeof result.parse).toBe("function");
  });

  it("builds a fresh provider (not the default) for a structured tenant provider", async () => {
    const result = await buildEffectiveParseProvider(dockerConfig, defaultProvider, {
      provider: tenantProvider,
      kind: "structured",
    });
    expect(result).not.toBe(defaultProvider);
    expect(typeof result.parse).toBe("function");
  });

  // ── oss-560: a structured endpoint must not vacate the heavy slot ──
  //
  // oss-536 reclassified the cell-emitting drivers (Doc AI, Textract) from
  // `markdown` to `structured`. That moved a configured endpoint out of
  // `tenantHeavy`, and an empty heavy slot falls back to the deployment
  // default — Modal on the hosted platform. Scanned documents a tenant had
  // been sending to their own vendor silently started billing through the
  // platform's backend instead. The assertions above could not catch it:
  // "not the default provider" is true either way.
  it("routes a SCANNED document to the tenant's structured endpoint, not the deployment default", async () => {
    const tenantVendor = namedProvider("tenant-docai");
    const deploymentDefault = namedProvider("deployment-default-modal");

    const result = await buildEffectiveParseProvider(dockerConfig, deploymentDefault, {
      provider: tenantVendor,
      kind: "structured",
    });

    // A non-PDF is unambiguously heavy-path: no text layer to route digitally.
    const parsed = await result.parse({
      filename: "scan.png",
      mimeType: "image/png",
      fileBuffer: Buffer.from("not-a-pdf"),
    });

    expect(parsed.engine).toBe("tenant-docai");
    expect(parsed.engine).not.toBe("deployment-default-modal");
  });

  it("still routes a scanned document to a markdown tenant endpoint", async () => {
    const tenantVendor = namedProvider("tenant-markdown");
    const result = await buildEffectiveParseProvider(dockerConfig, namedProvider("deployment-default-modal"), {
      provider: tenantVendor,
      kind: "markdown",
    });
    const parsed = await result.parse({
      filename: "scan.png",
      mimeType: "image/png",
      fileBuffer: Buffer.from("not-a-pdf"),
    });
    expect(parsed.engine).toBe("tenant-markdown");
  });

  it("leaves the deployment default serving scans when NO tenant endpoint resolves", async () => {
    // The dormant guarantee: an unconfigured tenant keeps the default backend.
    const deploymentDefault = namedProvider("deployment-default-modal");
    const result = await buildEffectiveParseProvider(dockerConfig, deploymentDefault, null);
    expect(result).toBe(deploymentDefault);
  });
});
