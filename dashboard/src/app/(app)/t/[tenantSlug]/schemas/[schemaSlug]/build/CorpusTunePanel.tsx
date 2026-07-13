"use client";

/**
 * Auto-tune (corpus) — drives the corpus-optimizing loop from the Agent tab.
 *
 * Runs `POST /api/schemas/:slug/tune/corpus-loop`: each round scores the schema
 * across the WHOLE corpus, focuses on a failing doc to guide the edit, and keeps
 * the change only if corpus accuracy improved without regressing. Streams the
 * rounds live (accuracy, which doc guided it, what it fixed, any regressions),
 * then lets the human apply the improved schema and promote it — the promote is
 * server-gated on no regressions.
 */

import { useState, useCallback } from "react";
import { Check, Loader2, Sparkles, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { api } from "@/lib/api";
import { runCorpusTuneLoopStream, type LoopRound, type LoopResult } from "@/lib/tune-loop-stream";

interface Props {
  schemaSlug: string;
  tenantSlug: string;
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
  passed: "Passed — every labeled field extracts across the corpus",
  no_improvement: "Stopped — recent rounds stopped improving",
  max_iterations: "Reached the round limit",
  propose_failed: "Stopped — the model had no further fix to propose",
};

function accColor(a: number): string {
  return a >= 95 ? "text-green" : a >= 70 ? "text-yellow-600" : "text-vermillion-2";
}

export function CorpusTunePanel({ schemaSlug, tenantSlug, yaml, model, onApply }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [rounds, setRounds] = useState<LoopRound[]>([]);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPhase("running");
    setRounds([]);
    setResult(null);
    setError(null);
    setValidateResult(null);
    setPromoted(null);
    setGateError(null);
    try {
      await runCorpusTuneLoopStream({
        schemaSlug,
        tenantSlug,
        yaml,
        model,
        maxIterations: 5,
        onRound: (r) => setRounds((prev) => [...prev, r]),
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
  }, [schemaSlug, tenantSlug, yaml, model]);

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
      setGateError(e instanceof Error ? e.message : "Promote failed — resolve regressions first");
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="p-3 space-y-3 overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-ink-3">Auto-tune across the corpus</span>
      </div>
      <p className="text-[11px] text-ink-4">
        Iteratively improves the schema against every labeled document, keeping only changes that raise
        overall accuracy without regressing other docs.
      </p>

      {phase === "idle" && (
        <button
          type="button"
          onClick={run}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Auto-tune this schema
        </button>
      )}

      {error && <p className="text-[11px] text-vermillion-2">{error}</p>}

      {(phase === "running" || rounds.length > 0) && (
        <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
          {rounds.map((r) => (
            <div key={r.n} className="px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-4 font-mono">
                  Round {r.n} {r.accepted ? "" : "· rejected"}
                </span>
                <span className={`text-[11px] font-mono font-medium ${accColor(r.accuracy)}`}>
                  {r.accuracy.toFixed(1)}% · {r.docsPassed}/{r.docsTotal}
                </span>
              </div>
              <div className="text-[10px] text-ink-4 font-mono mt-0.5">
                focus: {r.focusDoc}{r.fixing.length ? ` · fixing ${r.fixing.join(", ")}` : ""}
              </div>
              {r.regressions.length > 0 && (
                <div className="text-[10px] text-vermillion-2 font-mono mt-0.5">regressed: {r.regressions.join(", ")}</div>
              )}
              {r.explanation && <div className="text-[11px] text-ink-3 mt-1">{r.explanation}</div>}
            </div>
          ))}
          {phase === "running" && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-ink-4">
              <Loader2 className="w-3 h-3 animate-spin" /> tuning across the corpus…
            </div>
          )}
        </div>
      )}

      {result && (phase === "done" || phase === "applied") && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-ink-3">Corpus:</span>
            <span className="font-mono text-ink-4">{result.baselineAccuracy.toFixed(1)}%</span>
            <span className="text-ink-4">→</span>
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

      {phase === "applied" && (
        <div className="space-y-2 border-t border-dotted border-border pt-3">
          <p className="text-[11px] text-ink-4">
            Applied to the editor. Validate a fresh candidate across the corpus, then promote to live.
          </p>
          {!validateResult ? (
            <button
              type="button"
              disabled={validating}
              onClick={validateCorpus}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors disabled:opacity-50"
            >
              {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {validating ? "Validating…" : "Validate candidate across corpus"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-ink-3">Candidate:</span>
                <span className={`font-mono font-medium ${accColor(validateResult.overallAccuracy)}`}>{validateResult.overallAccuracy.toFixed(1)}%</span>
                <span className="text-ink-4 text-[11px]">· {validateResult.docsPassed}/{validateResult.docsTotal} docs</span>
              </div>
              {validateResult.regressions.length > 0 && (
                <div className="flex items-start gap-1.5 text-[11px] text-vermillion-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>Regressions: {validateResult.regressions.map((r) => r.name).join(", ")} — promotion is blocked.</span>
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
