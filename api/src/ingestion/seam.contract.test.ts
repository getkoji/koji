/**
 * Seam contract (oss-310 step 8).
 *
 * The extraction seam exists so every surface turns a stored document into an
 * extraction through ONE path: resolve provider → parse (+cache) → shape the
 * flat text_map into the nested provenance form. The three production bugs that
 * motivated it (oss-307 MIME, oss-308 wrong provider, oss-309 flat text_map)
 * were each a new surface re-implementing that glue slightly differently.
 *
 * This test is the tripwire: it fails if a NEW call site parses through a
 * provider's `.parse()` directly instead of going through `parseDocument`
 * (which caches + shapes the text_map). A raw `.parse()` bypasses the cache AND
 * the flat→nested conversion — exactly how the drift crept back in before.
 *
 * A small allowlist covers the legitimate direct callers: the seam's own cache
 * primitive, and the genuinely stateless / in-memory flows that operate on a
 * buffer with no stored doc to cache. Adding to it should be a deliberate,
 * reviewed choice — not an accident.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Paths are relative to `api/src`. A file here may call `parseProvider.parse()`
// directly; every other file must go through `parseDocument`.
const ALLOWED = new Set<string>([
  "ingestion/process.ts", // getOrParse — the shared, provider-fingerprinted parse cache primitive itself
  "routes/pipelines.ts", // in-memory test-pipeline flow + ephemeral child-doc slices (no stored doc/contentHash)
  "routes/forms.ts", // one-shot form-fingerprint generation (no stored doc)
  "routes/extract.ts", // one-shot /process + /parse uploads (no stored doc/contentHash to cache against)
]);

// Matches `parseProvider.parse(` and `<x>.parseProvider.parse(` — the naming
// convention every surface uses. New copy-pasted drift will use it too.
const RAW_PARSE = /\bparseProvider\.parse\(/;

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("extraction seam contract", () => {
  it("no surface parses through a raw parseProvider.parse() outside the seam allowlist", () => {
    // vitest runs with cwd = the `api` package dir.
    const srcRoot = join(process.cwd(), "src");
    const offenders: string[] = [];

    for (const file of collectTsFiles(srcRoot)) {
      const rel = file.slice(srcRoot.length + 1).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      if (RAW_PARSE.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }

    expect(
      offenders,
      `Raw parseProvider.parse() found outside the seam. Parse through parseDocument ` +
        `(api/src/ingestion/seam.ts) so the call is cached and its text_map is shaped to the ` +
        `nested provenance form — or, if this is a genuinely stateless/in-memory flow, add the ` +
        `file to ALLOWED in this test with a justification. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the allowlist stays small — every entry is a deliberate exception", () => {
    // Guardrail on the guardrail: if this grows, the seam is leaking.
    expect(ALLOWED.size).toBeLessThanOrEqual(4);
  });
});
