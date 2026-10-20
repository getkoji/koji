/**
 * `PositionalStructuredProvider` — the credential-free **structured** parse
 * provider, and the OSS default filler for `SmartParseProvider`'s structured
 * slot.
 *
 * Why it exists: doc-type routing (PB-10) steers table-heavy documents to a
 * provider that preserves cell structure instead of flattening a grid to
 * markdown, because flattening destroys row/column identity. Until now the only
 * providers that could fill that slot were cloud vendors (Google Document AI,
 * AWS Textract), so every deployment without a GCP or AWS account had the
 * structured path permanently dark — and a *digital* PDF never reached a
 * structured provider at all, because source-type routing sends digital PDFs to
 * pdfjs before any vendor sees them.
 *
 * This provider closes that gap with the geometry Koji already has.
 * `extractPositionalPages` (the same pdfjs walk `DigitalPdfProvider` uses) gives
 * exact text-run coordinates; `PositionalCellCanonicalizer` turns them into
 * per-cell units carrying `role: "table_cell"`, `table: { tableId, row, col }`
 * and the cell's own bounding box — the same spine shape the JSON-native vendors
 * emit, with no cloud call, no credentials and no new dependency.
 *
 * Markdown is a *projection* of that spine (`spineToMarkdown`), exactly as it is
 * for the Doc AI and Textract drivers: a cell run is reassembled into one
 * markdown grid, so the text a model sees is rebuilt from the cells rather than
 * from a reading-order flatten.
 *
 * Scope and limits:
 *   - PDFs with a text layer only. `extractPositionalPages` throws for anything
 *     else, and `SmartParseProvider` catches that and falls back to source-type
 *     routing. (`content-shape.ts` already reports anything it cannot sample
 *     geometrically as text-heavy, so a scanned PDF never routes here.)
 *   - Cell structure is *inferred* from x-coordinate clustering, not read from a
 *     vendor's table model. It recovers column identity from geometry; it does
 *     not recover ruling lines or merged-cell spans.
 *
 * Engine-generic: everything here is page geometry. No document category, no
 * field name, no domain vocabulary.
 */

import type { ParseProvider, ParseResponse } from "./provider";
import { extractPositionalPages } from "./digital-pdf";
import { PositionalCellCanonicalizer } from "./positional-chunks";
import { spineToMarkdown } from "./chunk";

export class PositionalStructuredProvider implements ParseProvider {
  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    const { pages, text_map } = await extractPositionalPages(input);

    const chunks = new PositionalCellCanonicalizer().toChunks(pages);

    // Markdown is the spine's projection — table cell runs are reassembled into
    // a grid from their (row, col), so column association survives into the
    // text a model reads. This is the same contract the JSON-native drivers
    // follow (`providers/google-docai.ts`, `providers/textract-canonicalizer.ts`).
    const markdown = spineToMarkdown(chunks);

    // `md_offset`/`md_length` describe positions in a *reading-order* markdown
    // projection, which is not the grid projection above, so stamping them here
    // would point provenance at the wrong offsets. The structured path's
    // provenance comes from the per-cell `bbox` instead (strictly better: it is
    // exact, not a string match), so offsets are deliberately left unset and the
    // offset-free fuzzy path handles the rest.

    return {
      markdown,
      pages: pages.length,
      ocr_skipped: true,
      engine: "positional",
      text_map,
      chunks,
    };
  }
}
