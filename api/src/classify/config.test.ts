import { describe, it, expect } from "vitest";
import {
  normalizeConfig,
  parseClassifierYaml,
  ClassifierConfigError,
  DEFAULTS,
} from "./config";

describe("normalizeConfig", () => {
  it("applies defaults and accepts a class map", () => {
    const cfg = normalizeConfig({
      name: "inbound",
      classes: { invoice: { description: "a bill" }, receipt: {} },
    });
    expect(cfg.name).toBe("inbound");
    expect(cfg.window).toBe(DEFAULTS.window);
    expect(cfg.scan).toBe("head");
    expect(cfg.maxTier).toBe(4);
    expect(cfg.onUnknown).toBe("return");
    expect(cfg.classes.map((c) => c.id)).toEqual(["invoice", "receipt"]);
    expect(cfg.classes[0].description).toBe("a bill");
  });

  it("accepts a class list with explicit ids", () => {
    const cfg = normalizeConfig({
      classes: [{ id: "a" }, { id: "b", window: 5 }],
    });
    expect(cfg.classes.map((c) => c.id)).toEqual(["a", "b"]);
    expect(cfg.classes[1].window).toBe(5);
  });

  it("reads cost controls from the `classify` block", () => {
    const cfg = normalizeConfig({
      classify: { window: 2, scan: "head_and_tail", max_tier: 2, on_unknown: "reject" },
      classes: { x: {} },
    });
    expect(cfg.window).toBe(2);
    expect(cfg.scan).toBe("head_and_tail");
    expect(cfg.maxTier).toBe(2);
    expect(cfg.onUnknown).toBe("reject");
  });

  it("also accepts cost controls at the top level", () => {
    const cfg = normalizeConfig({ window: 1, classes: { x: {} } });
    expect(cfg.window).toBe(1);
  });

  it("rejects a reserved `unknown` class id", () => {
    expect(() => normalizeConfig({ classes: { unknown: {} } })).toThrow(ClassifierConfigError);
  });

  it("rejects duplicate class ids", () => {
    expect(() =>
      normalizeConfig({ classes: [{ id: "a" }, { id: "a" }] }),
    ).toThrow(/duplicate/);
  });

  it("rejects an invalid regex pattern at config time", () => {
    expect(() =>
      normalizeConfig({ classes: { a: { patterns: ["(unclosed"] } } }),
    ).toThrow(/invalid pattern/);
  });

  it("parses exclude_keywords / exclude_patterns (snake and camel case)", () => {
    const cfg = normalizeConfig({
      classes: {
        a: { exclude_keywords: ["coverage part"], exclude_patterns: ["limit\\s+of"] },
        b: { excludeKeywords: ["x"] },
      },
    });
    expect(cfg.classes[0]!.excludeKeywords).toEqual(["coverage part"]);
    expect(cfg.classes[0]!.excludePatterns).toEqual(["limit\\s+of"]);
    expect(cfg.classes[1]!.excludeKeywords).toEqual(["x"]);
  });

  it("rejects an invalid exclude_pattern regex at config time", () => {
    expect(() =>
      normalizeConfig({ classes: { a: { exclude_patterns: ["(unclosed"] } } }),
    ).toThrow(/invalid pattern/);
  });

  it("rejects a non-integer or <1 window", () => {
    expect(() => normalizeConfig({ classes: { a: { window: 0 } } })).toThrow(/window/);
    expect(() => normalizeConfig({ classes: { a: { window: 1.5 } } })).toThrow(/window/);
  });

  it("rejects max_tier out of range", () => {
    expect(() =>
      normalizeConfig({ classify: { max_tier: 9 }, classes: { a: {} } }),
    ).toThrow(/max_tier/);
  });

  it("requires at least one class", () => {
    expect(() => normalizeConfig({ classes: {} })).toThrow(/at least one class/);
    expect(() => normalizeConfig({})).toThrow(/classes/);
  });

  it("rejects non-object input", () => {
    expect(() => normalizeConfig(null)).toThrow(ClassifierConfigError);
    expect(() => normalizeConfig([])).toThrow(ClassifierConfigError);
  });
});

describe("parseClassifierYaml", () => {
  it("parses YAML and normalizes", () => {
    const cfg = parseClassifierYaml(`
name: inbound_mail
classify:
  window: 3
  max_tier: 3
classes:
  invoice:
    description: "a vendor bill"
    keywords: ["invoice", "amount due"]
    window: 2
  policy:
    keywords: ["declarations"]
`);
    expect(cfg.name).toBe("inbound_mail");
    expect(cfg.maxTier).toBe(3);
    expect(cfg.classes[0].id).toBe("invoice");
    expect(cfg.classes[0].keywords).toEqual(["invoice", "amount due"]);
    expect(cfg.classes[0].window).toBe(2);
  });

  it("throws a config error on malformed YAML", () => {
    expect(() => parseClassifierYaml(":\n  - [unbalanced")).toThrow(ClassifierConfigError);
  });
});
