/**
 * Guard for the rule in dashboard/CLAUDE.md: tenant-scoped pages never call
 * `fetch()` directly.
 *
 * Hand-rolled fetches skip the shared client's headers. The build page kept a
 * private copy of the extract/run fetch and omitted `x-koji-project`, so every
 * Run in a non-default project 404'd (oss-481) — invisible to typecheck, build,
 * and every existing test. Anything under src/app/(app) must go through
 * `@/lib/api` or a shared runner in `@/lib` (which is where the header logic
 * lives, and where it gets unit-tested).
 *
 * Pages outside (app) — the setup/tenant picker and the public embed viewer —
 * are deliberately unscoped and out of range here.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(__dirname, "../app/(app)");

/** `fetch(` not preceded by an identifier char or dot (skips `refetch(`). */
const RAW_FETCH = /(^|[^\w.])fetch\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [full] : [];
  });
}

describe("tenant-scoped pages use the shared API client", () => {
  it("has no raw fetch() calls under src/app/(app)", () => {
    const offenders = walk(APP_DIR)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter(({ text }) => RAW_FETCH.test(text)),
      )
      .map(({ file, line, text }) => `${path.relative(APP_DIR, file)}:${line}: ${text.trim()}`);

    expect(offenders).toEqual([]);
  });
});
