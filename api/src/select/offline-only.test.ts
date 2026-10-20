/**
 * Adjudication is offline-only, and this is the test that keeps it that way.
 *
 * The call-time guard in `./adjudicate` throws unless a process armed
 * adjudication. That stops an accident at runtime, but it does not stop
 * someone *arming* it — a well-meaning `enableAdjudication("warm the cache")`
 * at the top of a route module would satisfy the guard forever and nothing
 * would fail. So the rule is also asserted structurally: no file on the
 * request path may reference these symbols at all.
 *
 * "Request path" here means the directories a document actually travels
 * through: route handlers, the ingestion DAG, and the job workers. Scoring,
 * the CLI and tests are free to use it — that is what it is for.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdjudicationNotEnabledError,
  adjudicationContext,
  adjudicationEnabled,
  disableAdjudication,
  enableAdjudication,
  NoAdjudicateProvider,
} from "./adjudicate";

const SRC = join(import.meta.dirname, "..");

/** Directories a document travels through at request time. */
const REQUEST_PATH_DIRS = ["routes", "ingestion", "jobs"];

/**
 * Symbols whose presence on the request path means adjudication has leaked
 * into it — whether by calling a judge or by arming the guard for one.
 */
const FORBIDDEN = [
  "enableAdjudication",
  "KOJI_ADJUDICATE",
  "AdjudicateProvider",
  "resolveAdjudicateProvider",
  "NoAdjudicateProvider",
  "LlmAdjudicateProvider",
  "JevAdjudicateProvider",
  "LayaAdjudicateProvider",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      // Tests may adjudicate freely; they are not the request path.
      if (entry.includes(".test.")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe("adjudication never reaches the request path", () => {
  it("finds the request-path directories it is supposed to be scanning", () => {
    // Without this, a renamed directory would turn the scan below into a
    // vacuous pass — the exact failure mode a structural test has to avoid.
    for (const dir of REQUEST_PATH_DIRS) {
      expect(statSync(join(SRC, dir)).isDirectory(), `src/${dir} should exist`).toBe(true);
      expect(sourceFiles(join(SRC, dir)).length).toBeGreaterThan(0);
    }
  });

  for (const dir of REQUEST_PATH_DIRS) {
    it(`src/${dir} references no adjudication symbol`, () => {
      const offenders: string[] = [];
      for (const file of sourceFiles(join(SRC, dir))) {
        const text = readFileSync(file, "utf8");
        for (const symbol of FORBIDDEN) {
          if (text.includes(symbol)) offenders.push(`${file.slice(SRC.length + 1)}: ${symbol}`);
        }
      }
      expect(
        offenders,
        "Adjudication is offline-only: it belongs to scoring, CI and corpus maintenance. " +
          "A model call here would double the latency of every field, make a hosted dependency " +
          "load-bearing for an OSS install, and let a judge rewrite a result with no trace.",
      ).toEqual([]);
    });
  }
});

describe("the call-time guard", () => {
  it("is disarmed by default", () => {
    disableAdjudication();
    delete process.env.KOJI_ADJUDICATE;
    expect(adjudicationEnabled()).toBe(false);
    expect(adjudicationContext()).toBeNull();
  });

  it("throws when a judge is called without being armed", async () => {
    disableAdjudication();
    delete process.env.KOJI_ADJUDICATE;
    await expect(new NoAdjudicateProvider().adjudicate()).rejects.toThrow(
      AdjudicationNotEnabledError,
    );
    await expect(new NoAdjudicateProvider().adjudicate()).rejects.toThrow(/offline-only/);
  });

  it("is armed by an explicit call, and records why", async () => {
    enableAdjudication("corpus maintenance run");
    try {
      expect(adjudicationEnabled()).toBe(true);
      expect(adjudicationContext()).toBe("corpus maintenance run");
      await expect(new NoAdjudicateProvider().adjudicate()).resolves.toMatchObject({
        provider: "none",
      });
    } finally {
      disableAdjudication();
    }
  });

  it("is armed by KOJI_ADJUDICATE=1, for a CI job", () => {
    disableAdjudication();
    process.env.KOJI_ADJUDICATE = "1";
    try {
      expect(adjudicationEnabled()).toBe(true);
      expect(adjudicationContext()).toBe("KOJI_ADJUDICATE=1");
    } finally {
      delete process.env.KOJI_ADJUDICATE;
    }
  });

  it("records a reason even when the caller gave a blank one", () => {
    enableAdjudication("   ");
    try {
      expect(adjudicationContext()).toBe("unspecified");
    } finally {
      disableAdjudication();
    }
  });
});

describe("NoAdjudicateProvider — the zero-dependency default", () => {
  it("has no opinion, and says so with zero confidence", async () => {
    enableAdjudication("unit test");
    try {
      const result = await new NoAdjudicateProvider().adjudicate();
      // `equivalent: false` with confidence 0 means "the scorer's verdict
      // stands", not "these values differ" — a caller gating on confidence
      // will correctly ignore it.
      expect(result.equivalent).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.calibrated).toBe(false);
      expect(result.reason).toMatch(/no adjudicator configured/);
    } finally {
      disableAdjudication();
    }
  });
});
