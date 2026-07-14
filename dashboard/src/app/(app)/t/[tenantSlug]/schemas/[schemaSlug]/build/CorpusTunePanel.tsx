"use client";

/**
 * Auto-tune (durable) — drives a persisted, background corpus-tuning run.
 *
 * Starts a run (`POST .../tune/runs`) and polls it (`GET .../tune/runs/:id`).
 * The loop runs as background jobs — one round per job — so it survives the
 * 5-minute function cap, disconnects, and tab closes: come back and it's still
 * going (or done). Each round shows the model's reasoning, what it fixed, and
 * whether it was kept; on completion you apply the improved schema, then
 * validate + promote (server-gated on no regressions).
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Check, Loader2, Sparkles, AlertTriangle, ArrowUpCircle } from "lucide-react";
import { api } from "@/lib/api";

interface Props {
  schemaSlug: string;
  yaml: string;
  model?: string;
  onApply: (yaml: string) => void;
}

interface Round {
  n: number;
  accuracy: number | null;
  docsPassed: number | null;
  docsTotal: number | null;
  accepted: boolean;
  focusDoc: string | null;
  fixing: string[] | null;
  regressions: string[] | null;
  explanation: string | null;
  thinking: string | null;
}
interface RunState {
  id: string;
  status: "queued" | "running" | "passed" | "stopped" | "failed";
  stopReason: string | null;
  baselineAccuracy: number | null;
  bestAccuracy: number | null;
  currentRound: number;
  maxIterations: number;
  phase: "baseline" | "proposal" | "proposing" | null;
  docsScored: number;
  docsTotal: number;
  bestYaml: string;
  error: string | null;
  rounds: Round[];
}
interface ValidateResult {
  overallAccuracy: number;
  docsPassed: number;
  docsTotal: number;
  passed: boolean;
  regressions: Array<{ name: string }>;
}

const STOP_LABEL: Record<string, string> = {
  passed: "Passed — every labeled field extracts across the corpus",
  no_improvement: "Stopped — recent rounds stopped improving",
  max_iterations: "Reached the round limit",
  propose_failed: "Stopped — the model had no further fix to propose",
  error: "Failed",
};

function accColor(a: number | null): string {
  if (a == null) return "text-ink-4";
  return a >= 95 ? "text-green" : a >= 70 ? "text-yellow-600" : "text-vermillion-2";
}

const isDone = (s: string) => s === "passed" || s === "stopped" || s === "failed";

/** What the run is doing right now — scoring fans out per doc, so show N/M progress. */
function progressLabel(run: {
  status: string;
  phase: "baseline" | "proposal" | "proposing" | null;
  currentRound: number;
  docsScored: number;
  docsTotal: number;
}): string {
  const of = run.docsTotal > 0 ? ` — ${run.docsScored}/${run.docsTotal} documents` : "";
  if (run.status === "queued" || !run.phase) return "Starting…";
  if (run.phase === "baseline") return `Scoring the baseline across the corpus${of}`;
  if (run.phase === "proposing") return `Round ${run.currentRound + 1}: asking the model for a fix…`;
  return `Round ${run.currentRound}: re-checking the change across the corpus${of}`;
}

export function CorpusTunePanel({ schemaSlug, yaml, model, onApply }: Props) {
  const [run, setRun] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResult | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPolling = () => { if (pollRef.current) clearTimeout(pollRef.current); pollRef.current = null; };

  const poll = useCallback(async (runId: string) => {
    try {
      const r = await api.get<RunState>(`/api/schemas/${schemaSlug}/tune/runs/${runId}`);
      setRun(r);
      if (!isDone(r.status)) pollRef.current = setTimeout(() => poll(runId), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lost the run");
    }
  }, [schemaSlug]);

  // Resume: attach to an in-flight run on mount (survives navigation/reload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { latest } = await api.get<{ latest: { id: string; status: string } | null }>(`/api/schemas/${schemaSlug}/tune/runs`);
        if (!cancelled && latest && !isDone(latest.status)) poll(latest.id);
      } catch { /* none */ }
    })();
    return () => { cancelled = true; stopPolling(); };
  }, [schemaSlug, poll]);

  const start = async () => {
    setStarting(true);
    setError(null);
    setRun(null);
    setApplied(false);
    setValidateResult(null);
    setPromoted(null);
    setGateError(null);
    stopPolling();
    try {
      const { runId } = await api.post<{ runId: string }>(`/api/schemas/${schemaSlug}/tune/runs`, {
        yaml,
        ...(model ? { model } : {}),
        max_iterations: 5,
      });
      poll(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start tuning");
    } finally {
      setStarting(false);
    }
  };

  const apply = () => {
    if (run) { onApply(run.bestYaml); setApplied(true); }
  };

  const validateCorpus = async () => {
    if (!run) return;
    setValidating(true);
    setGateError(null);
    try {
      setValidateResult(await api.post<ValidateResult>(`/api/schemas/${schemaSlug}/validate`, { yaml: run.bestYaml }));
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

  const running = run != null && !isDone(run.status);
  const done = run != null && isDone(run.status);

  return (
    <div className="p-3 space-y-3 overflow-y-auto">
      <div className="text-[11px] font-medium text-ink-3">Auto-tune across the corpus</div>
      <p className="text-[11px] text-ink-4">
        Runs as a durable background job — one round at a time, improving the schema against every labeled
        document. It keeps going if you close the tab; come back to check on it.
      </p>

      {(run == null || done) && (
        <button
          type="button"
          disabled={starting}
          onClick={start}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
        >
          {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {run == null ? "Auto-tune this schema" : "Run again"}
        </button>
      )}

      {error && <p className="text-[11px] text-vermillion-2">{error}</p>}

      {run && (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-ink-3">Corpus:</span>
          <span className="font-mono text-ink-4">{run.baselineAccuracy?.toFixed(1) ?? "…"}%</span>
          <span className="text-ink-4">→</span>
          <span className={`font-mono font-medium ${accColor(run.bestAccuracy)}`}>{run.bestAccuracy?.toFixed(1) ?? "…"}%</span>
          {done && <span className="text-ink-4 text-[11px]">· {STOP_LABEL[run.stopReason ?? ""] ?? run.status}</span>}
        </div>
      )}

      {run && run.rounds.length > 0 && (
        <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
          {run.rounds.map((r) => (
            <div key={r.n} className="px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-ink-4 font-mono">Round {r.n}{r.accepted ? "" : " · rejected"}</span>
                <span className={`text-[11px] font-mono font-medium ${accColor(r.accuracy)}`}>{r.accuracy?.toFixed(1) ?? "…"}%</span>
              </div>
              {r.focusDoc && (
                <div className="text-[10px] text-ink-4 font-mono mt-0.5">
                  focus: {r.focusDoc}{r.fixing?.length ? ` · fixing ${r.fixing.join(", ")}` : ""}
                </div>
              )}
              {r.regressions && r.regressions.length > 0 && (
                <div className="text-[10px] text-vermillion-2 font-mono mt-0.5">regressed: {r.regressions.join(", ")}</div>
              )}
              {r.thinking && (
                <div className="text-[11px] text-ink-3 leading-relaxed whitespace-pre-wrap border-l-2 border-vermillion-2/30 pl-2 mt-1">
                  {r.thinking.replace(/<\/?thinking>/gi, "").trim()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {running && (
        <div className="flex items-center gap-1.5 text-[11px] text-ink-4">
          <Loader2 className="w-3 h-3 animate-spin" />
          {progressLabel(run!)}
        </div>
      )}

      {done && run!.status !== "failed" && !applied && (
        <button
          type="button"
          onClick={apply}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-sm text-[12px] font-medium bg-cream-2 text-ink border border-border hover:border-ink transition-colors"
        >
          <Check className="w-3.5 h-3.5" /> Apply improved schema
        </button>
      )}
      {run?.status === "failed" && <p className="text-[11px] text-vermillion-2">{run.error ?? "Tuning failed."}</p>}

      {applied && (
        <div className="space-y-2 border-t border-dotted border-border pt-3">
          <p className="text-[11px] text-ink-4">Applied to the editor. Validate a candidate across the corpus, then promote.</p>
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
