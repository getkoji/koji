/**
 * Corpus-optimizing tune loop (oss-447).
 *
 * The single-doc loop optimized one exemplar and used the corpus only as a final
 * gate — which overfits. This optimizes the WHOLE corpus, exemplar-guided: each
 * round scores the schema across every labeled doc, focuses on a failing one to
 * decide what to change, proposes an edit, then RE-SCORES the whole corpus and
 * keeps the edit only if corpus accuracy went up (so a fix that regresses other
 * docs is rejected; the next round targets whatever now fails, regressions
 * included). This mirrors the by-hand Claude-Code workflow: use a broken doc to
 * guide the schema while maximizing for the corpus.
 */

import type { Db, RlsScope } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import type { ModelProvider } from "../extract/providers";
import { mapWithConcurrency } from "../parse/pdf-slice";
import { computeValidateResult } from "./validate-scoring";
import { compileSchema } from "./compiler";
import { extractEntryValues, type EntryExtraction } from "./tune";
import { resolveTenantProvider } from "../extract/resolve-endpoint";
import { buildTunePrompt, parseAgentResponse, type TuneFieldReport } from "../extract/agent-prompt";

const SCORE_CONCURRENCY = 3;
const NO_IMPROVEMENT_LIMIT = 3;
/** Corpus accuracy at/above which we consider the schema good enough. */
const DEFAULT_TARGET = 100;

export interface CorpusEntryWithGt {
  id: string;
  filename: string;
  storageKey: string;
  mimeType: string;
  contentHash: string;
  groundTruth: Record<string, unknown>;
}

interface LoopDeps {
  db: Db;
  storage: StorageProvider;
  scope: RlsScope;
  tenantId: string;
  defaultParseProvider: ParseProvider;
  parseConfig: ParseConfig | null;
}

export interface CorpusTuneRound {
  n: number;
  /** Corpus accuracy of the schema in effect after this round. */
  accuracy: number;
  docsPassed: number;
  docsTotal: number;
  /** Whether the proposal beat the previous best and was kept. */
  accepted: boolean;
  /** The failing doc that guided this round's proposal. */
  focusDoc: string;
  /** Fields the proposal targeted. */
  fixing: string[];
  /** Fields that regressed vs. the previous best (empty when clean). */
  regressions: string[];
  explanation: string;
}

export interface CorpusTuneResult {
  rounds: CorpusTuneRound[];
  finalYaml: string;
  finalAccuracy: number;
  baselineAccuracy: number;
  stopReason: "passed" | "no_improvement" | "max_iterations" | "propose_failed";
}

export interface RunCorpusTuneLoopArgs extends LoopDeps {
  entries: CorpusEntryWithGt[];
  startYaml: string;
  model?: string;
  maxIterations?: number;
  onRound?: (r: CorpusTuneRound) => Promise<void> | void;
  onEdit?: (n: number, yaml: string, explanation: string) => Promise<void> | void;
}

function stringify(v: unknown): string {
  if (v == null) return "(nothing)";
  if (typeof v === "string") return v.length ? v : "(empty)";
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function routingHint(diag: { answerInRoutedChunks?: boolean | null } | null | undefined): string {
  if (!diag || diag.answerInRoutedChunks == null) return "could not determine where it went wrong";
  return diag.answerInRoutedChunks
    ? "model saw the text but chose the wrong value (fix the field description/guidance)"
    : "model never saw the answer — routing miss (add extraction_guidance / narrow the section)";
}

type ScoreResult = ReturnType<typeof computeValidateResult>;

/** Extract + score every labeled corpus doc — no schema_run persistence. */
async function scoreCorpus(
  deps: LoopDeps,
  entries: CorpusEntryWithGt[],
  schemaDef: Record<string, unknown>,
  model: string | undefined,
  prevExtractedMap: Map<string, Record<string, unknown>>,
): Promise<{ result: ScoreResult; extractedByEntry: Map<string, EntryExtraction> }> {
  const perDoc = await mapWithConcurrency(entries, SCORE_CONCURRENCY, async (e) => {
    try {
      const ex = await extractEntryValues({ ...deps, entry: e, schemaDef, model });
      return { entry: e, ex };
    } catch {
      return null; // parse/extract failure — dropped from scoring this round
    }
  });
  const ok = perDoc.filter((x): x is { entry: CorpusEntryWithGt; ex: EntryExtraction } => x != null);
  const extractedByEntry = new Map(ok.map((x) => [x.entry.id, x.ex]));
  const results = ok.map((x) => ({
    entryId: x.entry.id,
    filename: x.entry.filename,
    groundTruth: x.entry.groundTruth,
    extracted: x.ex.extracted,
    confidenceScores: x.ex.confidenceScores,
    routingPlan: (x.ex.routingPlan as never) ?? undefined,
  }));
  const schemaFields = (schemaDef.fields as Record<string, Record<string, unknown>>) ?? {};
  const result = computeValidateResult(results, prevExtractedMap, 0, Date.now(), [], schemaFields);
  return { result, extractedByEntry };
}

/** From a corpus score, pick the failing doc to focus on + its failing-field report. */
function pickFocus(
  result: ScoreResult,
  entryById: Map<string, CorpusEntryWithGt>,
  extractedByEntry: Map<string, EntryExtraction>,
): { docId: string; filename: string; markdown: string; failing: TuneFieldReport[] } | null {
  const failingFields = result.fields.filter((f) => f.status !== "pass" && f.failingDocs.length > 0);
  if (failingFields.length === 0) return null;
  // Focus on the doc under the worst-scoring field.
  const worst = [...failingFields].sort((a, b) => a.accuracy - b.accuracy)[0]!;
  const docId = worst.failingDocs[0]!.id;
  const entry = entryById.get(docId);
  const ex = extractedByEntry.get(docId);
  if (!entry || !ex) return null;
  // Gather every field this focus doc fails, with its diagnosis.
  const failing: TuneFieldReport[] = [];
  for (const f of failingFields) {
    const fd = f.failingDocs.find((d) => d.id === docId);
    if (!fd) continue;
    failing.push({
      name: f.name,
      expected: stringify(entry.groundTruth[f.name]),
      got: stringify(ex.extracted[f.name]),
      routingHint: routingHint(fd.routingDiagnosis),
    });
  }
  return { docId, filename: entry.filename, markdown: ex.markdown, failing };
}

/** Ask the model for an edit; validate it compiles (one retry). Returns null on failure. */
async function proposeEdit(
  provider: ModelProvider,
  currentYaml: string,
  accuracy: number,
  focus: { markdown: string; failing: TuneFieldReport[] },
): Promise<{ yaml: string; explanation: string } | null> {
  const prompt = buildTunePrompt(currentYaml, {
    accuracy,
    failing: focus.failing,
    markdown_head: focus.markdown.slice(0, 2000),
  });
  const raw = await provider.generate(prompt, false);
  const parsed = parseAgentResponse(raw);
  if (!parsed.yaml) return null;
  if (compileSchema(parsed.yaml).ok) return { yaml: parsed.yaml, explanation: parsed.explanation };
  // one retry with the compiler errors
  const errs = compileSchema(parsed.yaml);
  const errMsg = errs.ok ? "" : errs.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join("; ");
  const retryRaw = await provider.generate(
    `${prompt}\n\n### Tuner\n${raw}\n\n### System\nThat schema is invalid: ${errMsg}\nReturn corrected COMPLETE YAML in a <yaml> block, using ONLY properties from the spec.\n\n### Tuner`,
    false,
  );
  const retry = parseAgentResponse(retryRaw);
  if (retry.yaml && compileSchema(retry.yaml).ok) return { yaml: retry.yaml, explanation: retry.explanation };
  return null;
}

const valuesOf = (m: Map<string, EntryExtraction>): Map<string, Record<string, unknown>> =>
  new Map([...m].map(([id, ex]) => [id, ex.extracted]));

export async function runCorpusTuneLoop(args: RunCorpusTuneLoopArgs): Promise<CorpusTuneResult> {
  const { entries, startYaml, model, onRound, onEdit, ...deps } = args;
  const max = Math.max(1, Math.min(args.maxIterations ?? 5, 8));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const { provider } = await resolveTenantProvider(deps.db, deps.scope, model ? { preferModel: model } : undefined);

  const startCompiled = compileSchema(startYaml);
  if (!startCompiled.ok) throw new Error("starting schema is invalid");

  const empty = new Map<string, Record<string, unknown>>();
  let best = await scoreCorpus(deps, entries, startCompiled.parsed as Record<string, unknown>, model, empty);
  let bestYaml = startYaml;
  let bestAcc = best.result.overallAccuracy;
  const baselineAccuracy = bestAcc;
  const rounds: CorpusTuneRound[] = [];
  let noImprovement = 0;
  let stopReason: CorpusTuneResult["stopReason"] = "max_iterations";

  for (let n = 1; n <= max; n++) {
    if (bestAcc >= DEFAULT_TARGET) {
      stopReason = "passed";
      break;
    }
    const focus = pickFocus(best.result, entryById, best.extractedByEntry);
    if (!focus) {
      stopReason = "passed"; // nothing failing to fix
      break;
    }
    const proposal = await proposeEdit(provider, bestYaml, bestAcc, focus);
    if (!proposal) {
      noImprovement++;
      rounds.push({ n, accuracy: bestAcc, docsPassed: best.result.docsPassed, docsTotal: best.result.docsTotal, accepted: false, focusDoc: focus.filename, fixing: focus.failing.map((f) => f.name), regressions: [], explanation: "No valid proposal produced." });
      await onRound?.(rounds[rounds.length - 1]!);
      if (noImprovement >= NO_IMPROVEMENT_LIMIT) { stopReason = "no_improvement"; break; }
      continue;
    }

    // Re-score the proposal across the corpus, measuring regressions vs. the best.
    const compiledProp = compileSchema(proposal.yaml);
    const scored = compiledProp.ok
      ? await scoreCorpus(deps, entries, compiledProp.parsed as Record<string, unknown>, model, valuesOf(best.extractedByEntry))
      : null;
    // Accept any non-regressing proposal (>= best AND no field regressed), not
    // just strictly-better ones — a lateral step lets the schema evolve toward a
    // later win (a fix often takes two rounds to land), while never shipping a
    // regression. Strict improvement is tracked separately to detect a stall.
    const improved = scored != null && scored.result.overallAccuracy > bestAcc;
    const accepted =
      scored != null && scored.result.overallAccuracy >= bestAcc && scored.result.regressions.length === 0;

    const round: CorpusTuneRound = {
      n,
      accuracy: accepted ? scored!.result.overallAccuracy : bestAcc,
      docsPassed: accepted ? scored!.result.docsPassed : best.result.docsPassed,
      docsTotal: best.result.docsTotal,
      accepted,
      focusDoc: focus.filename,
      fixing: focus.failing.map((f) => f.name),
      regressions: scored ? scored.result.regressions.map((r) => r.name) : [],
      explanation: proposal.explanation,
    };
    rounds.push(round);
    await onRound?.(round);

    if (accepted) {
      bestYaml = proposal.yaml;
      bestAcc = scored!.result.overallAccuracy;
      best = scored!;
      await onEdit?.(n, proposal.yaml, proposal.explanation);
    }
    // Stall detection keys on STRICT improvement, so a run of lateral (or
    // rejected) rounds that never actually raises accuracy still terminates.
    if (improved) noImprovement = 0;
    else noImprovement++;
    if (noImprovement >= NO_IMPROVEMENT_LIMIT) { stopReason = "no_improvement"; break; }
  }

  return { rounds, finalYaml: bestYaml, finalAccuracy: bestAcc, baselineAccuracy, stopReason };
}
