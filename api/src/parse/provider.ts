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

export interface CoordinateExtractionResult {
  extracted: Record<string, { value: string | null; page?: number; error?: string }>;
  has_text_layer: boolean;
  warning?: string;
}

export interface ParseProvider {
  parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse>;

  /** Extract text at PDF coordinates. Optional — not all providers support it. */
  extractCoordinates?(input: {
    fileBuffer: Buffer;
    mappings: Record<string, { page: number; x: number; y: number; w: number; h: number }>;
  }): Promise<CoordinateExtractionResult>;
}
