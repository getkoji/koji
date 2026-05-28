/**
 * LiteParse provider — fast, Rust-based document parsing via @llamaindex/liteparse.
 *
 * Runs in-process (no sidecar container). Handles digital PDFs and 50+ other
 * document types. Does NOT run OCR — for scanned documents, use DockerParseProvider
 * or ModalParseProvider instead. The SmartParseProvider handles this routing.
 *
 * The parse() output is converted from LiteParse's spatial format (text items
 * with bounding boxes) to markdown via spatialToMarkdown(), matching the output
 * format that downstream consumers (extractFields, provenance, UI) expect.
 */

import type { ParseProvider, ParseResponse } from "./provider";
import { spatialToMarkdown } from "./spatial-to-markdown";

export class LiteParseProvider implements ParseProvider {
  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    // Dynamic import — if @llamaindex/liteparse isn't installed, this throws
    // and SmartParseProvider catches it, falling back to the heavy provider.
    const { default: LiteParse } = await import("@llamaindex/liteparse");

    const parser = new LiteParse({ quiet: true });
    const result = await parser.parse(input.fileBuffer);

    // Convert spatial output to markdown
    const markdown = spatialToMarkdown(result.pages);

    return {
      markdown,
      pages: result.pages.length,
      ocr_skipped: true, // LiteParse extracts from text layer, never runs OCR
    };
  }
}
