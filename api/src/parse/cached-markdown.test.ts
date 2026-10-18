import { describe, it, expect } from "vitest";
import { pagedCachedMarkdown } from "./cached-markdown";
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
