import { describe, it, expect } from "vitest";
import { pagedCachedMarkdown, pagedCachedParse } from "./cached-markdown";
import { splitPages, withoutPageBreaks } from "./pages";
import type { ParseUnit } from "./chunk";

const unit = (page: number, i: number, text: string): ParseUnit => ({ id: `p${page}-u${i}`, page, text });

// A parse cached before every provider marked pages: the spine knows each
// unit's page, the markdown is one block (`units.map(text).join("\n\n")`).
const spine: ParseUnit[] = [
  unit(1, 0, "Declarations"),
  unit(1, 1, "Named: Example Co"),
  unit(2, 0, "Schedule of forms"),
  unit(4, 0, "Signature page"),
];
const unpaged = spine.map((u) => u.text).join("\n\n");

describe("pagedCachedMarkdown", () => {
  it("re-pages a cached one-block parse from its spine, one piece per page", () => {
    const md = pagedCachedMarkdown({ markdown: unpaged, pages: 5, chunks: spine });
    expect(splitPages(md)).toEqual([
      "Declarations\n\nNamed: Example Co",
      "Schedule of forms",
      "",
      "Signature page",
      "",
    ]);
  });

  it("keeps every character of the cached text", () => {
    const md = pagedCachedMarkdown({ markdown: unpaged, pages: 5, chunks: spine });
    for (const u of spine) expect(md).toContain(u.text);
    expect(withoutPageBreaks(md)).toBe(unpaged);
  });

  it("serves the cached markdown unchanged when the spine's text differs from it", () => {
    // e.g. a vision-OCR escalation overwrote the markdown but not the spine.
    const other = "A different transcription of the same pages";
    expect(pagedCachedMarkdown({ markdown: other, pages: 5, chunks: spine })).toBe(other);
  });

  it("serves the cached markdown unchanged without a spine", () => {
    expect(pagedCachedMarkdown({ markdown: unpaged, pages: 5 })).toBe(unpaged);
    expect(pagedCachedMarkdown({ markdown: unpaged, pages: 5, chunks: [] })).toBe(unpaged);
  });

  it("leaves an already-paged parse alone", () => {
    const paged = pagedCachedMarkdown({ markdown: unpaged, pages: 5, chunks: spine });
    expect(pagedCachedMarkdown({ markdown: paged, pages: 5, chunks: spine })).toBe(paged);
  });

  it("leaves a one-page parse byte-identical", () => {
    const one = [unit(1, 0, "a"), unit(1, 1, "b")];
    expect(pagedCachedMarkdown({ markdown: "a\n\nb", pages: 1, chunks: one })).toBe("a\n\nb");
  });

  it("returns empty markdown as empty", () => {
    expect(pagedCachedMarkdown({ markdown: "", pages: 3, chunks: spine })).toBe("");
    expect(pagedCachedMarkdown({})).toBe("");
  });
});

describe("pagedCachedParse — digital parses cached without blank-page slots", () => {
  // The digital path (pdfjs) used to drop pages with no text: a 4-page document
  // with text on pages 1 and 3 was cached as two pieces, so page 3's text was
  // cited as page 2. Its word map places every word on its page.
  const word = (text: string, page: number, md_offset: number) => ({
    text,
    page,
    x: 0,
    y: 0,
    w: 0.1,
    h: 0.1,
    md_offset,
    md_length: text.length,
  });
  const cached = "Alpha beta\n\n---\n\nGamma";
  const textMap = [word("Alpha", 1, 0), word("beta", 1, 6), word("Gamma", 3, 17)];

  it("puts each piece back on its page, blank pages holding their slots", () => {
    const res = pagedCachedParse({ markdown: cached, pages: 4, text_map: textMap });
    expect(splitPages(res.markdown)).toEqual(["Alpha beta", "", "Gamma", ""]);
    expect(withoutPageBreaks(res.markdown)).toBe(withoutPageBreaks(cached));
  });

  it("moves each word's offset with its piece", () => {
    const res = pagedCachedParse({ markdown: cached, pages: 4, text_map: textMap });
    for (const seg of res.textMap!) {
      const o = seg.md_offset as number;
      expect(res.markdown.slice(o, o + (seg.md_length as number))).toBe(seg.text);
    }
  });

  it("gives a 2-page parse whose second page is blank its trailing slot", () => {
    const res = pagedCachedParse({
      markdown: "Only page one",
      pages: 2,
      text_map: [word("Only", 1, 0)],
    });
    expect(splitPages(res.markdown)).toEqual(["Only page one", ""]);
  });

  it("leaves the parse unchanged when a piece can't be placed with certainty", () => {
    // No located word in the second piece.
    expect(
      pagedCachedParse({ markdown: cached, pages: 4, text_map: [word("Alpha", 1, 0)] }).markdown,
    ).toBe(cached);
    // One piece holding words from two pages is not the old shape.
    expect(
      pagedCachedParse({
        markdown: "Alpha beta",
        pages: 3,
        text_map: [word("Alpha", 1, 0), word("beta", 2, 6)],
      }).markdown,
    ).toBe("Alpha beta");
  });

  it("leaves a parse that already numbers every page alone", () => {
    const full = "a\n\n---\n\nb";
    expect(
      pagedCachedParse({ markdown: full, pages: 2, text_map: [word("a", 1, 0), word("b", 2, 7)] }).markdown,
    ).toBe(full);
  });
});
