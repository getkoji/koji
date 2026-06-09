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

function fuzzyMatch(expected: unknown, actual: unknown, threshold = 0.85): boolean {
  if (expected === actual) return true;
  if (expected == null && actual == null) return true;
  if (expected == null || actual == null) return false;

  const e = String(expected).trim().toLowerCase();
  const a = String(actual).trim().toLowerCase();

  if (e === a) return true;

  // Number comparison with tolerance
  const eNum = parseFloat(String(expected).replace(/[$,]/g, ""));
  const aNum = parseFloat(String(actual).replace(/[$,]/g, ""));
  if (!isNaN(eNum) && !isNaN(aNum)) {
    return Math.abs(eNum - aNum) < 0.01;
  }

  // Date comparison — normalize to YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(e) && /^\d{4}-\d{2}-\d{2}$/.test(a)) {
    return e === a;
  }

  // Fuzzy string match
  if (threshold > 0) {
    const shorter = Math.min(e.length, a.length);
    const longer = Math.max(e.length, a.length);
    if (longer === 0) return true;
    // Simple character overlap ratio
    let matches = 0;
    const aChars = [...a];
    for (const ch of e) {
      const idx = aChars.indexOf(ch);
      if (idx >= 0) {
        matches++;
        aChars.splice(idx, 1);
      }
    }
    return (matches / longer) >= threshold;
  }

  return false;
}

function compareResults(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  fuzzyThreshold: number,
): FieldResult[] {
  const results: FieldResult[] = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[field] ?? null;

    // Skip arrays for now — compare scalars
    if (Array.isArray(expectedValue)) {
      results.push({
        field,
        expected: expectedValue,
        actual: actualValue,
        match: Array.isArray(actualValue) && actualValue.length > 0,
      });
      continue;
    }

    results.push({
      field,
      expected: expectedValue,
      actual: actualValue,
      match: fuzzyMatch(expectedValue, actualValue, fuzzyThreshold),
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
    const fuzzyThreshold = parseFloat(schemaDef?.compare?.fuzzy_threshold ?? "0.85");

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
        const fields = compareResults(expected, result.extracted, fuzzyThreshold);

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
