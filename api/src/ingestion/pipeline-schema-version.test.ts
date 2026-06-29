import { describe, it, expect } from "vitest";
import { pickVersionId } from "./pipeline-schema-version";

describe("pickVersionId — per-pipeline version resolution", () => {
  it("auto mode → the schema's current live release", () => {
    expect(
      pickVersionId({
        versionMode: "auto",
        activeSchemaVersionId: "pinned-id",
        pinBelongsToSchema: true,
        currentVersionId: "live-id",
      }),
    ).toBe("live-id");
  });

  it("default (no mode) behaves as auto — preserves pre-P2 behavior", () => {
    expect(
      pickVersionId({
        versionMode: null,
        activeSchemaVersionId: "pinned-id",
        pinBelongsToSchema: true,
        currentVersionId: "live-id",
      }),
    ).toBe("live-id");
  });

  it("pinned + pin belongs to this schema → the pinned version", () => {
    expect(
      pickVersionId({
        versionMode: "pinned",
        activeSchemaVersionId: "pinned-id",
        pinBelongsToSchema: true,
        currentVersionId: "live-id",
      }),
    ).toBe("pinned-id");
  });

  it("pinned but the pin is for a DIFFERENT schema → falls back to live", () => {
    // A single pin can't cover multiple schemas in a DAG; non-matching schemas
    // must not accidentally run the wrong schema's version.
    expect(
      pickVersionId({
        versionMode: "pinned",
        activeSchemaVersionId: "pinned-id",
        pinBelongsToSchema: false,
        currentVersionId: "live-id",
      }),
    ).toBe("live-id");
  });

  it("pinned with no pin set → falls back to live", () => {
    expect(
      pickVersionId({
        versionMode: "pinned",
        activeSchemaVersionId: null,
        pinBelongsToSchema: false,
        currentVersionId: "live-id",
      }),
    ).toBe("live-id");
  });

  it("returns null when there is no live release and no usable pin", () => {
    expect(
      pickVersionId({
        versionMode: "auto",
        activeSchemaVersionId: null,
        pinBelongsToSchema: false,
        currentVersionId: null,
      }),
    ).toBeNull();
  });
});
