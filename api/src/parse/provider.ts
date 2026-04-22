/**
 * Parse provider interface — abstracts the document → markdown step.
 *
 * Default implementation: DockerParseProvider (multipart POST to the
 * sidecar `koji-parse` container). Platform can swap in a Modal-hosted
 * provider for the cloud tier (see platform-60).
 */

export interface ParseResponse {
  markdown: string;
  pages: number | null;
  ocr_skipped: boolean;
}

export interface ParseProvider {
  parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse>;
}
