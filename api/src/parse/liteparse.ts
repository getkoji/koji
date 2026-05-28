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

import type { ParseProvider, ParseResponse, TextMapSegment } from "./provider";
import { spatialToMarkdown } from "./spatial-to-markdown";

export class LiteParseProvider implements ParseProvider {
  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const { default: LiteParse } = await import("@llamaindex/liteparse");

    const parser = new LiteParse({ quiet: true });
    const result = await parser.parse(input.fileBuffer);

    const markdown = spatialToMarkdown(result.pages);

    // Build text_map from LiteParse's spatial data — normalized 0-1 coords
    const text_map: TextMapSegment[] = [];
    for (const page of result.pages) {
      for (const item of page.textItems) {
        text_map.push({
          text: item.text,
          page: page.pageNum,
          x: page.width > 0 ? item.x / page.width : 0,
          y: page.height > 0 ? item.y / page.height : 0,
          w: page.width > 0 ? item.width / page.width : 0,
          h: page.height > 0 ? item.height / page.height : 0,
        });
      }
    }

    return {
      markdown,
      pages: result.pages.length,
      ocr_skipped: true,
      text_map,
    };
  }
}
