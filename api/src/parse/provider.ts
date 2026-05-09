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

export interface PageAnalysis {
  page: number;
  page_label: number | null;
  page_of: number | null;
  content_preview: string;
  text_density: number;
  text_chars: number;
  bold_headings: Array<{ text: string; y: number; size: number }>;
  tables: Array<{ y: number; h: number; cols: number; header: string }>;
  table_count: number;
  horizontal_rules: number[];
  image_ratio: number;
  form_numbers: string[];
  has_dollar_amounts: boolean;
  has_dates: boolean;
  blank_bottom_ratio: number;
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

  /** Render a PDF region as a base64 PNG image. Used for vision LLM calls. */
  renderRegion?(input: {
    fileBuffer: Buffer;
    page: number;
    x: number; y: number; w: number; h: number;
    scale?: number;
  }): Promise<{ image_base64: string; width: number; height: number }>;

  /** Extract the first ~200 chars from each page. Used for split boundary detection. */
  pageHeaders?(input: {
    fileBuffer: Buffer;
  }): Promise<{ pages: number; headers: Array<{ page: number; header_text: string }> }>;

  /** Rich structural analysis per page — page numbers, text density, tables, headings, etc. */
  analyzePages?(input: {
    fileBuffer: Buffer;
  }): Promise<{ pages: number; data: PageAnalysis[] }>;

  /** Slice a page range from a PDF into a new PDF (base64). */
  slicePdf?(input: {
    fileBuffer: Buffer;
    startPage: number;
    endPage: number;
  }): Promise<{ pdf_base64: string; pages: number; byte_size: number }>;
}
