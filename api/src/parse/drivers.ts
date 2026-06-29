/**
 * BYO-parse driver registry.
 *
 * Maps a tenant-configured `parse_endpoints.provider` value to a concrete
 * `ParseProvider` implementation. This is the seam where the actual vendor
 * drivers plug in over the next waves:
 *
 *   "mistral-ocr"          → MistralOcrProvider          (near pass-through)
 *   "azure-document-intel" → AzureDocIntelProvider       (markdown via prebuilt-layout)
 *   "textract"             → TextractProvider            (JSON→markdown linearizer)
 *   "google-docai"         → GoogleDocAiProvider         (JSON→markdown linearizer)
 *
 * The registry is intentionally EMPTY today: PB-2 (this change) wires the
 * full resolve → decrypt → create cycle and the factory hook, but ships no
 * drivers. With no registered driver, `createParseDriver` returns null, the
 * resolver returns null, and the parse factory falls back to the system
 * default heavy provider — so production behavior is unchanged until a driver
 * lands. This keeps the BYO-parse surface additive and dormant.
 */

import type { ParseProvider } from "./provider";
import type { ParseEndpointPayload } from "./resolve-tenant-parse";
import { MistralOcrProvider } from "./providers/mistral-ocr";
import { AzureDocIntelProvider } from "./providers/azure-doc-intel";
import { GoogleDocAiProvider } from "./providers/google-docai";
import { TextractProvider } from "./providers/textract";

export type ParseDriverFactory = (payload: ParseEndpointPayload) => ParseProvider;

/**
 * Provider slug → driver factory. Populated in later waves (one PR per
 * vendor driver). Each driver implements the existing `ParseProvider`
 * interface so the consumer (`SmartParseProvider`) needs no changes.
 */
const PARSE_DRIVERS: Record<string, ParseDriverFactory> = {
  "mistral-ocr": (payload) => new MistralOcrProvider(payload),
  // Azure Document Intelligence — `prebuilt-layout` with markdown output
  // (PB-5). Endpoint host arrives as `base_url`; the subscription key as
  // `api_key` (decrypted by the resolver). Model defaults to prebuilt-layout.
  "azure-document-intel": (payload) =>
    new AzureDocIntelProvider({
      endpoint: payload.base_url ?? "",
      apiKey: payload.api_key ?? "",
      model: payload.model,
      apiVersion: typeof payload.config?.api_version === "string"
        ? payload.config.api_version
        : undefined,
    }),
  "google-docai": (payload) => new GoogleDocAiProvider(payload),
  // PB-8: AWS Textract — JSON `Blocks` graph → chunks-with-bbox.
  textract: (payload) => new TextractProvider(payload),
};

/**
 * Build a `ParseProvider` for a resolved (decrypted) parse endpoint, or
 * return null when no driver is registered for the provider. A null return
 * is the inert path: the factory falls back to the default heavy provider.
 */
export function createParseDriver(payload: ParseEndpointPayload): ParseProvider | null {
  const factory = PARSE_DRIVERS[payload.provider];
  if (!factory) {
    console.warn(
      `[resolve-tenant-parse] no driver registered for parse provider ` +
        `"${payload.provider}" — falling back to the default heavy parse provider.`,
    );
    return null;
  }
  return factory(payload);
}

/** Whether a driver exists for a given provider slug. Exported for tests/UI. */
export function hasParseDriver(provider: string): boolean {
  return provider in PARSE_DRIVERS;
}

/**
 * Output class of a parse provider, used by PB-10 doc-type routing to decide
 * which `SmartParseProvider` slot a tenant's resolved provider fills.
 *
 *  - `markdown`   — emits a markdown view (Mistral OCR, Azure DI, docling).
 *                   Fills the `heavy` slot; serves text-heavy docs.
 *  - `structured` — preserves row/column structure / chunks-with-bbox
 *                   (Google Doc AI, Textract, the digital-positional path).
 *                   Fills the `structured` slot; serves table-heavy docs.
 *
 * This is a property of the *vendor output format*, not of any document
 * domain — it never inspects field names or document categories, so it stays
 * inside the engine-generic rule.
 */
export type ParseDriverKind = "markdown" | "structured";

/**
 * Provider slugs whose drivers produce structured (row/column) output. Future
 * structured drivers (PB-6 positional, PB-7 Google Doc AI, PB-8 Textract)
 * register their slug here so doc-type routing places them in the structured
 * slot. Empty-but-named today, matching the dormant driver registry above.
 */
const STRUCTURED_PROVIDERS = new Set<string>([
  // "google-docai",
  // "textract",
]);

/**
 * Classify a provider slug as markdown- or structured-output. Defaults to
 * `markdown` for anything not explicitly listed as structured — the safe slot,
 * since the markdown/docling path is the existing behaviour.
 */
export function parseDriverKind(provider: string): ParseDriverKind {
  return STRUCTURED_PROVIDERS.has(provider) ? "structured" : "markdown";
}
