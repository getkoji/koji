/**
 * Mistral OCR parse provider (PB-4) — a BYO-parse heavy provider that calls
 * Mistral's OCR API and returns markdown.
 *
 * Mistral OCR is **markdown-native**: each page comes back with a `markdown`
 * field already containing text + tables + image references, so this driver is
 * a near pass-through — it concatenates per-page markdown and maps the usage
 * info onto Koji's `ParseResponse`. It does NOT populate `chunks` / `bbox`
 * (per the PB-1 contract, the markdown-native path leaves provenance sparse;
 * the structured providers PB-6/7/8 carry geometry instead).
 *
 * Credentials are never read from a raw env var. The API key arrives already
 * decrypted on the `ParseEndpointPayload` (resolved by
 * `resolveTenantParseProvider` from the tenant's `parse_endpoints` row and
 * decrypted at call time via `crypto/envelope`) — mirroring the BYO-model rule
 * in `extract/resolve-endpoint.ts`. The driver is constructed by the registry
 * in `drivers.ts`; it has no env-var fallback.
 *
 * API reference: POST {base_url}/v1/ocr with a base64 data-URI document. See
 * https://docs.mistral.ai/capabilities/document/ for the request/response shape.
 */

import type { ParseProvider, ParseResponse } from "../provider";
import type { ParseEndpointPayload } from "../resolve-tenant-parse";

const DEFAULT_BASE_URL = "https://api.mistral.ai";
const DEFAULT_MODEL = "mistral-ocr-latest";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — large scanned PDFs

/** Per-page object in the Mistral OCR response. */
interface MistralOcrPage {
  index?: number;
  markdown?: string;
}

/** Shape of the Mistral `/v1/ocr` JSON response (fields we consume). */
interface MistralOcrResponse {
  pages?: MistralOcrPage[];
  model?: string;
  usage_info?: {
    pages_processed?: number;
    doc_size_bytes?: number;
  };
}

export class MistralOcrProvider implements ParseProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(payload: ParseEndpointPayload, opts?: { timeoutMs?: number }) {
    if (!payload.api_key) {
      throw new Error(
        "MistralOcrProvider: a decrypted api_key is required on the parse " +
          "endpoint payload (configure a Mistral OCR key in the Parse Catalog).",
      );
    }
    this.apiKey = payload.api_key;
    this.model = payload.model || DEFAULT_MODEL;
    // Trim a trailing slash so we can append `/v1/ocr` cleanly.
    this.baseUrl = (payload.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const { mimeType, fileBuffer } = input;
    const base64 = fileBuffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${base64}`;

    // Mistral takes images via `image_url` and everything else (PDFs, etc.)
    // via `document_url`. Both accept a base64 data URI.
    const document = mimeType.startsWith("image/")
      ? { type: "image_url" as const, image_url: dataUri }
      : { type: "document_url" as const, document_url: dataUri };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/ocr`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          document,
          // We only need the linearized markdown — skip the (large) inline
          // image base64 payloads.
          include_image_base64: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(
          `MistralOcrProvider: request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `MistralOcrProvider: request failed: ${(err as Error).message ?? String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `MistralOcrProvider: OCR ${resp.status}: ${body.slice(0, 300) || "(empty body)"}`,
      );
    }

    const result = (await resp.json()) as MistralOcrResponse;
    const pages = result.pages ?? [];
    if (pages.length === 0) {
      throw new Error("MistralOcrProvider: OCR response contained no pages");
    }

    // Markdown-native pass-through: stitch per-page markdown in page order.
    const markdown = pages
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((p) => p.markdown ?? "")
      .join("\n\n")
      .trim();

    if (!markdown) {
      throw new Error("MistralOcrProvider: OCR response contained no markdown");
    }

    const pageCount = result.usage_info?.pages_processed ?? pages.length;

    return {
      markdown,
      pages: pageCount,
      // Mistral always runs OCR on what it's given — text was produced, not
      // skipped.
      ocr_skipped: false,
      engine: "mistral-ocr",
    };
  }
}
