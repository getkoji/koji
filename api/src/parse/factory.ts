/**
 * ParseProvider factory — pick a backend from injected config.
 *
 * `docker` is the OSS default (talks to the sidecar `koji-parse` container).
 * `modal` routes to a Modal-hosted Docling service used by the hosted-cloud
 * tier; see `modal.ts` for the 303-polling + proxy-auth details.
 *
 * When `@llamaindex/liteparse` is installed (optional dep), the factory
 * auto-wraps the configured backend with SmartParseProvider. This routes
 * digital PDFs to LiteParse (sub-second, Rust, in-process) and scanned
 * PDFs to the heavy backend (Docling/Modal, OCR-capable). Disable with
 * KOJI_LITEPARSE=false.
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
import { LiteParseProvider } from "./liteparse";
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

/**
 * Auto-wrap a provider with SmartParseProvider if LiteParse is available.
 * Silently returns the original provider if the native binary isn't installed.
 */
import { createRequire } from "node:module";

function liteparseAvailable(): boolean {
  if (process.env.KOJI_LITEPARSE === "false") return false;
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@llamaindex/liteparse/package.json");
    return true;
  } catch {
    return false;
  }
}

export function createParseProvider(config: ParseConfig): ParseProvider {
  let provider: ParseProvider;

  switch (config.backend) {
    case "docker": {
      if (!config.dockerUrl) {
        throw new Error("parse config: dockerUrl is required for the docker backend");
      }
      provider = new DockerParseProvider({ url: config.dockerUrl });
      break;
    }
    case "modal": {
      provider = new ModalParseProvider({
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

  if (liteparseAvailable()) {
    console.log("[parse] LiteParse detected — enabling smart routing (digital→liteparse, scanned→heavy)");
    return new SmartParseProvider(new LiteParseProvider(), provider);
  }

  return provider;
}
