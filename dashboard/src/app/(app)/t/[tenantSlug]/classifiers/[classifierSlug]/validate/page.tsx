"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import {
  classifiers as classifiersApi,
  type ClassifierValidateResult,
} from "@/lib/api";
import { usePageTitle } from "@/lib/use-page-title";
import { ClassifierTabs } from "../ClassifierTabs";

const TIER_LABELS: Record<string, string> = {
  "0": "metadata",
  "1": "text",
  "2": "keyword",
  "3": "llm",
  "4": "vision",
};

function pct(v: number | null | undefined): string {
  return typeof v === "number" ? `${(v * 100).toFixed(0)}%` : "—";
}

export default function ClassifierValidatePage() {
  const params = useParams();
  const tenantSlug = params.tenantSlug as string;
  const slug = params.classifierSlug as string;
  const base = `/t/${tenantSlug}`;
  usePageTitle(`${slug} · validate`);

  const [displayName, setDisplayName] = useState(slug);
  const [result, setResult] = useState<ClassifierValidateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, latest] = await Promise.all([
        classifiersApi.get(slug),
        classifiersApi.validateLatest(slug),
      ]);
      setDisplayName(detail.displayName);
      setResult(latest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const started = await classifiersApi.validate(slug, { async: true });
      const runId = started.runId;
      if (!runId) {
        // Older server returned a full (sync) result.
        setResult(started as ClassifierValidateResult);
        return;
      }
      // Poll until the run finalizes.
      for (;;) {
        const st = await classifiersApi.validateRun(slug, runId);
        setProgress({ done: st.docsProcessed, total: st.docsTotal });
        if (st.status === "completed" && st.result) {
          setResult({ ...st.result, runId });
          break;
        }
        if (st.status === "failed") {
          setError(st.error ?? "Backtest failed");
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [slug]);

  // Confusion matrix axis labels: per-class order, plus any predicted-only label.
  const labels = useMemo(() => {
    if (!result) return [];
    const ls = result.byClass.map((c) => c.label);
    for (const cell of result.confusion) {
      for (const l of [cell.expected, cell.predicted]) {
        if (l && !ls.includes(l)) ls.push(l);
      }
    }
    return ls;
  }, [result]);

  const confusionCount = useMemo(() => {
    const m = new Map<string, number>();
    if (result) for (const c of result.confusion) m.set(`${c.expected}→${c.predicted}`, c.count);
    return m;
  }, [result]);

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: tenantSlug, href: base }, { label: "Classifiers", href: `${base}/classifiers` }, { label: displayName }]} />
          <PageHeader
            title={displayName}
            meta={<span>Backtest — classify every labelled corpus document and score it.</span>}
            actions={
              <button
                onClick={() => void run()}
                disabled={running}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
              >
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {running ? "Running…" : "Run backtest"}
              </button>
            }
          />
        </>
      }
    >
      <ClassifierTabs base={base} slug={slug} active="validate" />

      {error && <div className="text-[12px] px-3 py-1.5 rounded-sm mb-4 text-vermillion-2 bg-vermillion-3/50">{error}</div>}

      {running && progress && (
        <div className="text-[12px] text-ink-4 mb-4">Classifying {progress.done}/{progress.total || "…"} documents…</div>
      )}

      {!result ? (
        <p className="text-[13px] text-ink-4">
          No backtest yet. Label documents on the Corpus tab, then run a backtest to score the released classifier against them.
        </p>
      ) : (
        <>
          {/* Summary */}
          <div className="flex items-center gap-6 flex-wrap mb-6 text-[12.5px]">
            <div>
              <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">Accuracy</div>
              <div className="text-[22px] font-medium text-ink leading-tight">{pct(result.accuracy != null ? result.accuracy / 100 : null)}</div>
            </div>
            <div>
              <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">Docs</div>
              <div className="text-ink">{result.docsCorrect}/{result.docsTotal}{result.docsFailed ? <span className="text-vermillion-2"> · {result.docsFailed} failed</span> : null}</div>
            </div>
            <div>
              <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">Escalation</div>
              <div className="text-ink" title="Share of docs that needed the paid LLM/vision tail (tier ≥ 3)">{pct(result.escalationRate)}</div>
            </div>
            <div>
              <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">Cost</div>
              <div className="text-ink">{result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : "—"}</div>
            </div>
            {result.version && (
              <div>
                <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">Version</div>
                <div className="font-mono text-ink">{result.version}</div>
              </div>
            )}
            {(result.flips.fixed || result.flips.regressed || result.flips.churned) ? (
              <div>
                <div className="text-ink-4 text-[11px] uppercase tracking-[0.06em]">vs previous run</div>
                <div className="text-[12px]">
                  <span className="text-green-700">+{result.flips.fixed} fixed</span>{" "}
                  <span className="text-vermillion-2">−{result.flips.regressed} regressed</span>{" "}
                  <span className="text-ink-3">{result.flips.churned} churned</span>
                </div>
              </div>
            ) : null}
          </div>

          {/* Per-class */}
          {result.byClass.length > 0 && (
            <div className="mb-8">
              <div className="text-[12.5px] font-medium text-ink mb-2">Per class</div>
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-ink-4 text-[11px] uppercase tracking-[0.05em] bg-cream-2/40">
                      <th className="text-left font-medium px-3 py-1.5">Class</th>
                      <th className="text-right font-medium px-3 py-1.5">Support</th>
                      <th className="text-right font-medium px-3 py-1.5">Pred</th>
                      <th className="text-right font-medium px-3 py-1.5">P</th>
                      <th className="text-right font-medium px-3 py-1.5">R</th>
                      <th className="text-right font-medium px-3 py-1.5">F1</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {result.byClass.map((c) => (
                      <tr key={c.label}>
                        <td className="px-3 py-1.5 text-ink font-mono">{c.label}</td>
                        <td className="px-3 py-1.5 text-right text-ink-2">{c.support}</td>
                        <td className="px-3 py-1.5 text-right text-ink-2">{c.predicted}</td>
                        <td className="px-3 py-1.5 text-right text-ink-2">{pct(c.precision)}</td>
                        <td className="px-3 py-1.5 text-right text-ink-2">{pct(c.recall)}</td>
                        <td className="px-3 py-1.5 text-right text-ink-2">{pct(c.f1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Confusion matrix */}
          {labels.length > 0 && (
            <div className="mb-8">
              <div className="text-[12.5px] font-medium text-ink mb-2">Confusion matrix</div>
              <p className="text-[11px] text-ink-4 mb-2">Rows = expected, columns = predicted. Off-diagonal cells (red) are the mistakes — which class each document was confused with.</p>
              <div className="overflow-x-auto border border-border rounded-sm">
                <table className="text-[11px]">
                  <thead>
                    <tr className="text-ink-4">
                      <th className="px-2 py-1.5 text-left font-medium sticky left-0 bg-cream-1">exp ╲ pred</th>
                      {labels.map((l) => (
                        <th key={l} className="px-2 py-1.5 text-right font-mono font-normal">{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {labels.map((exp) => (
                      <tr key={exp} className="border-t border-border">
                        <td className="px-2 py-1.5 text-ink font-mono sticky left-0 bg-cream-1">{exp}</td>
                        {labels.map((pred) => {
                          const n = confusionCount.get(`${exp}→${pred}`) ?? 0;
                          const diag = exp === pred;
                          return (
                            <td
                              key={pred}
                              className={`px-2 py-1.5 text-right tabular-nums ${n === 0 ? "text-ink-4/50" : diag ? "text-green-700 font-medium" : "text-vermillion-2 font-medium"}`}
                            >
                              {n === 0 ? "·" : n}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tier histogram */}
          {Object.keys(result.tierHistogram).length > 0 && (
            <div>
              <div className="text-[12.5px] font-medium text-ink mb-2">Tiers reached</div>
              <div className="flex items-end gap-2">
                {Object.keys(result.tierHistogram)
                  .sort()
                  .map((tier) => {
                    const count = result.tierHistogram[tier];
                    const max = Math.max(...Object.values(result.tierHistogram));
                    const paid = Number(tier) >= 3;
                    return (
                      <div key={tier} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-ink-4">{count}</span>
                        <div
                          className={`w-9 rounded-sm ${paid ? "bg-vermillion-2/70" : "bg-ink/30"}`}
                          style={{ height: `${Math.max(6, (count / max) * 72)}px` }}
                        />
                        <span className="text-[10px] text-ink-4">{TIER_LABELS[tier] ?? `t${tier}`}</span>
                      </div>
                    );
                  })}
              </div>
              <p className="text-[10.5px] text-ink-4 mt-2">Tiers 0–2 are free; 3 (llm) and 4 (vision) are the paid tail.</p>
            </div>
          )}
        </>
      )}
    </ListLayout>
  );
}
