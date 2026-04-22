/**
 * Docker parse provider — talks to the sidecar `koji-parse` container
 * over HTTP (multipart). This is the default for self-hosted deploys
 * and the dev cluster.
 *
 * Behavior is a verbatim lift of the previous inline `callParse` helper
 * in `ingestion/process.ts`: same URL env var, same multipart payload,
 * same error shape. Do not add retries / timeouts / headers here without
 * updating the callers that match on the error message.
 */

import type { ParseProvider, ParseResponse } from "./provider";

const PARSE_URL = process.env.KOJI_PARSE_URL ?? "http://koji-parse:9410";

interface RawParseResponse {
  markdown: string;
  pages?: number;
  ocr_skipped?: boolean;
}

export class DockerParseProvider implements ParseProvider {
  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const { filename, mimeType, fileBuffer } = input;
    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: mimeType }), filename);
    const resp = await fetch(`${PARSE_URL}/parse`, { method: "POST", body: form });
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
    };
  }
}
