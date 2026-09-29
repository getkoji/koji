#!/usr/bin/env node
/**
 * `koji-score` — score extracted values against ground truth, offline.
 *
 * Exists so that every scoring caller can reach ONE implementation without a
 * running server, credentials, or a reimplementation. The API imports
 * `compareValues` directly; the Python CLI and any external harness shell out
 * to this bin.
 *
 * Input is a JSON object, on stdin or via --input:
 *
 *   {
 *     "fields": {                      // required: one entry per scored field
 *       "policy_number": { "expected": "ABC-1", "got": "abc 1" },
 *       "effective_date": { "expected": "2026-03-26", "got": "03/26/2026" }
 *     },
 *     "specs": {                       // optional: schema spec per field, for
 *       "line_items": { ... }          // element_key matching + informational
 *     }                                // sub-field exclusion
 *   }
 *
 * Output is a JSON object on stdout:
 *
 *   {
 *     "scorer": "@koji/score",
 *     "scorer_version": "0.1.0",
 *     "total": 2, "matched": 2, "score": 1,
 *     "fields": { "policy_number": { "score": 1, "match": true, "diff": {...} } }
 *   }
 *
 * `scorer_version` is stamped on every result so run artifacts can record which
 * scorer produced them and refuse cross-version comparison.
 *
 * Exit codes: 0 scored (whatever the result), 1 bad usage or malformed input.
 * A mismatch is not an error — callers read the JSON.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { compareValues, type CompareSpec } from "./compare.js";

const require = createRequire(import.meta.url);
const { version: SCORER_VERSION } = require("../package.json") as { version: string };

interface FieldInput {
  expected?: unknown;
  got?: unknown;
}

interface ScoreInput {
  fields?: Record<string, FieldInput>;
  specs?: Record<string, CompareSpec>;
}

const USAGE = `koji-score — score extracted values against ground truth

  koji-score < input.json
  koji-score --input input.json
  koji-score --version

Input:  {"fields": {"<name>": {"expected": …, "got": …}}, "specs": {"<name>": {…}}}
Output: {"scorer_version": …, "total": …, "matched": …, "score": …, "fields": {…}}
`;

function fail(message: string): never {
  process.stderr.write(`koji-score: ${message}\n`);
  process.exit(1);
}

function readInput(argv: string[]): string {
  const flag = argv.indexOf("--input");
  if (flag !== -1) {
    const path = argv[flag + 1];
    if (!path) fail("--input needs a file path");
    try {
      return readFileSync(path, "utf8");
    } catch (err) {
      fail(`cannot read ${path}: ${(err as Error).message}`);
    }
  }
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    fail(`cannot read stdin: ${(err as Error).message}`);
  }
}

function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`${SCORER_VERSION}\n`);
    return;
  }

  const raw = readInput(argv);
  if (!raw.trim()) fail("empty input (expected JSON on stdin or --input)");

  let parsed: ScoreInput;
  try {
    parsed = JSON.parse(raw) as ScoreInput;
  } catch (err) {
    fail(`input is not valid JSON: ${(err as Error).message}`);
  }

  const fields = parsed.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail('input needs a "fields" object');
  }

  const specs = parsed.specs ?? {};
  const results: Record<string, unknown> = {};
  let matched = 0;
  let scoreSum = 0;
  let total = 0;

  for (const [name, field] of Object.entries(fields)) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) {
      fail(`field ${JSON.stringify(name)} must be an object with expected/got`);
    }
    const result = compareValues(field.expected, field.got, specs[name]);
    results[name] = result;
    total += 1;
    scoreSum += result.score;
    if (result.match) matched += 1;
  }

  process.stdout.write(
    `${JSON.stringify({
      scorer: "@koji/score",
      scorer_version: SCORER_VERSION,
      total,
      matched,
      // Mean of per-field scores. Callers that need presence recall /
      // fabrication rate split out (A3) compute them from `fields`.
      score: total > 0 ? scoreSum / total : 1,
      fields: results,
    })}\n`,
  );
}

main(process.argv.slice(2));
