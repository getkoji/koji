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
 *       "line_items": { ... }          // element_key matching, informational
 *     }                                // sub-fields, and declared `match:`
 *   }
 *
 * Output is a JSON object on stdout:
 *
 *   {
 *     "scorer": "@koji/score",
 *     "scorer_version": "0.2.0",
 *     "total": 2, "matched": 2,
 *     "metrics": {
 *       "presence_recall": 1, "value_accuracy": 1,
 *       "fabrication_rate": null, "null_agreement": null,
 *       "counts": { "present": 2, "found": 2, ... }
 *     },
 *     "fields": {
 *       "policy_number": {
 *         "score": 1, "match": true, "bucket": "found",
 *         "expected_present": true, "got_present": true, "diff": {...}
 *       }
 *     }
 *   }
 *
 * There is deliberately no single `score`. It used to be the mean of every
 * field's credit, which counted a correctly-declined field as a pass and so
 * gave a document that extracted nothing a floor of whatever fraction of its
 * fields are legitimately empty (19.2% on the reference corpus run). The four
 * metrics in `metrics` replace it; `metrics.ts` explains why each is separate,
 * and per-field `bucket` / `expected_present` / `got_present` let an external
 * harness recompute them over any slice it likes.
 *
 * `scorer_version` is stamped on every result so run artifacts record which
 * scorer produced them and can refuse cross-version comparison.
 *
 * Exit codes: 0 scored (whatever the result), 1 bad usage or malformed input.
 * A mismatch is not an error — callers read the JSON.
 */

import { readFileSync } from "node:fs";

import { type CompareSpec } from "./compare.js";
import { emptyCounts, fieldOutcome, metricsFromCounts, tally } from "./metrics.js";
import { SCORER_NAME, SCORER_VERSION } from "./version.js";

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
Output: {"scorer_version": …, "total": …, "matched": …, "metrics": {…}, "fields": {…}}

Reports four metrics, never one accuracy number: presence_recall and
value_accuracy over the fields ground truth has a value for, fabrication_rate
and null_agreement over the fields it leaves empty.
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

/** Round a metric for output, or pass `null` through untouched. */
function round(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
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
  const counts = emptyCounts();
  let matched = 0;
  let total = 0;

  for (const [name, field] of Object.entries(fields)) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) {
      fail(`field ${JSON.stringify(name)} must be an object with expected/got`);
    }
    const outcome = fieldOutcome(field.expected, field.got, specs[name]);
    // Per-field bucket and presence flags travel with the result so a harness
    // can recompute the metrics over its own slices (per category, per field
    // type) without reimplementing the classification.
    results[name] = {
      score: outcome.score,
      match: outcome.match,
      bucket: outcome.bucket,
      expected_present: outcome.expectedPresent,
      got_present: outcome.gotPresent,
      diff: outcome.result.diff,
    };
    total += 1;
    if (outcome.match) matched += 1;
    tally(counts, outcome);
  }

  const metrics = metricsFromCounts(counts);

  process.stdout.write(
    `${JSON.stringify({
      scorer: SCORER_NAME,
      scorer_version: SCORER_VERSION,
      total,
      // Exact-match field count over EVERY field, including correctly-absent
      // ones. A count, not a rate — `matched / total` is the ratio that had the
      // all-null floor, which is why no such ratio is emitted here.
      matched,
      metrics: {
        presence_recall: round(metrics.presenceRecall),
        value_accuracy: round(metrics.valueAccuracy),
        fabrication_rate: round(metrics.fabricationRate),
        null_agreement: round(metrics.nullAgreement),
        counts: { ...metrics.counts, credit: round(metrics.counts.credit) },
      },
      fields: results,
    })}\n`,
  );
}

main(process.argv.slice(2));
