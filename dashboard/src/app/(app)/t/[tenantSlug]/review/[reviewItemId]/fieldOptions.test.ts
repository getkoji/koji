/**
 * Tests for the `deriveFieldOptions` helper — derives the override-dropdown
 * options from the server's `SchemaFieldMeta[]` payload.
 *
 * The old test suite parsed YAML in-process; the API now does that and
 * returns FieldMeta[] over the wire. These tests keep the same regression
 * coverage (the `patterns:` leak, enum/options/mappings shapes, dedup, etc.)
 * targeting the new helper.
 */

import { describe, it, expect } from "vitest";
import type { SchemaFieldMeta } from "@/lib/api";
import { deriveFieldOptions } from "./fieldOptions";

describe("deriveFieldOptions", () => {
  it("returns enum values when the field declares enum", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "governance", type: "string", enum: ["hoa", "condo", "coop"] },
    ];
    expect(deriveFieldOptions(fields, "governance")).toEqual(["hoa", "condo", "coop"]);
  });

  it("returns options when the field declares the legacy `options` alias", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "community_type", type: "string", options: ["monoline", "multiline"] },
    ];
    expect(deriveFieldOptions(fields, "community_type")).toEqual(["monoline", "multiline"]);
  });

  it("returns mapping keys when the field declares mappings", () => {
    const fields: SchemaFieldMeta[] = [
      {
        name: "state",
        type: "string",
        mappings: {
          CA: ["California", "Calif", "Cal."],
          NY: ["New York", "NYS"],
          TX: ["Texas", "Tex."],
        },
      },
    ];
    expect(deriveFieldOptions(fields, "state")).toEqual(["CA", "NY", "TX"]);
  });

  it("returns null for fields the schema doesn't declare", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "state", type: "string", enum: ["CA", "NY"] },
    ];
    expect(deriveFieldOptions(fields, "country")).toBeNull();
  });

  it("returns null when the field has no enum/options/mappings (the `patterns:` regression)", () => {
    // The whole point of the rewrite: schemas can declare `patterns:` (regex
    // lists) without leaking into the override dropdown. Since the API
    // normalizer drops unknown keys, this is a "field exists, but has no
    // option source" case.
    const fields: SchemaFieldMeta[] = [
      {
        name: "unit_address_range",
        type: "string",
        description: "Range like 1-100 or Unit A",
        pattern: "^[0-9]+-[0-9]+$",
      },
    ];
    expect(deriveFieldOptions(fields, "unit_address_range")).toBeNull();
  });

  it("returns null when the schema field has neither enum nor options nor mappings", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "primary_address", type: "string", description: "The street address" },
    ];
    expect(deriveFieldOptions(fields, "primary_address")).toBeNull();
  });

  it("returns null for null / empty fields input", () => {
    expect(deriveFieldOptions(null, "any_field")).toBeNull();
    expect(deriveFieldOptions(undefined, "any_field")).toBeNull();
    expect(deriveFieldOptions([], "any_field")).toBeNull();
  });

  it("returns null for an empty field name", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "x", type: "string", enum: ["a"] },
    ];
    expect(deriveFieldOptions(fields, "")).toBeNull();
  });

  it("returns null when enum is declared but empty (defensive — the API drops these)", () => {
    const fields: SchemaFieldMeta[] = [{ name: "blank", type: "string", enum: [] }];
    expect(deriveFieldOptions(fields, "blank")).toBeNull();
  });

  it("dedups duplicate entries (defensive — the API does this server-side too)", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "dupes", type: "string", enum: ["a", "b", "a", "c", "b"] },
    ];
    expect(deriveFieldOptions(fields, "dupes")).toEqual(["a", "b", "c"]);
  });

  it("prefers enum over options when both are present", () => {
    const fields: SchemaFieldMeta[] = [
      { name: "x", type: "string", enum: ["a", "b"], options: ["x", "y"] },
    ];
    expect(deriveFieldOptions(fields, "x")).toEqual(["a", "b"]);
  });

  it("prefers options over mappings when both are present and enum is absent", () => {
    const fields: SchemaFieldMeta[] = [
      {
        name: "x",
        type: "string",
        options: ["o1", "o2"],
        mappings: { M1: ["a"], M2: ["b"] },
      },
    ];
    expect(deriveFieldOptions(fields, "x")).toEqual(["o1", "o2"]);
  });
});
