#!/usr/bin/env tsx
/**
 * TS pipeline benchmark runner.
 *
 * Runs the TypeScript intelligent extraction pipeline against the validation
 * corpus and produces a JSON report compatible with `koji bench` output.
 *
 * Usage:
 *   cd koji/api
 *   OPENAI_API_KEY=... tsx src/extract/bench-ts.ts ../../corpus --model gpt-4o-mini
 *
 * Options:
 *   --model <model>       Model to use (default: gpt-4o-mini)
 *   --category <name>     Run only this corpus category
 *   --limit <n>           Max documents per category
 *   --output <path>       Write JSON results to file
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

import { compareValues } from "@koji/score";
import { intelligentExtract } from "./intelligent-pipeline";
import { OpenAIProvider } from "./providers";

interface FieldResult {
  field: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

interface DocResult {
  document: string;
  category: string;
  schema: string;
  fields: FieldResult[];
  elapsed_ms: number;
  error?: string;
}

interface BenchReport {
  model: string;
  pipeline: "typescript";
  total_docs: number;
  total_fields: number;
  correct_fields: number;
  accuracy: number;
  per_category: Record<string, { docs: number; fields: number; correct: number; accuracy: number }>;
  results: DocResult[];
}

/**
 * Score one document's extraction against ground truth.
 *
 * Delegates to `@koji/score` — the same comparator `koji validate`, `koji
 * score`, `koji test` and the benches use — so a number produced here means
 * what a number produced anywhere else means.
 *
 * It previously carried its own comparator, and that comparator was wrong in
 * two ways that both inflated the result:
 *
 *   - its "fuzzy" branch compared character MULTISETS, not edit distance, so
 *     any anagram scored as a match at the default 0.85 threshold:
 *     "12/31/2026" == "13/21/2026" (a different date), "listen" == "silent".
 *   - an array field counted as correct whenever extraction returned ANY
 *     non-empty array, whatever it contained. Line items and coverages — the
 *     hardest fields in the corpus — were effectively unscored.
 *
 * Per-field specs come from the schema, so arrays match elements by their
 * declared `element_key`, `informational` sub-fields are excluded, and a
 * declared `match:` policy applies.
 */
function compareResults(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  schemaDef: Record<string, unknown> | null,
): FieldResult[] {
  const specs = (schemaDef?.fields ?? {}) as Record<string, Record<string, unknown>>;
  const results: FieldResult[] = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[field] ?? null;
    results.push({
      field,
      expected: expectedValue,
      actual: actualValue,
      match: compareValues(expectedValue, actualValue, specs[field]).match,
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const corpusPath = args[0];
  if (!corpusPath) {
    console.error("Usage: tsx bench-ts.ts <corpus-path> [--model <model>] [--category <cat>] [--limit <n>]");
    process.exit(1);
  }

  let model = "gpt-4o-mini";
  let categoryFilter: string | null = null;
  let limit: number | null = null;
  let outputPath: string | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) { model = args[++i]!; }
    if (args[i] === "--category" && args[i + 1]) { categoryFilter = args[++i]!; }
    if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[++i]!, 10); }
    if (args[i] === "--output" && args[i + 1]) { outputPath = args[++i]!; }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is required");
    process.exit(1);
  }

  const provider = new OpenAIProvider(model, apiKey);

  // Discover corpus categories
  const categories = readdirSync(corpusPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      if (categoryFilter) return name === categoryFilter;
      // Must have documents/ and expected/ dirs
      return existsSync(join(corpusPath, name, "documents")) &&
             existsSync(join(corpusPath, name, "expected"));
    });

  console.log(`\nkoji bench-ts — model: ${model}, categories: ${categories.join(", ")}\n`);

  const allResults: DocResult[] = [];
  const perCategory: Record<string, { docs: number; fields: number; correct: number; accuracy: number }> = {};

  for (const category of categories) {
    const docsDir = join(corpusPath, category, "documents");
    const expectedDir = join(corpusPath, category, "expected");
    const schemasDir = join(corpusPath, category, "schemas");

    // Find schema
    const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".yaml"));
    if (schemaFiles.length === 0) {
      console.log(`  ${category}: no schema found, skipping`);
      continue;
    }
    const schemaPath = join(schemasDir, schemaFiles[0]!);
    const schemaDef = parseYaml(readFileSync(schemaPath, "utf-8"));
    // `compare.fuzzy_threshold` predates the unified scorer, which has no
    // global threshold — equivalence is declared per field with `match:`.
    // Say so rather than ignoring a setting the schema author wrote.
    if (schemaDef?.compare?.fuzzy_threshold !== undefined) {
      console.warn(
        `  note: ${schemaFiles[0]!} declares compare.fuzzy_threshold; it is ignored. ` +
          `Declare per-field equivalence with \`match:\` instead (docs/schema-guide.md).`,
      );
    }

    // Find documents with expected outputs
    const docs = readdirSync(docsDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => {
        const expectedFile = join(expectedDir, f.replace(".md", ".expected.json"));
        return existsSync(expectedFile);
      });

    const docsToRun = limit ? docs.slice(0, limit) : docs;
    let catFields = 0;
    let catCorrect = 0;

    for (let i = 0; i < docsToRun.length; i++) {
      const docFile = docsToRun[i]!;
      const markdown = readFileSync(join(docsDir, docFile), "utf-8");
      const expected = JSON.parse(readFileSync(join(expectedDir, docFile.replace(".md", ".expected.json")), "utf-8"));

      process.stdout.write(`  (${category} ${i + 1}/${docsToRun.length}) ${docFile}`);

      const start = Date.now();
      try {
        const result = await intelligentExtract(markdown, schemaDef, provider, model);
        const elapsed = Date.now() - start;
        const fields = compareResults(expected, result.extracted, schemaDef);

        const correct = fields.filter((f) => f.match).length;
        catFields += fields.length;
        catCorrect += correct;

        allResults.push({
          document: docFile,
          category,
          schema: schemaFiles[0]!,
          fields,
          elapsed_ms: elapsed,
        });

        process.stdout.write(` — ${correct}/${fields.length} (${elapsed}ms)\n`);
      } catch (err) {
        const elapsed = Date.now() - start;
        allResults.push({
          document: docFile,
          category,
          schema: schemaFiles[0]!,
          fields: [],
          elapsed_ms: elapsed,
          error: err instanceof Error ? err.message : String(err),
        });
        process.stdout.write(` — ERROR: ${err instanceof Error ? err.message : err}\n`);
      }
    }

    const catAccuracy = catFields > 0 ? catCorrect / catFields : 0;
    perCategory[category] = {
      docs: docsToRun.length,
      fields: catFields,
      correct: catCorrect,
      accuracy: Math.round(catAccuracy * 1000) / 1000,
    };
    console.log(`  ${category}: ${catCorrect}/${catFields} fields (${(catAccuracy * 100).toFixed(1)}%)\n`);
  }

  const totalFields = allResults.reduce((sum, r) => sum + r.fields.length, 0);
  const totalCorrect = allResults.reduce((sum, r) => sum + r.fields.filter((f) => f.match).length, 0);
  const totalAccuracy = totalFields > 0 ? totalCorrect / totalFields : 0;

  const report: BenchReport = {
    model,
    pipeline: "typescript",
    total_docs: allResults.length,
    total_fields: totalFields,
    correct_fields: totalCorrect,
    accuracy: Math.round(totalAccuracy * 1000) / 1000,
    per_category: perCategory,
    results: allResults,
  };

  console.log(`\n  TOTAL: ${totalCorrect}/${totalFields} fields (${(totalAccuracy * 100).toFixed(1)}%)`);
  console.log(`  ${allResults.length} documents, model: ${model}, pipeline: typescript\n`);

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`  Results written to ${outputPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
