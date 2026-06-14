/**
 * Unit tests for `extractFieldOptionsFromSchemaYaml`.
 *
 * The pre-fix implementation regex-matched any indented `key:` followed by
 * `[` and returned those keys as enum options — so schema metadata like
 * `patterns:`, `examples:`, `description:` would leak into the override
 * dropdown. These tests pin the correct behaviour: only `enum`, `options`,
 * and `mappings` blocks contribute, everything else returns `null`.
 */

import { describe, it, expect } from "vitest";
import { extractFieldOptionsFromSchemaYaml } from "./fieldOptions";

describe("extractFieldOptionsFromSchemaYaml", () => {
  it("returns enum values when the field declares `enum`", () => {
    const yaml = `
fields:
  governance:
    type: string
    enum: ["hoa", "condo", "coop"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "governance")).toEqual([
      "hoa",
      "condo",
      "coop",
    ]);
  });

  it("returns options when the field declares the legacy `options` alias", () => {
    const yaml = `
fields:
  community_type:
    type: string
    options: ["monoline", "multiline"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "community_type")).toEqual([
      "monoline",
      "multiline",
    ]);
  });

  it("returns mapping keys when the field declares `mappings`", () => {
    const yaml = `
fields:
  state:
    type: string
    mappings:
      CA: ["California", "Calif", "Cal."]
      NY: ["New York", "NYS"]
      TX: ["Texas", "Tex."]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "state")).toEqual([
      "CA",
      "NY",
      "TX",
    ]);
  });

  it("ignores `patterns` (the regression that motivated this rewrite)", () => {
    const yaml = `
fields:
  unit_address_range:
    type: string
    patterns:
      - regex: "^[0-9]+-[0-9]+$"
      - regex: "^Unit [A-Z]$"
    description: "Range like 1-100 or Unit A"
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "unit_address_range")).toBeNull();
  });

  it("ignores arbitrary metadata keys (description, examples, type, format)", () => {
    const yaml = `
fields:
  primary_address:
    type: string
    description: "The street address"
    examples: ["100 Main St", "200 Elm Ave"]
    format: "free_text"
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "primary_address")).toBeNull();
  });

  it("returns null for fields the schema doesn't declare", () => {
    const yaml = `
fields:
  state:
    type: string
    enum: ["CA", "NY"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "country")).toBeNull();
  });

  it("returns null for invalid YAML instead of throwing", () => {
    const yaml = "fields:\n  bad: [unterminated";
    expect(extractFieldOptionsFromSchemaYaml(yaml, "bad")).toBeNull();
  });

  it("returns null when the source string is empty", () => {
    expect(extractFieldOptionsFromSchemaYaml("", "any_field")).toBeNull();
  });

  it("supports the legacy top-level shape (no `fields:` wrapper)", () => {
    const yaml = `
governance:
  type: string
  enum: ["hoa", "condo"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "governance")).toEqual([
      "hoa",
      "condo",
    ]);
  });

  it("supports the `properties:` json-schema shape", () => {
    const yaml = `
type: object
properties:
  status:
    type: string
    enum: ["open", "closed", "pending"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "status")).toEqual([
      "open",
      "closed",
      "pending",
    ]);
  });

  it("returns null when enum is declared but empty", () => {
    const yaml = `
fields:
  blank:
    type: string
    enum: []
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "blank")).toBeNull();
  });

  it("filters out non-scalar enum entries (objects, arrays)", () => {
    // YAML.parse will accept these; we should not surface them as dropdown
    // values because the override input expects a single string.
    const yaml = `
fields:
  mixed:
    type: string
    enum:
      - "ok"
      - { unexpected: "shape" }
      - "fine"
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "mixed")).toEqual(["ok", "fine"]);
  });

  it("dedups duplicate enum entries", () => {
    const yaml = `
fields:
  dupes:
    type: string
    enum: ["a", "b", "a", "c", "b"]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "dupes")).toEqual(["a", "b", "c"]);
  });

  it("coerces numeric/boolean enum entries to strings", () => {
    const yaml = `
fields:
  numeric:
    type: integer
    enum: [1, 2, 3]
flag:
  type: boolean
  enum: [true, false]
`;
    expect(extractFieldOptionsFromSchemaYaml(yaml, "numeric")).toEqual(["1", "2", "3"]);
    expect(extractFieldOptionsFromSchemaYaml(yaml, "flag")).toEqual(["true", "false"]);
  });
});
