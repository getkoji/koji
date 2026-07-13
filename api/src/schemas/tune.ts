/**
 * Schema-tuning loop — one iteration.
 *
 * The build agent proposes schema edits blind (from a chat message + a raw
 * document excerpt). This closes the loop: it runs the current schema against a
 * labeled exemplar, MEASURES where it fails (per-field score + routing
 * diagnosis vs. ground truth), and asks the model to propose a minimal edit
 * grounded in that evidence. One call = one iteration; the autonomous loop
 * (a follow-up) drives this repeatedly until the exemplar passes.
 *
 * Everything here reuses tested machinery — the parse seam + `extractFields`
 * (single-doc, no schema_run rows), `computeValidateResult` for scoring +
 * `RoutingDiagnosis`, and the agent's LLM/parse plumbing — so the only new
 * logic is the diagnosis→prompt bridge (`buildTunePrompt`).
 */

import type { Db, RlsScope } from "@koji/db";
import type { StorageProvider } from "../storage/provider";
import type { ParseProvider } from "../parse/provider";
import type { ParseConfig } from "../parse/factory";
import { resolveParse, parseDocument } from "../ingestion/seam";
import { resolveMimeType } from "../ingestion/mime";
import { createProvider, extractFields } from "../extract";
import {
  resolveExtractEndpoint,
  pickActiveTenantModel,
  resolveTenantProvider,
} from "../extract/resolve-endpoint";
import { computeValidateResult } from "./validate-scoring";
import { compileSchema } from "./compiler";
import {
  buildTunePrompt,
  parseAgentResponse,
  type TuneFieldReport,
} from "../extract/agent-prompt";

export interface TuneEntry {
  id: string;
  filename: string;
  storageKey: string;
  mimeType: string;
  contentHash: string;
}

export interface TuneIterationArgs {
  db: Db;
  storage: StorageProvider;
  scope: RlsScope;
  tenantId: string;
  defaultParseProvider: ParseProvider;
  parseConfig: ParseConfig | null;
  /** The exemplar corpus entry to tune against. */
  entry: TuneEntry;
  /** Its ground-truth values (denormalized `groundTruthJson`). */
  groundTruth: Record<string, unknown>;
  /** The current schema YAML being tuned. */
  yaml: string;
  /** Compiled form of `yaml` (caller already validated it). */
  schemaDef: Record<string, unknown>;
  /** Extraction model preference; falls back to the tenant default. */
  model?: string;
}

export interface TuneIterationResult {
  before: {
    accuracy: number;
    passed: boolean;
    failing: TuneFieldReport[];
  };
  /** The model's proposed schema, or null if it produced no valid YAML. */
  proposedYaml: string | null;
  explanation: string;
  /** Set when the proposal failed to compile even after a retry. */
  compileError?: string;
}

function stringify(v: unknown): string {
  if (v == null) return "(nothing)";
  if (typeof v === "string") return v.length ? v : "(empty)";
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** Turn a per-field RoutingDiagnosis into a plain-language repair hint. */
function routingHint(diag: { answerInRoutedChunks?: boolean | null } | null | undefined): string {
  if (!diag || diag.answerInRoutedChunks == null) return "could not determine where it went wrong";
  return diag.answerInRoutedChunks
    ? "model saw the text but chose the wrong value (fix the field description/hint)"
    : "model never saw the answer — routing miss (fix look_in / add hints)";
}

/**
 * Run one tuning iteration: extract the exemplar, score it against ground
 * truth, and (if anything failed) ask the model for a minimal fix.
 */
export async function runTuneIteration(args: TuneIterationArgs): Promise<TuneIterationResult> {
  const { db, storage, scope, tenantId, entry, groundTruth, yaml, schemaDef, model } = args;
  const startTime = Date.now();

  // 1. Parse + extract this one document (no schema_run persistence — this is
  //    an ephemeral proposal, not a committed run).
  const { provider: parseProvider, fingerprint } = await resolveParse(db, scope, {
    parseProviderId: null,
    defaultProvider: args.defaultParseProvider,
    parseConfig: args.parseConfig,
  });
  const mimeType = resolveMimeType(entry.mimeType, entry.filename, undefined);
  const parsed = await parseDocument({
    db,
    storage,
    tenantId,
    document: {
      id: entry.id,
      storageKey: entry.storageKey,
      filename: entry.filename,
      mimeType,
      contentHash: entry.contentHash,
    },
    provider: parseProvider,
    fingerprint,
  });
  if (!parsed.markdown) throw new Error("parse returned empty markdown");

  // Resolve the extraction model/endpoint (BYO tenant key → env fallback).
  let endpointPayload = null;
  try {
    const found = await pickActiveTenantModel(db, scope, model ?? null);
    if (found) endpointPayload = await resolveExtractEndpoint(db, scope, found);
  } catch {
    // fall through to env default
  }
  const extractModel = model ?? endpointPayload?.model ?? process.env.KOJI_EXTRACT_MODEL ?? "gpt-4o-mini";
  const extractProvider = createProvider(extractModel, endpointPayload);
  const extractResult = await extractFields(
    parsed.markdown,
    schemaDef,
    extractProvider,
    extractModel,
    parsed.textMap,
    parsed.chunks,
  );

  // 2. Score + diagnose against ground truth. computeValidateResult is pure and
  //    works for a single doc: pass a one-element results array, no prior
  //    baseline. Failing fields carry a per-field diff + RoutingDiagnosis
  //    (built from the routing_plan) — exactly the evidence the tuner needs.
  const schemaFields = (schemaDef.fields as Record<string, Record<string, unknown>>) ?? {};
  const result = computeValidateResult(
    [
      {
        entryId: entry.id,
        filename: entry.filename,
        groundTruth,
        extracted: extractResult.extracted ?? {},
        confidenceScores: extractResult.confidence_scores ?? {},
        routingPlan: (extractResult.routing_plan as never) ?? undefined,
      },
    ],
    new Map(),
    0,
    startTime,
    [],
    schemaFields,
  );

  const failing: TuneFieldReport[] = result.fields
    .filter((f) => f.status !== "pass")
    .map((f) => {
      const doc = f.failingDocs[0];
      return {
        name: f.name,
        expected: stringify(groundTruth[f.name]),
        got: stringify(extractResult.extracted?.[f.name]),
        routingHint: routingHint(doc?.routingDiagnosis),
      };
    });

  const before = {
    accuracy: result.overallAccuracy,
    passed: failing.length === 0,
    failing,
  };

  // 3. Nothing failed → nothing to propose.
  if (before.passed) {
    return { before, proposedYaml: null, explanation: "Schema already passes on this document — no changes proposed." };
  }

  // 4. Ask the model for a minimal fix, grounded in the failure report.
  const { provider } = await resolveTenantProvider(db, scope, model ? { preferModel: model } : undefined);
  const prompt = buildTunePrompt(yaml, {
    accuracy: before.accuracy,
    failing,
    markdown_head: parsed.markdown.slice(0, 2000),
    doc_type: undefined,
  });
  const raw = await provider.generate(prompt, false);
  let parsedResp = parseAgentResponse(raw);

  // Validate the proposal; one retry feeding the compiler error back, mirroring
  // the build agent's contract.
  if (parsedResp.yaml) {
    try {
      compileSchema(parsedResp.yaml);
    } catch (compileErr) {
      const errMsg = compileErr instanceof Error ? compileErr.message : String(compileErr);
      const retryPrompt = `${prompt}\n\n### Tuner\n${raw}\n\n### System\nThat schema failed to compile: ${errMsg}\nReturn corrected COMPLETE YAML in a <yaml> block.\n\n### Tuner`;
      const retryRaw = await provider.generate(retryPrompt, false);
      const retryParsed = parseAgentResponse(retryRaw);
      if (retryParsed.yaml) {
        try {
          compileSchema(retryParsed.yaml);
          parsedResp = retryParsed;
        } catch (retryErr) {
          return {
            before,
            proposedYaml: null,
            explanation: parsedResp.explanation,
            compileError: retryErr instanceof Error ? retryErr.message : String(retryErr),
          };
        }
      }
    }
  }

  return {
    before,
    proposedYaml: parsedResp.yaml,
    explanation: parsedResp.explanation,
  };
}
