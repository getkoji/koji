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
});
