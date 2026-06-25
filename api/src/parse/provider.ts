/**
 * Parse provider interface — abstracts the document → markdown step.
 *
 * Default implementation: DockerParseProvider (multipart POST to the
 * sidecar `koji-parse` container). Platform can swap in a Modal-hosted
 * provider for the cloud tier (see platform-60).
 */

/**
 * Identifier for the parser that produced a ParseResponse. Surfaces in API
 * responses and the trace's `parse.summary_json.engine` so bug reports name
 * the actual engine instead of guessing.
 *
 * - `pdfjs`: in-process pdfjs-dist, used for digital PDFs (text-embedded)
 * - `docling`: heavy provider (Docker sidecar or Modal-hosted), used for
 *   scanned PDFs, images, and non-PDF formats (DOCX, HTML, …)
 */
export type ParseEngine = "pdfjs" | "docling";

/** A word/segment with its spatial position on the page. */
export interface TextMapSegment {
  text: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Character offset of this word in the exported markdown (L3 provenance). */
  md_offset?: number;
  /** Character length of this word in the exported markdown (L3 provenance). */
  md_length?: number;
}

export interface ParseResponse {
  markdown: string;
  pages: number | null;
  ocr_skipped: boolean;
  /** Which parser produced this response. */
  engine: ParseEngine;
  /** Per-word spatial positions — used by provenance to resolve bounding boxes. */
  text_map?: TextMapSegment[];
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

  /**
   * Dispatch a parse without waiting for the result. Returns a poll URL
   * if the backend supports async dispatch, or the result directly for
   * fast completions. Used by Inngest step-based flows.
   */
  dispatchParse?(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
    /** Force OCR on the document, bypassing the text-detection heuristic. */
    forceOcr?: boolean;
  }): Promise<{ pollUrl: string } | { result: ParseResponse }>;

  /** Poll a dispatched parse job. Returns null if still processing. */
  pollParse?(pollUrl: string): Promise<ParseResponse | null>;
}
