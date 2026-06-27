import { describe, it, expect } from "vitest";
import { keepRawView } from "./keep-raw";

describe("keepRawView", () => {
  it("suppresses a _raw companion and exposes it by base field", () => {
    const { entries, rawByField } = keepRawView({
      applies_to: "each_occurrence",
      applies_to_raw: "Each Occurrence",
    });
    expect(entries).toEqual([["applies_to", "each_occurrence"]]);
    expect(rawByField).toEqual({ applies_to: "Each Occurrence" });
  });

  it("keeps a _raw key that has no matching base field (never hides real data)", () => {
    const { entries, rawByField } = keepRawView({ notes_raw: "orphan" });
    expect(entries).toEqual([["notes_raw", "orphan"]]);
    expect(rawByField).toEqual({});
  });

  it("does not suppress when the companion is null/empty", () => {
    const { entries, rawByField } = keepRawView({ x: "v", x_raw: "" });
    expect(entries.map(([k]) => k)).toEqual(["x", "x_raw"]);
    expect(rawByField).toEqual({});
  });

  it("coerces non-string companions to string", () => {
    const { rawByField } = keepRawView({ amount: 1000, amount_raw: 1000 });
    expect(rawByField).toEqual({ amount: "1000" });
  });

  it("returns empty for arrays / non-objects", () => {
    expect(keepRawView([1, 2, 3])).toEqual({ entries: [], rawByField: {} });
    expect(keepRawView(null)).toEqual({ entries: [], rawByField: {} });
  });

  it("preserves original field order of non-suppressed keys", () => {
    const { entries } = keepRawView({ a: 1, a_raw: "A", b: 2 });
    expect(entries.map(([k]) => k)).toEqual(["a", "b"]);
  });
});
