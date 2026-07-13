/**
 * Smart parse provider — routes documents to the best parser based on type.
 *
 * Source-type routing (always on):
 * - Digital PDFs → in-process pdfjs (`DigitalPdfProvider`)
 * - Scanned PDFs, images, and non-PDF formats (DOCX, HTML, …) → heavy
 *   provider (Docling via Docker sidecar or Modal)
 *
 * Doc-type routing (PB-10, opt-in): when a tenant has configured a *structured*
 * parse provider (one that preserves row/column structure — Google Doc AI,
 * Textract, positional), table-heavy documents are steered to it instead of the
 * markdown/docling path, because flattening a dec page / schedule / grid to
 * markdown scrambles column association. Text-heavy documents keep the
 * markdown/docling path. The table-heavy vs text-heavy decision is a geometric
 * signal (`content-shape.ts`), not a domain classifier.
 *
 * Dormant by default: with no structured provider configured (every tenant
 * today), `structured` is null and routing is byte-for-byte the previous
 * behaviour — the content-shape classifier is never even invoked, so the hot
 * path pays nothing.
 *
 * Two safety nets so a bad lite-provider parse can't silently poison
 * extraction:
 *
 * 1. Hard fail: if the lite provider throws, fall back to heavy.
 * 2. Soft fail: if the lite provider returns markdown that *looks* corrupt
 *    (mostly 1-2 character fragments, heavy fragmentation), fall back to
 *    heavy. This caught the Cincinnati CinciPak regression where LiteParse
 *    returned text items with scrambled positions and the model silently
 *    consumed the resulting garbage.
 *
 * The structured path has the same safety net: if it throws, we fall through
 * to the source-type routing below (digital → pdfjs, otherwise → heavy).
 *
 * Optional methods (extractCoordinates, renderRegion, pageHeaders,
 * analyzePages, slicePdf) are proxied to the heavy provider.
 */

import type { ParseProvider, ParseResponse } from "./provider";
import { classifyDocument } from "./classify";
import { classifyContentShape } from "./content-shape";
import { resolveMimeType } from "../ingestion/mime";

export class SmartParseProvider implements ParseProvider {
  extractCoordinates?: ParseProvider["extractCoordinates"];
  renderRegion?: ParseProvider["renderRegion"];
  pageImages?: ParseProvider["pageImages"];
  pageHeaders?: ParseProvider["pageHeaders"];
  analyzePages?: ParseProvider["analyzePages"];
  slicePdf?: ParseProvider["slicePdf"];

  constructor(
    private lite: ParseProvider,
    private heavy: ParseProvider,
    /**
     * Optional structured provider for table-heavy docs. Null/undefined (the
     * default) disables doc-type routing entirely — behaviour is identical to
     * pre-PB-10. When set, table-heavy docs route here; text-heavy docs and any
     * structured-path failure fall back to the source-type routing below.
     */
    private structured: ParseProvider | null = null,
  ) {
    if (heavy.extractCoordinates) {
      this.extractCoordinates = heavy.extractCoordinates.bind(heavy);
    }
    if (heavy.renderRegion) {
      this.renderRegion = heavy.renderRegion.bind(heavy);
    }
    if (heavy.pageImages) {
      this.pageImages = heavy.pageImages.bind(heavy);
    }
    if (heavy.pageHeaders) {
      this.pageHeaders = heavy.pageHeaders.bind(heavy);
    }
    if (heavy.analyzePages) {
      this.analyzePages = heavy.analyzePages.bind(heavy);
    }
    if (heavy.slicePdf) {
      this.slicePdf = heavy.slicePdf.bind(heavy);
    }
  }

  async parse(input: {
    filename: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<ParseResponse> {
    // Normalize the MIME once, centrally, before any provider sees it. A bare
    // or invalid stored MIME (e.g. "pdf" instead of "application/pdf") would
    // otherwise hard-fail strict upstream APIs like Google Doc AI's
    // `rawDocument.mime_type` (400 INVALID_ARGUMENT → wrapped as a 502). We
    // upgrade from the claimed value → filename extension → magic bytes, so
    // every downstream provider (pdfjs, docling, Doc AI, Textract, Mistral …)
    // receives a real MIME.
    const resolvedMime = resolveMimeType(
      input.mimeType,
      input.filename,
      input.fileBuffer,
    );
    if (resolvedMime !== input.mimeType) {
      console.log(
        `[smart-parse] ${input.filename}: normalized mimeType "${input.mimeType}" → "${resolvedMime}"`,
      );
      input = { ...input, mimeType: resolvedMime };
    }

    const docType = await classifyDocument(
      input.filename,
      input.mimeType,
      input.fileBuffer,
    );

    // ── Doc-type routing (only when a structured provider is configured) ─────
    // Table-heavy docs go to the structured provider, which preserves cell
    // structure instead of flattening grids to markdown. This block is skipped
    // entirely (no classifier call) when `structured` is null — the default.
    if (this.structured) {
      let shape: "table_heavy" | "text_heavy" = "text_heavy";
      try {
        shape = await classifyContentShape(
          input.filename,
          input.mimeType,
          input.fileBuffer,
        );
      } catch (err) {
        console.warn(
          `[smart-parse] content-shape classification failed for ${input.filename}, treating as text-heavy:`,
          err instanceof Error ? err.message : err,
        );
      }

      if (shape === "table_heavy") {
        console.log(`[smart-parse] ${input.filename}: ${docType}/table_heavy → structured provider`);
        try {
          return await this.structured.parse(input);
        } catch (err) {
          console.warn(
            `[smart-parse] structured provider failed for ${input.filename}, falling back to source-type routing:`,
            err instanceof Error ? err.message : err,
          );
          // fall through to the source-type routing below
        }
      }
    }

    // ── Source-type routing (always on) ──────────────────────────────────────
    // Scanned content, images, and non-PDF formats → heavy (Docling handles
    // OCR + DOCX/HTML/PPTX natively). pdfjs is PDF-only.
    if (docType !== "digital_pdf") {
      console.log(`[smart-parse] ${input.filename}: ${docType} → heavy provider`);
      return this.heavy.parse(input);
    }

    // Digital PDFs → pdfjs first, fall back to heavy on error or on output
    // that looks corrupt.
    console.log(`[smart-parse] ${input.filename}: digital_pdf → pdfjs`);
    let liteResult: ParseResponse;
    try {
      liteResult = await this.lite.parse(input);
    } catch (err) {
      console.warn(
        `[smart-parse] pdfjs failed for ${input.filename}, falling back to heavy provider:`,
        err instanceof Error ? err.message : err,
      );
      return this.heavy.parse(input);
    }

    const corruption = detectCorruption(liteResult.markdown);
    if (corruption) {
      console.warn(
        `[smart-parse] pdfjs output for ${input.filename} looks corrupt (${corruption}), falling back to heavy provider`,
      );
      return this.heavy.parse(input);
    }

    return liteResult;
  }
}

/**
 * Heuristic: does the markdown look like the parser scrambled it?
 *
 * Returns a short reason string when the output looks unusable, or null when
 * it looks fine. Tuned to be quiet on real documents and loud on the kind of
 * fragmentation we saw from the LiteParse regression — output like
 * `"M: FRO er: y numb Polic rage a G or d / an bile mo uto t A ep …"` where
 * most "words" are 1-2 character chunks.
 *
 * - `tokenCount < 50`: too little signal to judge — assume OK (one-page
 *   receipts, mostly-image PDFs with sparse text).
 * - `shortRatio > 0.6 && medianLen < 3`: most tokens are fragments. Real
 *   prose sits around medianLen 4-6 with shortRatio < 0.4.
 * - `longRatio > 0.1`: the *inverse* failure — space-mangled output. Some PDFs
 *   (Type-3 / custom-encoded fonts) carry a text layer whose inter-word spacing
 *   lives in glyph positioning, not space characters. pdfjs reconstructs
 *   spacing from run geometry and drops it entirely on these fonts, emitting
 *   whole phrases as one token ("STATEFARMFIREANDCASUALTYCOMPANY"). The
 *   signature is an abnormal fraction of very long tokens; real prose has almost
 *   none — the longest common English words are ~20 chars and rare (measured
 *   ~21% on the failing doc vs ~0% on clean text). Falling back to the heavy
 *   provider re-extracts via poppler, which resolves spacing at the glyph level.
 *   A rare false positive (a doc genuinely dense in long tokens) is harmless:
 *   the heavy provider still extracts it correctly, just off the fast path. See
 *   oss-400.
 * - `nonPrintableRatio > 0.05`: an *undecodable* text layer. A broken or absent
 *   ToUnicode CMap (PScript5/Distiller custom-encoded fonts) makes pdfjs emit
 *   the font's raw glyph ids — C0 control bytes and 0xFF fill — in place of
 *   characters. The page renders fine but the text is garbage, and it tokenizes
 *   ~3x denser than prose, so left on the fast path it later overflows the
 *   extraction context window. This form slips past both arms above (the failing
 *   doc measured shortRatio 0.54 and longRatio 0.06 — just under each
 *   threshold), so it needs its own check. Decoded text contains essentially
 *   none of these bytes, so a small fraction is a decisive, low-false-positive
 *   signal; the heavy provider re-reads the rendered glyphs via OCR. See oss-435.
 * - lowercase, varied single-letter fragments in any sliding window: *localized*
 *   space-mangling. The three arms above are document-level, so a scrambled dec
 *   page buried in an otherwise-clean 100-page policy washes out below every
 *   threshold (a real 102-page doc measured a whole-doc single-letter ratio of
 *   0.007 while two of its pages were badly mangled — `"The Ci nc i nn at i I n
 *   su ra nc e C o m pa ny"`, `"B L E FOR D E FE N S E C OS T S"`). pdfjs strands
 *   one-letter word fragments on these fonts. We slide a window over the token
 *   stream and fire on the worst one (>15% fragments) when it also holds >=4
 *   distinct fragment letters. Two guards make this word-mangling-specific and
 *   yielded 0 false positives across 1114 clean corpus docs: lowercase-excluding-
 *   "a" drops uppercase table markers (ACORD insurer rows "B/C/D", Y/N flags),
 *   and the distinct-letter floor drops decorative glyph runs that survive as one
 *   repeated letter (bullets "l l l l l", footnote daggers "f f f"). A false
 *   positive only costs a poppler re-parse (correct output, off the fast path).
 *   See oss-445.
 */
export function detectCorruption(markdown: string): string | null {
  // Undecodable text layer — checked first and before the token-count floor: a
  // fully garbled document is still garbage even if it's short.
  if (markdown.length >= 200) {
    let nonPrintable = 0;
    for (let i = 0; i < markdown.length; i++) {
      const c = markdown.charCodeAt(i);
      if (c === 0xfffd || c === 0xff || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d)) {
        nonPrintable++;
      }
    }
    const nonPrintableRatio = nonPrintable / markdown.length;
    if (nonPrintableRatio > 0.05) {
      return `${(nonPrintableRatio * 100).toFixed(0)}% non-printable/control bytes (undecodable text layer)`;
    }
  }

  const stripped = markdown.replace(/[#*`|>\-_]/g, " ");
  const tokens = stripped.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t));
  if (tokens.length < 50) return null;

  const lengths = tokens.map((t) => t.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const shortRatio = tokens.filter((t) => t.length <= 2).length / tokens.length;

  if (shortRatio > 0.6 && median < 3) {
    return `${(shortRatio * 100).toFixed(0)}% tokens are 1-2 chars (median len ${median})`;
  }

  const longRatio = tokens.filter((t) => t.length >= 20).length / tokens.length;
  if (longRatio > 0.1) {
    return `${(longRatio * 100).toFixed(0)}% tokens are >=20 chars (space-mangled text layer)`;
  }

  // Localized space-mangling: slide a window over the token stream and fire on
  // the worst window, so a scrambled page can't hide behind a document-wide
  // average. The signature is a *lowercase, varied* single-letter token: pdfjs
  // strands one-letter fragments of broken words ("The Ci nc i nn at i I n su ra
  // nc e"). Two guards keep this specific to word-mangling, verified against
  // 1114 clean corpus docs (0 false positives):
  //   - lowercase, excluding "a": "a" is the only real one-letter lowercase word,
  //     and this drops uppercase table markers (ACORD insurer rows "B/C/D",
  //     Y/N flags) that are legitimate single letters.
  //   - >= 4 distinct letters in the window: a mangled span spans the alphabet
  //     (measured 10 distinct), while decorative glyph runs that survive as one
  //     repeated letter — bullets rendered "l l l l l", footnote daggers "f f f"
  //     — collapse to 1-2 distinct and are ignored.
  const isFragment = (t: string) =>
    t.length === 1 && t >= "a" && t <= "z" && t !== "a";
  const WINDOW = Math.min(100, tokens.length);
  const counts = new Map<string, number>();
  const bump = (t: string, d: number) => {
    if (!isFragment(t)) return;
    const n = (counts.get(t) ?? 0) + d;
    if (n <= 0) counts.delete(t);
    else counts.set(t, n);
  };
  const total = () => {
    let s = 0;
    for (const v of counts.values()) s += v;
    return s;
  };
  for (let i = 0; i < WINDOW; i++) bump(tokens[i]!, 1);
  const fires = () => total() / WINDOW > 0.15 && counts.size >= 4;
  let hit = fires();
  let hitRatio = total() / WINDOW;
  for (let i = WINDOW; i < tokens.length && !hit; i++) {
    bump(tokens[i]!, 1);
    bump(tokens[i - WINDOW]!, -1);
    if (fires()) {
      hit = true;
      hitRatio = total() / WINDOW;
    }
  }
  if (hit) {
    return `${(hitRatio * 100).toFixed(0)}% single-letter word fragments in a ${WINDOW}-token window (localized space-mangled text)`;
  }

  return null;
}
