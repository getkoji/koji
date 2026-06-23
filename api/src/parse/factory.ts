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

export async function createParseProvider(config: ParseConfig): Promise<ParseProvider> {
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

  let provider: ParseProvider = new SmartParseProvider(
    new DigitalPdfProvider(),
    heavy,
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
