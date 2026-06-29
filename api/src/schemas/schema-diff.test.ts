import { describe, it, expect } from "vitest";
import { deriveBump } from "./schema-diff";

// Minimal compiled-schema shapes: { fields: { name: { type, required, ... } } }
const schema = (fields: Record<string, Record<string, unknown>>) => ({ fields });

describe("deriveBump — patch (extraction tuning, same shape)", () => {
  const active = schema({ total: { type: "number" }, vendor: { type: "string" } });

  it("description/guidance changes are patch", () => {
    const candidate = schema({
      total: { type: "number", description: "the grand total" },
      vendor: { type: "string", normalize: "trim" },
    });
    expect(deriveBump(active, candidate)).toBe("patch");
  });

  it("identical schema is patch", () => {
    expect(deriveBump(active, structuredClone(active))).toBe("patch");
  });
});

describe("deriveBump — minor (additive / stricter)", () => {
  const active = schema({ total: { type: "number" } });

  it("adding a field is minor", () => {
    expect(deriveBump(active, schema({ total: { type: "number" }, tax: { type: "number" } }))).toBe("minor");
  });

  it("optional → required is minor (stricter, not breaking)", () => {
    const candidate = schema({ total: { type: "number", required: true } });
    expect(deriveBump(active, candidate)).toBe("minor");
  });

  it("changing an enum domain is minor", () => {
    const a = schema({ status: { type: "enum", values: ["active", "lapsed"] } });
    const b = schema({ status: { type: "enum", values: ["active", "lapsed", "pending"] } });
    expect(deriveBump(a, b)).toBe("minor");
  });
});

describe("deriveBump — major (breaking output shape)", () => {
  it("removing a field is major", () => {
    const a = schema({ total: { type: "number" }, vendor: { type: "string" } });
    expect(deriveBump(a, schema({ total: { type: "number" } }))).toBe("major");
  });

  it("renaming a field is major (remove + add)", () => {
    const a = schema({ vendor: { type: "string" } });
    expect(deriveBump(a, schema({ merchant: { type: "string" } }))).toBe("major");
  });

  it("changing a field type is major", () => {
    const a = schema({ total: { type: "number" } });
    expect(deriveBump(a, schema({ total: { type: "string" } }))).toBe("major");
  });

  it("required → optional is major (field may now be absent)", () => {
    const a = schema({ total: { type: "number", required: true } });
    expect(deriveBump(a, schema({ total: { type: "number" } }))).toBe("major");
  });
});

describe("deriveBump — nested array-of-objects", () => {
  const active = schema({
    items: { type: "array", items: { properties: { name: { type: "string" }, qty: { type: "number" } } } },
  });

  it("a nested child removed is major", () => {
    const candidate = schema({
      items: { type: "array", items: { properties: { name: { type: "string" } } } },
    });
    expect(deriveBump(active, candidate)).toBe("major");
  });

  it("a nested child retyped is major", () => {
    const candidate = schema({
      items: { type: "array", items: { properties: { name: { type: "string" }, qty: { type: "string" } } } },
    });
    expect(deriveBump(active, candidate)).toBe("major");
  });

  it("a nested child added is minor", () => {
    const candidate = schema({
      items: {
        type: "array",
        items: { properties: { name: { type: "string" }, qty: { type: "number" }, sku: { type: "string" } } },
      },
    });
    expect(deriveBump(active, candidate)).toBe("minor");
  });
});

describe("deriveBump — no active release", () => {
  it("first version is patch (caller picks the initial version)", () => {
    expect(deriveBump(null, schema({ total: { type: "number" } }))).toBe("patch");
  });
});
