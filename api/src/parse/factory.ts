/**
 * ParseProvider factory — pick a backend from injected config.
 *
 * `docker` is the OSS default (talks to the sidecar `koji-parse` container).
 * `modal` routes to a Modal-hosted Docling service used by the hosted-cloud
 * tier; see `modal.ts` for the 303-polling + proxy-auth details.
 *
 * The configured backend is always wrapped with `SmartParseProvider`, which
 * routes digital PDFs to `DigitalPdfProvider` (in-process pdfjs-dist) and
 * everything else (scanned PDFs, images, DOCX/HTML/PPTX) to the heavy
 * backend. Large PDFs are then chunked via `ChunkedParseProvider`.
 *
 * Config is injected so the same factory works under Node (where `index.ts`
 * reads `process.env`) and under Cloudflare Workers (where the entry point
 * reads `env.*` bindings). The providers themselves still allow constructor-
 * less instantiation (falling back to `process.env`) for the Node dev-server
 * path, but the hosted Worker must pass config explicitly.
 */

import type { ParseProvider } from "./provider";
import { DockerParseProvider } from "./docker";
import { ModalParseProvider } from "./modal";
import { ChunkedParseProvider } from "./chunked";
import { DigitalPdfProvider } from "./digital-pdf";
import { SmartParseProvider } from "./smart";

export type ParseBackend = "docker" | "modal";

export interface ParseConfig {
  backend: ParseBackend;
  /** Base URL of the sidecar `koji-parse` container — required when
   *  `backend === "docker"`. */
  dockerUrl?: string;
  /** Modal `parse_http` endpoint URL — required when `backend === "modal"`. */
  modalUrl?: string;
  /** Modal proxy-auth Key id (`Modal-Key` header). */
  modalTokenId?: string;
  /** Modal proxy-auth Secret (`Modal-Secret` header). */
  modalTokenSecret?: string;
  /** Modal request timeout in ms. Defaults to 10 min (L4 cold start + full OCR). */
  modalTimeoutMs?: number;
}

/** Optional per-call overrides for {@link createParseProvider}. */
export interface ParseProviderOptions {
  /**
   * A tenant-resolved heavy parse provider (from
   * `resolveTenantParseProvider`). When present, it replaces the
   * backend-derived default heavy provider inside `SmartParseProvider`,
   * routing scanned PDFs / images / non-PDF formats to the tenant's BYO
   * parse engine. When null/undefined, the default heavy provider is used —
   * so production behavior is unchanged for tenants with no parse endpoint
   * configured.
   */
  tenantHeavy?: ParseProvider | null;
  /**
   * A tenant-resolved *structured* parse provider (from
   * `resolveTenantParse`, when the configured endpoint's driver emits
   * row/column structure — Google Doc AI, Textract, positional). When present,
   * `SmartParseProvider` routes table-heavy docs here (PB-10 doc-type routing)
   * while text-heavy docs keep the markdown/docling path. When null/undefined,
   * doc-type routing is disabled and behavior is unchanged — the content-shape
   * classifier never runs.
   */
  tenantStructured?: ParseProvider | null;
}

export async function createParseProvider(
  config: ParseConfig,
  opts?: ParseProviderOptions,
): Promise<ParseProvider> {
  let heavy: ParseProvider;

  switch (config.backend) {
    case "docker": {
      if (!config.dockerUrl) {
        throw new Error("parse config: dockerUrl is required for the docker backend");
      }
      heavy = new DockerParseProvider({ url: config.dockerUrl });
      break;
    }
    case "modal": {
      heavy = new ModalParseProvider({
        url: config.modalUrl,
        tokenId: config.modalTokenId,
        tokenSecret: config.modalTokenSecret,
        timeoutMs: config.modalTimeoutMs,
      });
      break;
    }
    default: {
      const exhaustive: never = config.backend;
      throw new Error(`Unknown parse backend: ${exhaustive}`);
    }
  }

  // A tenant-resolved BYO parse provider (when configured) replaces the
  // default heavy provider; a tenant-resolved structured provider (when
  // configured) enables PB-10 doc-type routing for table-heavy docs. Otherwise
  // we keep the system default and doc-type routing stays off. This is the
  // BYO-parse hook — inert until a driver + a configured endpoint exist.
  let provider: ParseProvider = new SmartParseProvider(
    new DigitalPdfProvider(),
    opts?.tenantHeavy ?? heavy,
    opts?.tenantStructured ?? null,
  );

  // Wrap with chunked parsing for large PDFs (after SmartParseProvider)
  const chunkThreshold = parseInt(process.env.KOJI_CHUNK_PARSE_THRESHOLD ?? "40", 10);
  if (chunkThreshold > 0) {
    const chunkPages = parseInt(process.env.KOJI_CHUNK_PARSE_PAGES ?? "50", 10);
    provider = new ChunkedParseProvider(provider, {
      threshold: chunkThreshold,
      chunkPages,
    });
  }

  return provider;
}
