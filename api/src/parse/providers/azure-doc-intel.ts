/**
 * Azure Document Intelligence parse provider (PB-5).
 *
 * A BYO-parse driver that runs Azure's `prebuilt-layout` model with
 * `outputContentFormat=markdown`, so the service hands back markdown directly
 * — no JSON→markdown linearizer needed (contrast PB-7 Google Document AI and
 * PB-8 AWS Textract, which carry one). The driver is therefore a near
 * pass-through: it submits the document, polls the async operation to
 * completion, and returns `analyzeResult.content` as the parse markdown.
 *
 * Registered under the provider slug `azure-document-intel` in
 * `parse/drivers.ts`. Credentials (endpoint host + subscription key) are
 * resolved per-tenant and decrypted at call time by
 * `resolveTenantParseProvider` — this driver never reads raw env vars.
 *
 * REST shape (Document Intelligence GA, api-version 2024-11-30):
 *
 *   POST {endpoint}/documentintelligence/documentModels/{model}:analyze
 *        ?api-version=<v>&outputContentFormat=markdown
 *     headers: Ocp-Apim-Subscription-Key, Content-Type: application/json
 *     body:    { "base64Source": "<base64 of the file>" }
 *   → 202 Accepted, with the poll URL in the `Operation-Location` header.
 *
 *   GET <Operation-Location>   (same subscription-key header)
 *   → { status: "notStarted"|"running"|"succeeded"|"failed",
 *       analyzeResult: { content: "<markdown>", pages: [...] } }
 *
 * We drive the poll loop ourselves (mirrors `modal.ts`) so timeouts and the
 * failure shape are explicit rather than fetch's default redirect behavior.
 */

import type { ParseProvider, ParseResponse } from "../provider";

/** Default model: the layout model is the markdown-native one. */
const DEFAULT_MODEL = "prebuilt-layout";
/** Default API version — the current GA `analyze` contract. */
const DEFAULT_API_VERSION = "2024-11-30";
/** Total time to wait for the async analyze operation to settle. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — large scans take a while
/** Delay between poll attempts. */
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface AzureDocIntelConfig {
  /**
   * Azure resource endpoint host, e.g.
   * `https://my-di-resource.cognitiveservices.azure.com`. No trailing path.
   */
  endpoint: string;
  /** Subscription key (decrypted at call time by the resolver). */
  apiKey: string;
  /** Document model id. Defaults to `prebuilt-layout` (markdown-native). */
  model?: string;
  /** Service API version. Defaults to the current GA `analyze` version. */
  apiVersion?: string;
  /** Total operation timeout in ms. */
  timeoutMs?: number;
  /** Poll interval in ms. */
  pollIntervalMs?: number;
}

/** Shape of the analyze-operation poll response (only the fields we read). */
interface AnalyzeOperationResult {
  status?: string;
  error?: { code?: string; message?: string };
  analyzeResult?: {
    content?: string;
    pages?: unknown[];
  };
}

export class AzureDocIntelProvider implements ParseProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: AzureDocIntelConfig) {
    if (!config.endpoint) {
      throw new Error("azure-document-intel: endpoint is required");
    }
    if (!config.apiKey) {
      throw new Error("azure-document-intel: apiKey is required");
    }
    // Normalize: strip a trailing slash so URL building is predictable.
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODEL;
    this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const analyzeUrl =
      `${this.endpoint}/documentintelligence/documentModels/` +
      `${encodeURIComponent(this.model)}:analyze` +
      `?api-version=${encodeURIComponent(this.apiVersion)}` +
      `&outputContentFormat=markdown`;

    // 1. Submit the document. Azure accepts the raw bytes base64-encoded under
    //    `base64Source`; this avoids needing a publicly reachable URL.
    const submit = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ base64Source: input.fileBuffer.toString("base64") }),
    });

    if (submit.status !== 202) {
      const body = await submit.text().catch(() => "");
      throw new Error(`azure-document-intel analyze ${submit.status}: ${body.slice(0, 300)}`);
    }

    // The poll URL is returned in the Operation-Location header; it already
    // carries the api-version query param.
    const operationLocation = submit.headers.get("operation-location");
    if (!operationLocation) {
      throw new Error("azure-document-intel: analyze response missing Operation-Location header");
    }

    // 2. Poll until the operation settles or we exceed the timeout.
    const result = await this.poll(operationLocation);

    const markdown = result.analyzeResult?.content ?? "";
    if (!markdown) {
      throw new Error("azure-document-intel: analyze succeeded but returned no markdown content");
    }

    const pages = Array.isArray(result.analyzeResult?.pages)
      ? result.analyzeResult.pages.length
      : null;

    return {
      markdown,
      pages,
      ocr_skipped: false,
      engine: "azure-document-intel",
    };
  }

  private async poll(operationLocation: string): Promise<AnalyzeOperationResult> {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const resp = await fetch(operationLocation, {
        method: "GET",
        headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`azure-document-intel poll ${resp.status}: ${body.slice(0, 300)}`);
      }

      const result = (await resp.json()) as AnalyzeOperationResult;
      const status = (result.status ?? "").toLowerCase();

      if (status === "succeeded") return result;
      if (status === "failed") {
        const msg = result.error?.message ?? "unknown error";
        throw new Error(`azure-document-intel analyze failed: ${msg}`);
      }
      // "notStarted" / "running" → keep polling.

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    throw new Error(
      `azure-document-intel: analyze did not complete within ${this.timeoutMs}ms`,
    );
  }
}
