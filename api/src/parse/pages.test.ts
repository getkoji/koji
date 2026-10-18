import { describe, it, expect } from "vitest";
import { PAGE_SEPARATOR, joinPages, splitPages, pagesFromPieces, withoutPageBreaks } from "./pages";

describe("the page contract of parse markdown", () => {
  it("joins pages with the page break, one piece per page", () => {
    const md = joinPages(["one", "two", "three"]);
    expect(md).toBe(`one${PAGE_SEPARATOR}two${PAGE_SEPARATOR}three`);
    expect(splitPages(md)).toEqual(["one", "two", "three"]);
  });

  it("keeps a slot for a page with no text, so piece k is page k", () => {
    const md = joinPages(["", "two", "", "four"]);
    expect(splitPages(md)).toEqual(["", "two", "", "four"]);
    // A leading empty page is a leading break — never trimmed away.
    expect(md.startsWith(PAGE_SEPARATOR)).toBe(true);
  });

  it("is the empty string when no page has text", () => {
    expect(joinPages(["", "  ", "\n"])).toBe("");
  });

  it("keeps page text byte for byte", () => {
    expect(splitPages(joinPages(["  a\n", "b  "]))).toEqual(["  a\n", "b  "]);
  });

  it("groups page-numbered pieces onto pages 1..pageCount", () => {
    const md = pagesFromPieces(
      [
        { page: 1, text: "a" },
        { page: 1, text: "b" },
        { page: 3, text: "c" },
      ],
      5,
    );
    expect(splitPages(md)).toEqual(["a\n\nb", "", "c", "", ""]);
  });

  it("never drops a piece on a page past the stated count", () => {
    const md = pagesFromPieces([{ page: 4, text: "late" }], 2);
    expect(splitPages(md)).toEqual(["", "", "", "late"]);
  });

  it("removes page breaks and empty pages to give the unpaged shape", () => {
    expect(withoutPageBreaks(joinPages(["a", "", "b"]))).toBe("a\n\nb");
  });
});
