import { describe, it, expect } from "vitest";
import { parseReleaseInput } from "./release-input";

describe("parseReleaseInput", () => {
  it("treats an absent body as the release-my-draft flow", () => {
    expect(parseReleaseInput("")).toEqual({ kind: "draft", allowReactivate: false });
    expect(parseReleaseInput("   \n ")).toEqual({ kind: "draft", allowReactivate: false });
  });

  it("releases exactly the YAML supplied under `yaml`", () => {
    expect(parseReleaseInput(JSON.stringify({ yaml: "fields: {}" }))).toEqual({
      kind: "yaml",
      yaml: "fields: {}",
      allowReactivate: false,
    });
  });

  it("accepts `yaml_source`, the classifier sibling's field name", () => {
    // The exact cross-wiring that caused the production incident.
    expect(parseReleaseInput(JSON.stringify({ yaml_source: "fields: {}" }))).toEqual({
      kind: "yaml",
      yaml: "fields: {}",
      allowReactivate: false,
    });
  });

  it("REFUSES a body whose content arrived under an unrecognized key", () => {
    // The P0: this used to fall through to the stored draft and release it.
    const res = parseReleaseInput(JSON.stringify({ content: "fields: {}" }));
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.message).toContain("content");
      expect(res.message).toContain("yaml");
    }
  });

  it("names every unrecognized field so a typo is obvious", () => {
    const res = parseReleaseInput(JSON.stringify({ yamlSource: "x", schema: "y" }));
    expect(res.kind).toBe("invalid");
    if (res.kind === "invalid") {
      expect(res.message).toContain("yamlSource");
      expect(res.message).toContain("schema");
    }
  });

  it("REFUSES malformed JSON instead of releasing the draft", () => {
    expect(parseReleaseInput("{ not json").kind).toBe("invalid");
    expect(parseReleaseInput("fields: {}").kind).toBe("invalid");
  });

  it("refuses a non-object body", () => {
    expect(parseReleaseInput("[1,2]").kind).toBe("invalid");
    expect(parseReleaseInput("null").kind).toBe("invalid");
    expect(parseReleaseInput('"a string"').kind).toBe("invalid");
  });

  it("still releases the draft for a body carrying only control fields", () => {
    // Nothing was substituted for the caller — they said nothing about content.
    expect(parseReleaseInput(JSON.stringify({ allow_reactivate: true }))).toEqual({
      kind: "draft",
      allowReactivate: true,
    });
  });

  it("carries allow_reactivate through with an explicit YAML", () => {
    expect(parseReleaseInput(JSON.stringify({ yaml: "fields: {}", allow_reactivate: true }))).toEqual({
      kind: "yaml",
      yaml: "fields: {}",
      allowReactivate: true,
    });
  });

  it("only honours allow_reactivate when it is literally true", () => {
    for (const v of ["true", 1, "yes", {}]) {
      const res = parseReleaseInput(JSON.stringify({ yaml: "fields: {}", allow_reactivate: v }));
      expect(res.kind === "yaml" && res.allowReactivate).toBe(false);
    }
  });

  it("refuses an empty or non-string yaml rather than falling back", () => {
    expect(parseReleaseInput(JSON.stringify({ yaml: "" })).kind).toBe("invalid");
    expect(parseReleaseInput(JSON.stringify({ yaml: "   " })).kind).toBe("invalid");
    expect(parseReleaseInput(JSON.stringify({ yaml: 42 })).kind).toBe("invalid");
    expect(parseReleaseInput(JSON.stringify({ yaml: null })).kind).toBe("invalid");
  });

  it("never silently substitutes the draft once the caller sent content-bearing keys", () => {
    // The invariant. Any body that mentions content must either use it or fail.
    for (const body of [
      { content: "x" },
      { yml: "x" },
      { yaml: "" },
      { yaml: 5 },
      { yaml_source: null },
    ]) {
      expect(parseReleaseInput(JSON.stringify(body)).kind).toBe("invalid");
    }
  });
});
