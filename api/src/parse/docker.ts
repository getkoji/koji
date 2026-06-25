/**
 * Docker parse provider — talks to the sidecar `koji-parse` container
 * over HTTP (multipart). This is the default for self-hosted deploys
 * and the dev cluster.
 *
 * Behavior is a verbatim lift of the previous inline `callParse` helper
 * in `ingestion/process.ts`: same URL, same multipart payload, same error
 * shape. Do not add retries / timeouts / headers here without updating the
 * callers that match on the error message.
 */

import type { ParseProvider, ParseResponse } from "./provider";

export interface DockerParseConfig {
  url: string;
}

interface RawParseResponse {
  markdown: string;
  pages?: number;
  ocr_skipped?: boolean;
  text_map?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
}

export class DockerParseProvider implements ParseProvider {
  private readonly url: string;

  constructor(config: DockerParseConfig) {
    this.url = config.url;
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const { filename, mimeType, fileBuffer } = input;
    // See modal.ts — Buffer doesn't unify with DOM's BlobPart under strict
    // Workers type libs; copying into a fresh ArrayBuffer-backed Uint8Array
    // works in both typesets.
    const part = Uint8Array.from(fileBuffer);
    const form = new FormData();
    form.append("file", new Blob([part], { type: mimeType }), filename);
    const resp = await fetch(`${this.url}/parse`, { method: "POST", body: form });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`parse ${resp.status}: ${body.slice(0, 300)}`);
    }
    const result = (await resp.json()) as RawParseResponse;
    if (!result.markdown) throw new Error("parse returned no markdown");
    return {
      markdown: result.markdown,
      pages: result.pages ?? null,
      ocr_skipped: result.ocr_skipped ?? false,
      engine: "docling",
      text_map: result.text_map,
    };
  }

  async pageImages(input: {
    fileBuffer: Buffer;
    filename: string;
    mimeType: string;
    maxPages?: number;
  }): Promise<{ images: string[]; pages: number }> {
    const part = Uint8Array.from(input.fileBuffer);
    const form = new FormData();
    form.append("file", new Blob([part], { type: input.mimeType }), input.filename);
    if (input.maxPages != null) form.append("max_pages", String(input.maxPages));
    const resp = await fetch(`${this.url}/page-images`, { method: "POST", body: form });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`page-images ${resp.status}: ${body.slice(0, 300)}`);
    }
    const result = (await resp.json()) as { images?: string[]; pages?: number };
    return { images: result.images ?? [], pages: result.pages ?? 0 };
  }
}
