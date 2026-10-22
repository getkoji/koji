#!/usr/bin/env tsx
/**
 * Array-field accuracy with and without grid extraction (Track D), as a PAIRED
 * measurement.
 *
 * Why paired. The grid stage is a deterministic post-pass over the pipeline's
 * own output, and `grid:` is never rendered into any prompt (`describeProperty`
 * / `describeArrayItem` read only `type`, `items`, `properties` and the vocab
 * hints). So the LLM half of the run is byte-identical between arms, and
 * running it twice would add nothing but model non-determinism — which at these
 * sample sizes is the dominant source of noise and would make the comparison
 * unreadable. Instead: extract once per document, then score the same result
 * with the stage off and with it on. The "on" arm is not a simulation, it is
 * the exact code `intelligentExtract` runs.
 *
 * Three arms:
 *   - `base`   — the pipeline as it ships today.
 *   - `grid`   — `grid: true` on every array field, deterministic matching only
 *                (no `select` calls at all).
 *   - `grid+s` — the same, with the OSS default selector (LLM-choice over the
 *                extraction model) allowed to resolve headers and row labels
 *                literal matching missed.
 *
 * No per-category aliases are authored: the `grid:` block is the bare opt-in,
 * so the numbers describe out-of-the-box behaviour rather than a tuned schema.
 *
 * Scored with `@koji/score` — the same comparator `koji validate`, `koji score`
 * and `bench-ts` use — per field, reported per category, for ARRAY fields and
 * for all fields. Both the binary match rate and the mean partial score are
 * printed, because an array that is half right is not the same as one that is
 * empty and the single number hides which happened.
 *
 * Usage:
 *   cd koji/api
 *   OPENAI_API_KEY=... npx tsx src/extract/bench-grid.ts ../../corpus \
 *     --model gpt-4o-mini --limit 20 --output /tmp/grid-bench.json
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { compareValues } from "@koji/score";
import { intelligentExtract } from "./intelligent-pipeline";
import { applyGridTables } from "./grid-tables";
import { OpenAIProvider } from "./providers";
import { LlmChoiceSelectProvider } from "../select";

type Arm = "base" | "grid" | "grid+s";
const ARMS: Arm[] = ["base", "grid", "grid+s"];

interface Tally {
  arrayFields: number;
  arrayMatches: number;
  arrayScore: number;
  allFields: number;
  allMatches: number;
}

const emptyTally = (): Tally => ({ arrayFields: 0, arrayMatches: 0, arrayScore: 0, allFields: 0, allMatches: 0 });

/** Deep clone that survives plain JSON values, which is all an extraction is. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The same schema with a `grid:` block on every top-level array field.
 *
 * `exclude` names sub-fields the grid must not claim — the `--exclude` flag,
 * for measuring the one failure mode that knob exists for: a column that prints
 * a reference the schema asks you to resolve elsewhere.
 */
function withGrid(schemaDef: Record<string, unknown>, exclude: string[]): Record<string, unknown> {
  const copy = clone(schemaDef);
  const fields = (copy.fields ?? {}) as Record<string, Record<string, unknown>>;
  for (const spec of Object.values(fields)) {
    if (!spec || typeof spec !== "object" || spec.type !== "array") continue;
    const props = ((spec.items as Record<string, unknown> | undefined)?.properties ?? {}) as Record<string, unknown>;
    const mine = exclude.filter((n) => n in props);
    spec.grid = mine.length > 0 ? { exclude: mine } : true;
  }
  return copy;
}

function arrayFieldNames(schemaDef: Record<string, unknown>): Set<string> {
  const fields = (schemaDef?.fields ?? {}) as Record<string, Record<string, unknown>>;
  return new Set(Object.entries(fields).filter(([, s]) => s?.type === "array").map(([n]) => n));
}

function scoreInto(
  tally: Tally,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  schemaDef: Record<string, unknown>,
) {
  const specs = (schemaDef?.fields ?? {}) as Record<string, Record<string, unknown>>;
  const arrays = arrayFieldNames(schemaDef);
  for (const [field, expectedValue] of Object.entries(expected)) {
    const r = compareValues(expectedValue, actual[field] ?? null, specs[field]);
    tally.allFields += 1;
    if (r.match) tally.allMatches += 1;
    if (arrays.has(field)) {
      tally.arrayFields += 1;
      tally.arrayScore += r.score;
      if (r.match) tally.arrayMatches += 1;
    }
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "   n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const corpusPath = args[0];
  if (!corpusPath) {
    console.error("Usage: tsx src/extract/bench-grid.ts <corpus-path> [--model m] [--limit n] [--category c] [--exclude sub-field] [--output p]");
    process.exit(1);
  }
  let model = "gpt-4o-mini";
  let limit: number | null = null;
  let outputPath: string | null = null;
  const categoryFilter: string[] = [];
  const exclude: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) model = args[++i]!;
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i]!, 10);
    else if (args[i] === "--category" && args[i + 1]) categoryFilter.push(args[++i]!);
    else if (args[i] === "--exclude" && args[i + 1]) exclude.push(args[++i]!);
    else if (args[i] === "--output" && args[i + 1]) outputPath = args[++i]!;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required");
    process.exit(1);
  }
  const provider = new OpenAIProvider(model, apiKey);
  const selector = new LlmChoiceSelectProvider(provider);

  const categories = readdirSync(corpusPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      if (categoryFilter.length > 0 && !categoryFilter.includes(name)) return false;
      return (
        existsSync(join(corpusPath, name, "documents")) &&
        existsSync(join(corpusPath, name, "expected")) &&
        existsSync(join(corpusPath, name, "schemas"))
      );
    });

  const perCategory: Record<string, Record<Arm, Tally>> = {};
  const totals: Record<Arm, Tally> = { base: emptyTally(), grid: emptyTally(), "grid+s": emptyTally() };
  const gridReports: string[] = [];
  let selectCalls = 0;

  for (const category of categories) {
    const schemasDir = join(corpusPath, category, "schemas");
    const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".yaml"));
    if (schemaFiles.length === 0) continue;
    const baseSchema = parseYaml(readFileSync(join(schemasDir, schemaFiles[0]!), "utf-8"));
    const arrays = arrayFieldNames(baseSchema);
    if (arrays.size === 0) {
      console.log(`  ${category}: no array fields — skipped`);
      continue;
    }
    const gridSchema = withGrid(baseSchema, exclude);

    const docsDir = join(corpusPath, category, "documents");
    const expectedDir = join(corpusPath, category, "expected");
    const docs = readdirSync(docsDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => existsSync(join(expectedDir, f.replace(".md", ".expected.json"))))
      .sort();
    const docsToRun = limit ? docs.slice(0, limit) : docs;

    perCategory[category] = { base: emptyTally(), grid: emptyTally(), "grid+s": emptyTally() };
    console.log(`\n${category}: ${docsToRun.length} doc(s), array field(s): ${[...arrays].join(", ")}`);

    for (let i = 0; i < docsToRun.length; i++) {
      const docFile = docsToRun[i]!;
      const markdown = readFileSync(join(docsDir, docFile), "utf-8");
      const expected = JSON.parse(readFileSync(join(expectedDir, docFile.replace(".md", ".expected.json")), "utf-8"));

      try {
        const result = await intelligentExtract(markdown, baseSchema, provider, model);
        const base = result.extracted;
        scoreInto(perCategory[category]!.base, expected, base, baseSchema);
        scoreInto(totals.base, expected, base, baseSchema);

        for (const arm of ["grid", "grid+s"] as const) {
          const extracted = clone(base);
          const sourceTexts = clone(result.source_texts ?? {});
          const { report, fields } = await applyGridTables(markdown, gridSchema, extracted, sourceTexts, undefined, {
            select: arm === "grid" ? null : selector,
          });
          if (arm === "grid+s") selectCalls += fields.reduce((n, f) => n + f.selectCalls, 0);
          if (arm === "grid" && report.length > 0) gridReports.push(`${category}/${docFile}: ${report[0]}`);
          scoreInto(perCategory[category]![arm], expected, extracted, baseSchema);
          scoreInto(totals[arm], expected, extracted, baseSchema);
        }
        process.stdout.write(
          `  (${i + 1}/${docsToRun.length}) ${docFile} — array match base/grid/grid+s: ` +
            `${perCategory[category]!.base.arrayMatches}/${perCategory[category]!.grid.arrayMatches}/` +
            `${perCategory[category]!["grid+s"].arrayMatches} of ${perCategory[category]!.base.arrayFields}\n`,
        );
      } catch (err) {
        console.log(`  (${i + 1}/${docsToRun.length}) ${docFile} — ERROR ${(err as Error).message}`);
      }
    }
  }

  const header = "category                 n(arr)   base    grid  grid+s  |  base(partial)  grid(partial)";
  console.log(`\n${"=".repeat(header.length)}\nARRAY-FIELD ACCURACY (@koji/score)\n${header}`);
  for (const [category, arms] of Object.entries(perCategory)) {
    const n = arms.base.arrayFields;
    console.log(
      `${category.padEnd(24)}${String(n).padStart(6)}  ${pct(arms.base.arrayMatches, n)} ` +
        `${pct(arms.grid.arrayMatches, n)} ${pct(arms["grid+s"].arrayMatches, n)}  |  ` +
        `${pct(arms.base.arrayScore, n)}         ${pct(arms.grid.arrayScore, n)}`,
    );
  }
  const n = totals.base.arrayFields;
  console.log(
    `${"ALL".padEnd(24)}${String(n).padStart(6)}  ${pct(totals.base.arrayMatches, n)} ` +
      `${pct(totals.grid.arrayMatches, n)} ${pct(totals["grid+s"].arrayMatches, n)}  |  ` +
      `${pct(totals.base.arrayScore, n)}         ${pct(totals.grid.arrayScore, n)}`,
  );
  console.log(
    `\nALL FIELDS: base ${pct(totals.base.allMatches, totals.base.allFields)} · ` +
      `grid ${pct(totals.grid.allMatches, totals.grid.allFields)} · ` +
      `grid+s ${pct(totals["grid+s"].allMatches, totals["grid+s"].allFields)} ` +
      `(n=${totals.base.allFields})`,
  );
  console.log(`selection calls in grid+s: ${selectCalls}`);
  console.log(`documents where a grid was accepted: ${gridReports.length}`);
  for (const line of gridReports.slice(0, 10)) console.log(`  ${line}`);

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify({ model, arms: ARMS, exclude, perCategory, totals, gridReports }, null, 2));
    console.log(`\nWrote ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
