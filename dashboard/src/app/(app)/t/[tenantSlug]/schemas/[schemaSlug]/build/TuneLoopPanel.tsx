"use client";

/**
 * Auto-tune panel — the human-facing driver for the autonomous tuning loop.
 *
 * Runs `POST /api/schemas/:slug/tune/loop` against the selected labeled exemplar,
 * streams each iteration (accuracy climbing, which fields still fail, the model's
 * reasoning), and on convergence lets the human APPLY the improved schema. The
 * two safety gates follow: validate the applied schema across the WHOLE corpus,
 * then promote — the promote is server-gated on no regressions, so a schema that
 * helped the exemplar but hurt other docs can't ship.
 */

import { useState, useCallback } from "react";
import { Play, Check, Loader2, Sparkles, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { api } from "@/lib/api";
import { runTuneLoopStream, type LoopIteration, type LoopResult } from "@/lib/tune-loop-stream";

interface Props {
  schemaSlug: string;
  tenantSlug: string;
  entryId: string | null;
  filename?: string;
  hasGroundTruth?: boolean;
  yaml: string;
  model?: string;
  /** Apply the improved schema into the editor. */
  onApply: (yaml: string) => void;
}

interface ValidateResult {
  overallAccuracy: number;
  docsPassed: number;
  docsTotal: number;
  passed: boolean;
  regressions: Array<{ name: string }>;
}

type Phase = "idle" | "running" | "done" | "applied";

const STOP_LABEL: Record<LoopResult["stopReason"], string> = {
  passed: "Passed — schema extracts every labeled field",
  stuck_no_proposal: "Stopped — the model had no further fix to propose",
  stuck_no_improvement: "Stopped — recent iterations stopped improving",
  max_iterations: "Reached the iteration limit",
  compile_error: "Stopped — a proposed schema failed to compile",
};

function accColor(a: number): string {
  return a >= 95 ? "text-green" : a >= 70 ? "text-yellow-600" : "text-vermillion-2";
}

export function TuneLoopPanel({ schemaSlug, tenantSlug, entryId, filename, hasGroundTruth, yaml, model, onApply }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [iterations, setIterations] = useState<LoopIteration[]>([]);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Corpus gate state
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!entryId) return;
    setPhase("running");
    setIterations([]);
    setResult(null);
    setError(null);
    setValidateResult(null);
    setPromoted(null);
    setGateError(null);
    try {
      await runTuneLoopStream({
        schemaSlug,
        tenantSlug,
        corpusEntryId: entryId,
        yaml,
        model,
        maxIterations: 5,
        onIteration: (it) => setIterations((prev) => [...prev, it]),
        onComplete: (r) => {
          setResult(r);
          setPhase("done");
        },
        onError: (e) => {
          setError(e);
          setPhase("idle");
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tuning loop failed");
      setPhase("idle");
    }
  }, [entryId, schemaSlug, tenantSlug, yaml, model]);

  const apply = () => {
    if (result) {
      onApply(result.finalYaml);
      setPhase("applied");
    }
  };

  const validateCorpus = async () => {
    if (!result) return;
    setValidating(true);
    setGateError(null);
    try {
      // Snapshots the improved schema as a candidate (not activated) and scores
      // it against every ground-truthed corpus doc.
      const r = await api.post<ValidateResult>(`/api/schemas/${schemaSlug}/validate`, { yaml: result.finalYaml });
      setValidateResult(r);
    } catch (e) {
      setGateError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  };

  const promote = async () => {
    setPromoting(true);
    setGateError(null);
    try {
      const r = await api.post<{ released: string }>(`/api/schemas/${schemaSlug}/promote`, { requireNoRegressions: true });
      setPromoted(r.released);
    } catch (e) {
      // The server refuses (409) when the candidate regressed other docs.
      setGateError(e instanceof Error ? e.message : "Promote failed — resolve regressions first");
    } finally {
      setPromoting(false);
    }
  };

  const canRun = !!entryId && !!hasGroundTruth && phase !== "running";

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-ink-3">Auto-tune</span>
        <span className="text-[10px] font-mono text-ink-4 truncate max-w-[160px]" title={filename}>{filename ?? "—"}</span>
      </div>

      {!hasGroundTruth && (
        <p className="text-[11px] text-ink-4">
          Select a document that has ground truth. Auto-tune improves the schema until it extracts every labeled field.
        </p>
      )}

      {phase === "idle" && (
        <button
          type="button"
          disabled={!canRun}
          onClick={run}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Auto-tune this schema
        </button>
      )}

      {error && <p className="text-[11px] text-vermillion-2">{error}</p>}

      {/* Live iteration timeline */}
      {(phase === "running" || iterations.length > 0) && (
        <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
          {iterations.map((it) => (
            <div key={it.n} className="px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-4 font-mono">Round {it.n}</span>
                <span className={`text-[11px] font-mono font-medium ${accColor(it.accuracy)}`}>{it.accuracy.toFixed(1)}%</span>
              </div>
              {it.failing.length > 0 && (
                <div className="text-[10px] text-vermillion-2 font-mono mt-0.5">still failing: {it.failing.join(", ")}</div>
              )}
              {it.explanation && <div className="text-[11px] text-ink-3 mt-1">{it.explanation}</div>}
            </div>
          ))}
          {phase === "running" && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-ink-4">
              <Loader2 className="w-3 h-3 animate-spin" /> tuning…
            </div>
          )}
        </div>
      )}

      {/* Result + apply */}
      {result && (phase === "done" || phase === "applied") && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-ink-3">Final:</span>
            <span className={`font-mono font-medium ${accColor(result.finalAccuracy)}`}>{result.finalAccuracy.toFixed(1)}%</span>
            <span className="text-ink-4 text-[11px]">· {STOP_LABEL[result.stopReason]}</span>
          </div>
          {phase === "done" && (
            <button
              type="button"
              onClick={apply}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-cream-2 text-ink border border-border hover:border-ink transition-colors"
            >
              <Check className="w-3.5 h-3.5" /> Apply improved schema
            </button>
          )}
        </div>
      )}

      {/* Corpus gate: validate → promote */}
      {phase === "applied" && (
        <div className="space-y-2 border-t border-dotted border-border pt-3">
          <p className="text-[11px] text-ink-4">
            Applied to the editor. Before shipping, check it across the whole corpus so a fix here doesn’t regress other documents.
          </p>
          {!validateResult ? (
            <button
              type="button"
              disabled={validating}
              onClick={validateCorpus}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors disabled:opacity-50"
            >
              {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {validating ? "Validating across corpus…" : "Validate across corpus"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-ink-3">Corpus:</span>
                <span className={`font-mono font-medium ${accColor(validateResult.overallAccuracy)}`}>{validateResult.overallAccuracy.toFixed(1)}%</span>
                <span className="text-ink-4 text-[11px]">· {validateResult.docsPassed}/{validateResult.docsTotal} docs</span>
              </div>
              {validateResult.regressions.length > 0 && (
                <div className="flex items-start gap-1.5 text-[11px] text-vermillion-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>Regressions: {validateResult.regressions.map((r) => r.name).join(", ")} — promotion is blocked until resolved.</span>
                </div>
              )}
              {!promoted ? (
                <button
                  type="button"
                  disabled={promoting || validateResult.regressions.length > 0}
                  onClick={promote}
                  className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40"
                >
                  {promoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
                  {promoting ? "Promoting…" : "Promote to live"}
                </button>
              ) : (
                <div className="flex items-center gap-1.5 text-[12px] text-green">
                  <Check className="w-3.5 h-3.5" /> Promoted {promoted} to live.
                </div>
              )}
            </div>
          )}
          {gateError && <p className="text-[11px] text-vermillion-2">{gateError}</p>}
        </div>
      )}
    </div>
  );
}
