import { describe, it, expect } from "vitest";
import { clampLimit } from "./documents";

describe("clampLimit — documents list page size", () => {
  it("defaults when absent or malformed", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit("")).toBe(50);
    expect(clampLimit("abc")).toBe(50);
    expect(clampLimit("0")).toBe(50);
    expect(clampLimit("-5")).toBe(50);
  });

  it("passes sane values through and caps at the max", () => {
    expect(clampLimit("25")).toBe(25);
    expect(clampLimit("200")).toBe(200);
    expect(clampLimit("5000")).toBe(200);
  });
});
