import { describe, it, expect } from "vitest";
import { PARSE_VERSION, isParseCacheFresh } from "./parse-version";

describe("isParseCacheFresh", () => {
  it("fresh when parser_version matches the current pipeline", () => {
    expect(isParseCacheFresh({ parser_version: PARSE_VERSION })).toBe(true);
  });

  it("stale when parser_version is older", () => {
    expect(isParseCacheFresh({ parser_version: PARSE_VERSION - 1 })).toBe(false);
  });

  it("stale when parser_version is missing (pre-versioning cache entry)", () => {
    // Old cache entries written before versioning have no parser_version —
    // these are exactly the stale ones a PARSE_VERSION bump must re-parse.
    expect(isParseCacheFresh({})).toBe(false);
    expect(isParseCacheFresh({ markdown: "BALLANMOOR HOMEOWNERS ASSN INC" })).toBe(false);
  });

  it("stale for null / undefined payloads", () => {
    expect(isParseCacheFresh(null)).toBe(false);
    expect(isParseCacheFresh(undefined)).toBe(false);
  });
});
