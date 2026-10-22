/**
 * Row identity (D2) and column identity (D3).
 *
 * The property under test is transfer: the same schema declaration must read
 * two differently-worded layouts of the same table, which is exactly what a
 * hand-authored `forms:` grammar cannot do.
 */
import { describe, it, expect } from "vitest";

import { gridsFromMarkdown, gridsFromSpine } from "./grid";
import {
  elementVocabulary,
  fold,
  identifyColumns,
  identifyRows,
  type ElementOption,
} from "./grid-identity";
import {
  ABSTAIN,
  SelectUnavailableError,
  type SelectCandidate,
  type SelectProvider,
  type SelectResult,
  type SelectState,
} from "../select";
import { assignUnitIds, type ParseUnitDraft } from "../parse/chunk";

/** A selector that answers from a fixture table, recording what it was asked. */
function fakeSelector(
  answers: Record<string, string>,
  opts: { name?: string; maxOptions?: number } = {},
): SelectProvider & { calls: Array<{ state: SelectState; options: readonly SelectCandidate[] }> } {
  const calls: Array<{ state: SelectState; options: readonly SelectCandidate[] }> = [];
  return {
    name: opts.name ?? "fake",
    maxOptions: opts.maxOptions ?? 80,
    calls,
    async select(state, options, _instructions): Promise<SelectResult> {
      calls.push({ state, options });
      const probe = JSON.stringify(state);
      const key = Object.keys(answers).find((k) => probe.includes(k));
      const choice = key ? answers[key]! : ABSTAIN;
      const selected = options.find((o) => o.value === choice) ?? null;
      return {
        choice: selected ? choice : ABSTAIN,
        selected,
        abstained: !selected,
        probabilities: { [selected ? choice : ABSTAIN]: 1 },
        confidence: 1,
        answerConfidence: 0.9,
        calibrated: false,
        provider: opts.name ?? "fake",
      };
    },
  };
}

const ITEM_FIELDS = {
  name: { type: "string" },
  quantity: { type: "number" },
  unit_price: { type: "number", description: "Price for one unit." },
  amount: { type: "number" },
};

function mdGrid(...lines: string[]) {
  return gridsFromMarkdown(lines.join("\n"))[0]!;
}

describe("identifyColumns", () => {
  it("maps headers to sub-fields by literal alias, no model call", async () => {
    const g = mdGrid("| Name | Quantity | Unit Price | Amount |", "| --- | --- | --- | --- |", "| W | 2 | 5 | 10 |");
    const selector = fakeSelector({});
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(Object.fromEntries(map.byField)).toEqual({ name: 1, quantity: 2, unit_price: 3, amount: 4 });
    expect(map.selectCalls).toBe(0);
    expect(selector.calls).toHaveLength(0);
  });

  it("matches a header that wraps the sub-field name in extra words", async () => {
    const g = mdGrid("| Description | Qty | Amount (USD) |", "| --- | --- | --- |", "| W | 2 | 10 |");
    const map = await identifyColumns(g, ITEM_FIELDS, { select: null });
    expect(map.byField.get("amount")).toBe(3);
    // "Description" and "Qty" are not spellings of any declared name.
    expect(map.byField.has("name")).toBe(false);
    expect(map.byField.has("quantity")).toBe(false);
  });

  it("uses schema-declared column aliases for a document's own wording", async () => {
    const g = mdGrid("| Description | Qty | Rate | Amount |", "| --- | --- | --- | --- |", "| W | 2 | 5 | 10 |");
    const map = await identifyColumns(g, ITEM_FIELDS, {
      select: null,
      aliases: { name: ["description"], quantity: ["qty"], unit_price: ["rate"] },
    });
    expect(Object.fromEntries(map.byField)).toEqual({ name: 1, quantity: 2, unit_price: 3, amount: 4 });
    expect(map.columns.every((c) => c.subField === null || c.via === "alias")).toBe(true);
  });

  it("asks the selector only about the headers literal matching missed", async () => {
    const g = mdGrid("| Description | Qty | Amount |", "| --- | --- | --- |", "| W | 2 | 10 |");
    const selector = fakeSelector({ Description: "name", Qty: "quantity" });
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(Object.fromEntries(map.byField)).toEqual({ amount: 3, name: 1, quantity: 2 });
    expect(map.selectCalls).toBe(2); // "Amount" resolved literally, never asked
    expect(map.columns[0]!.via).toBe("select");
    expect(map.columns[2]!.via).toBe("alias");
  });

  it("shows the selector the column's own example values", async () => {
    const g = mdGrid("| Mystery | Amount |", "| --- | --- |", "| alpha | 1 |", "| beta | 2 |");
    const selector = fakeSelector({ Mystery: "name" });
    await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(JSON.stringify(selector.calls[0]!.state)).toContain("alpha");
    expect(JSON.stringify(selector.calls[0]!.state)).toContain("beta");
  });

  it("leaves a column unmapped when the selector abstains", async () => {
    const g = mdGrid("| Tax Code | Amount |", "| --- | --- |", "| X1 | 10 |");
    const selector = fakeSelector({}); // abstains on everything
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(map.byField.has("name")).toBe(false);
    expect(map.columns[0]!.subField).toBeNull();
  });

  it("never maps two columns to one sub-field — the fuller column wins", async () => {
    // The positional path's over-split can leave a header's words in two
    // physical columns while the data lands in exactly one.
    const units = assignUnitIds(
      (
        [
          [1, 1, "Amount"],
          [1, 2, "Amount"],
          [2, 2, "10.00"],
          [3, 2, "5.50"],
          [1, 3, "Name"],
          [2, 3, "W"],
          [3, 3, "G"],
        ] as Array<[number, number, string]>
      ).map(([row, col, text]): ParseUnitDraft => ({
        page: 1,
        text,
        role: "table_cell",
        table: { tableId: "p1-t0", row, col },
      })),
    );
    const g = gridsFromSpine(units)[0]!;
    const map = await identifyColumns(g, ITEM_FIELDS, { select: null });
    expect(map.byField.get("amount")).toBe(2); // the one carrying the values
    expect(map.columns[0]!.subField).toBeNull();
  });

  it("skips phantom blank columns without asking anyone", async () => {
    const g = mdGrid("| Name |  | Amount |", "| --- | --- | --- |", "| W |  | 10 |");
    const selector = fakeSelector({});
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(Object.fromEntries(map.byField)).toEqual({ name: 1, amount: 3 });
    expect(selector.calls).toHaveLength(0);
  });

  it("honours the select budget", async () => {
    const g = mdGrid("| P | Q | R | S |", "| --- | --- | --- | --- |", "| 1 | 2 | 3 | 4 |");
    const selector = fakeSelector({ P: "name", Q: "quantity", R: "unit_price", S: "amount" });
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector, budget: 2 });
    expect(map.selectCalls).toBe(2);
    expect(map.byField.size).toBe(2);
  });

  it("degrades to literal matches when the selector is unavailable", async () => {
    const g = mdGrid("| Mystery | Amount |", "| --- | --- |", "| x | 10 |");
    const trace: string[] = [];
    const dead: SelectProvider = {
      name: "laya",
      maxOptions: 80,
      async select() {
        throw new SelectUnavailableError("laya", "weights not on disk");
      },
    };
    const map = await identifyColumns(g, ITEM_FIELDS, { select: dead, trace });
    expect(map.byField.get("amount")).toBe(2);
    expect(trace.join(" ")).toContain("unavailable");
  });

  it("does not ask a selector whose option ceiling is below the sub-field count", async () => {
    const g = mdGrid("| Mystery | Amount |", "| --- | --- |", "| x | 10 |");
    const trace: string[] = [];
    const tiny = fakeSelector({ Mystery: "name" }, { maxOptions: 1 });
    const map = await identifyColumns(g, ITEM_FIELDS, { select: tiny, trace });
    expect(map.byField.has("name")).toBe(false);
    expect(trace.join(" ")).toContain("exceeds");
  });
});

describe("elementVocabulary", () => {
  it("reads mappings as canonical codes plus their aliases", () => {
    const v = elementVocabulary({ type: "mapping", mappings: { alpha: ["Alpha Thing", "A-Thing"], beta: [] } });
    expect(v.map((o) => o.value)).toEqual(["alpha", "beta"]);
    expect(v[0]!.aliases).toEqual(["alpha", "Alpha Thing", "A-Thing"]);
  });

  it("reads a flat options list", () => {
    expect(elementVocabulary({ type: "enum", options: ["x", "y"] }).map((o) => o.value)).toEqual(["x", "y"]);
  });

  it("returns nothing when the sub-field declares no vocabulary", () => {
    expect(elementVocabulary({ type: "string" })).toEqual([]);
    expect(elementVocabulary(undefined)).toEqual([]);
  });
});

describe("identifyRows", () => {
  const vocab: ElementOption[] = [
    { value: "alpha", aliases: ["alpha", "Alpha Coverage", "Alpha"] },
    { value: "alpha_extended", aliases: ["alpha_extended", "Alpha Coverage - Extended"] },
    { value: "beta", aliases: ["beta", "Beta"] },
  ];

  it("falls back to positional identity when the schema declares no vocabulary", async () => {
    const g = mdGrid("| Name | Amount |", "| --- | --- |", "| W | 1 |", "| G | 2 |");
    const map = await identifyRows(g, [], 1, { select: null });
    expect(map.rows.map((r) => [r.rowIndex, r.key, r.via])).toEqual([
      [1, null, "position"],
      [2, null, "position"],
    ]);
  });

  it("matches a row label to the element with the LONGEST matching alias", async () => {
    const g = mdGrid(
      "| Coverage | Amount |",
      "| --- | --- |",
      "| Alpha Coverage | 1 |",
      "| Alpha Coverage - Extended | 2 |",
    );
    const map = await identifyRows(g, vocab, 1, { select: null });
    expect(map.rows.map((r) => r.key)).toEqual(["alpha", "alpha_extended"]);
    expect(map.rows.every((r) => r.via === "alias")).toBe(true);
    expect(map.selectCalls).toBe(0);
  });

  it("transfers to a layout that words the same rows differently", async () => {
    // Same schema vocabulary, a document that spells the rows its own way —
    // the case a hand-authored regex grammar has to be rewritten for.
    const g = mdGrid("| Type | Amount |", "| --- | --- |", "| ALPHA |  1 |", "| beta | 2 |");
    const map = await identifyRows(g, vocab, 1, { select: null });
    expect(map.rows.map((r) => r.key)).toEqual(["alpha", "beta"]);
  });

  it("asks the selector for a row no alias matches", async () => {
    const g = mdGrid("| Coverage | Amount |", "| --- | --- |", "| First Party Thing | 1 |");
    const selector = fakeSelector({ "First Party Thing": "beta" });
    const map = await identifyRows(g, vocab, 1, { select: selector });
    expect(map.rows[0]!.key).toBe("beta");
    expect(map.rows[0]!.via).toBe("select");
    expect(map.selectCalls).toBe(1);
  });

  it("leaves a row unidentified when the selector abstains — totals and headings", async () => {
    const g = mdGrid("| Coverage | Amount |", "| --- | --- |", "| Alpha | 1 |", "| TOTAL | 99 |");
    const selector = fakeSelector({});
    const map = await identifyRows(g, vocab, 1, { select: selector });
    expect(map.rows.map((r) => r.key)).toEqual(["alpha", null]);
    expect(map.rows[1]!.via).toBe("none");
  });

  it("reads the label from the first non-empty cell when no key column was mapped", async () => {
    const g = mdGrid("| Coverage | Amount |", "| --- | --- |", "| Beta | 1 |");
    const map = await identifyRows(g, vocab, undefined, { select: null });
    expect(map.rows[0]!.key).toBe("beta");
  });

  it("does not call the selector past its budget", async () => {
    const g = mdGrid("| C | A |", "| --- | --- |", "| q | 1 |", "| r | 2 |", "| s | 3 |");
    const selector = fakeSelector({ q: "alpha", r: "beta", s: "alpha" });
    const map = await identifyRows(g, vocab, 1, { select: selector, budget: 1 });
    expect(map.selectCalls).toBe(1);
    expect(map.rows.map((r) => r.key)).toEqual(["alpha", null, null]);
  });
});

describe("fold", () => {
  it("collapses punctuation and case so schema names meet document headers", () => {
    expect(fold("Unit Price ($)")).toBe("unit price");
    expect(fold("unit_price")).toBe("unit price");
    expect(fold("  E.L. Each Accident ")).toBe("e l each accident");
  });
});

describe("identifyColumns — best match, not first match", () => {
  it("prefers the exact sub-field over a sibling the header merely contains", async () => {
    const fields = { price: { type: "number" }, unit_price: { type: "number" } };
    const g = gridsFromMarkdown(
      ["| Unit Price | Price |", "| --- | --- |", "| 5 | 10 |"].join("\n"),
    )[0]!;
    const map = await identifyColumns(g, fields, { select: null });
    expect(map.byField.get("unit_price")).toBe(1);
    expect(map.byField.get("price")).toBe(2);
  });

  it("prefers the longer declared alias at the same rank", async () => {
    const fields = { total: { type: "number" }, grand_total: { type: "number" } };
    const g = gridsFromMarkdown(
      ["| Grand Total Due | Total Due |", "| --- | --- |", "| 5 | 10 |"].join("\n"),
    )[0]!;
    const map = await identifyColumns(g, fields, {
      select: null,
      aliases: { total: ["total due"], grand_total: ["grand total due"] },
    });
    expect(map.byField.get("grand_total")).toBe(1);
    expect(map.byField.get("total")).toBe(2);
  });
});

describe("identifyColumns — empty columns", () => {
  it("never asks about, or maps, a header with nothing under it", async () => {
    const g = mdGrid("| Spurious | Amount |", "| --- | --- |", "|  | 10 |", "|  | 20 |");
    const selector = fakeSelector({ Spurious: "name" });
    const map = await identifyColumns(g, ITEM_FIELDS, { select: selector });
    expect(selector.calls).toHaveLength(0);
    expect(map.byField.has("name")).toBe(false);
    expect(map.byField.get("amount")).toBe(2);
  });
});
