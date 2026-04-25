"use client";

import { useState, useCallback, useEffect, Fragment } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ExternalLink, Database, FileQuestion } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { EmptyState } from "@/components/shared/EmptyState";

// ── Types ──

interface CorpusEntry { id: string; filename: string; }

interface FieldResult {
  name: string;
  accuracy: number;
  prevAccuracy: number | null;
  status: "pass" | "regressed" | "failing";
  failingDocs: Array<{ id: string; filename: string; expected: string; got: string; confidence: number }>;
}

interface ValidateResult {
  overallAccuracy: number;
  prevAccuracy: number | null;
  docsTotal: number;
  docsPassed: number;
  fieldCount: number;
  durationMs: number;
  costUsd: number;
  passed: boolean;
  schemaVersion: number;
  ranAt: string;
  regressions: FieldResult[];
  fields: FieldResult[];
  failingDocs: Array<{ id: string; filename: string; failedFields: string[]; worstConfidence: number }>;
}

// ── Helpers ──

function timeAgo(d: string): string {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Page ──

export default function ValidatePage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = (params.tenantSlug as string | undefined) ?? pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  const [result, setResult] = useState<ValidateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadedFromDb, setLoadedFromDb] = useState(false);

  const { data: corpusEntries, loading: corpusLoading, error: corpusError } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );

  // Run history from schema_runs
  const { data: perfData, loading: perfLoading, error: perfError } = useApi(
    useCallback(() => api.get<{ runs: Array<{ id: string; versionNumber: number | null; accuracy: string | null; docsTotal: number; docsPassed: number; regressionsCount: number; completedAt: string | null; createdAt: string }> }>(`/api/schemas/${schemaSlug}/performance`), [schemaSlug]),
  );

  const runHistory = (perfData?.runs ?? []).slice().reverse();

  // Auto-load latest validate results on page load (read-only, no re-extraction)
  useEffect(() => {
    if (loadedFromDb) return;
    setLoadedFromDb(true);
    api.get<ValidateResult | null>(`/api/schemas/${schemaSlug}/validate`)
      .then((data) => { if (data) setResult(data); })
      .catch(() => {});
  }, [schemaSlug, loadedFromDb]);

  const hasCorpus = (corpusEntries ?? []).length > 0;
  const gtEntries = (corpusEntries ?? []).filter((e: any) => e.hasGroundTruth);
  const hasGroundTruth = gtEntries.length > 0;
  const hasRuns = runHistory.length > 0;

  const [runError, setRunError] = useState<string | null>(null);

  async function handleRun() {
    setResult(null);
    setRunError(null);
    setRunning(true);
    try {
      const data = await api.post<ValidateResult>(`/api/schemas/${schemaSlug}/validate`, {});
      setResult(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Validate failed";
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  }

  // ── Loading skeleton ──
  if (corpusLoading || perfLoading) {
    return (
      <div className="flex flex-col h-[calc(100vh-60px)]">
        <div className="px-8 pt-5 pb-4 border-b border-border shrink-0">
          <div className="h-3 w-32 bg-cream-2 rounded animate-pulse mb-3" />
          <div className="h-7 w-48 bg-cream-2 rounded animate-pulse mb-2" />
          <div className="h-3 w-64 bg-cream-2 rounded animate-pulse" />
          <div className="flex items-baseline gap-3 mt-4">
            <div className="h-12 w-28 bg-cream-2 rounded animate-pulse" />
            <div className="h-4 w-12 bg-cream-2 rounded animate-pulse" />
          </div>
        </div>
        <div className="flex-1 px-8 pt-6">
          <div className="h-20 bg-cream-2 rounded-sm animate-pulse mb-6 max-w-[900px]" />
          <div className="h-5 w-40 bg-cream-2 rounded animate-pulse mb-3" />
          <div className="space-y-1 max-w-[900px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 bg-cream-2 rounded-sm animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Not found / API error ──
  // If either endpoint errored, branch before the "no corpus" empty state
  // below — otherwise a 404 on the schema itself would misleadingly show
  // "No corpus entries" instead of "Schema not found".
  const fatalError = corpusError ?? perfError;
  if (fatalError) {
    const notFound = fatalError.message.toLowerCase().includes("not found");
    return (
      <div className="flex flex-col h-[calc(100vh-60px)]">
        <div className="px-8 pt-5 pb-4 border-b border-border shrink-0">
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-2">
            <span className="text-ink-3">{schemaSlug}</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium">Validate</span>
          </nav>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<FileQuestion className="w-10 h-10" />}
            title={notFound ? "Schema not found" : "Cannot reach API"}
            description={
              notFound
                ? `No schema with slug "${schemaSlug}" exists in this workspace.`
                : fatalError.message
            }
            action={
              <Link
                href={`/t/${tenantSlug}`}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
              >
                Back to schemas
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  // ── Empty state: no corpus or no ground truth ──
  if ((!hasCorpus || !hasGroundTruth) && !result) {
    const noCorpusAtAll = !hasCorpus;
    return (
      <div className="h-[calc(100vh-60px)] flex items-center justify-center">
        <div className="text-center max-w-[400px]">
          <Database className="w-10 h-10 text-ink-4 mx-auto mb-4" />
          <h2 className="font-display text-[20px] font-medium text-ink mb-2" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
            {noCorpusAtAll ? "No corpus entries for this schema" : "No ground truth saved yet"}
          </h2>
          <p className="text-[13px] text-ink-3 mb-4">
            {noCorpusAtAll
              ? "Add documents to the corpus before running validate."
              : `You have ${(corpusEntries ?? []).length} documents in the corpus, but none have ground truth. Go to Build mode, run an extraction, review the results, and click "Save as ground truth".`
            }
          </p>
          <Link href={pathname.replace("/validate", noCorpusAtAll ? "/corpus" : "/build")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
            {noCorpusAtAll ? "Go to Corpus" : "Go to Build mode"} <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    );
  }

  // ── Ready state or results ──
  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* Fixed header */}
      <div className="px-8 pt-5 pb-4 border-b border-border shrink-0">
        <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-2">
          <span className="text-ink-3">{schemaSlug}</span>
          <span className="text-cream-4">/</span>
          <span className="text-ink font-medium">Validate</span>
        </nav>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-[28px] font-medium leading-none tracking-tight text-ink"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>Validate</h1>
              {result && (
                <span className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${result.passed ? "bg-green/15 text-green" : "bg-vermillion-3 text-vermillion-2"}`}>
                  {result.passed ? "pass" : "fail"}
                </span>
              )}
            </div>
            {result ? (
              <div className="flex items-center gap-3 mt-1.5 font-mono text-[10px] text-ink-4">
                <span>v{result.schemaVersion}</span>
                <span>·</span>
                <span>{result.docsTotal} docs</span>
                <span>·</span>
                <span>{result.fieldCount} fields</span>
                <span>·</span>
                <span>{(result.durationMs / 1000).toFixed(1)}s</span>
                <span>·</span>
                <span>${result.costUsd.toFixed(3)}</span>
                <span>·</span>
                <span>{timeAgo(result.ranAt)}</span>
              </div>
            ) : (
              <p className="text-[13px] text-ink-3 mt-1.5">
                Run validate to test the current schema version against {(corpusEntries ?? []).filter((e: any) => e.hasGroundTruth).length} corpus entries with ground truth.
              </p>
            )}
          </div>

          <button onClick={handleRun} disabled={running}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50 shrink-0">
            <ShieldCheck className="w-4 h-4" />
            {running ? "Running..." : result ? "Re-run" : "Run validate"}
          </button>
        </div>

        {/* Run error */}
        {runError && (
          <div className="mt-4 border border-vermillion/25 rounded-sm p-4 bg-vermillion-3/30">
            <p className="text-[13px] text-ink">{runError}</p>
            {runError.includes("ground truth") && (
              <p className="text-[12px] text-ink-3 mt-1">
                Go to <Link href={pathname.replace("/validate", "/build")} className="text-vermillion-2 hover:underline">Build mode</Link>, run an extraction, review the results, and click "Save as ground truth".
              </p>
            )}
          </div>
        )}

        {/* Accuracy headline */}
        {result && (
          <div className="flex items-baseline gap-3 mt-4">
            <span className="font-display text-[48px] font-medium text-ink leading-none tracking-tight"
              style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}>
              {result.overallAccuracy.toFixed(1)}%
            </span>
            {result.prevAccuracy !== null && (
              <span className={`font-mono text-[14px] font-medium ${result.overallAccuracy >= result.prevAccuracy ? "text-green" : "text-vermillion-2"}`}>
                {result.overallAccuracy >= result.prevAccuracy ? "▲" : "▼"} {Math.abs(result.overallAccuracy - result.prevAccuracy).toFixed(1)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {running && (
          <div className="px-8 py-12 text-center">
            <div className="animate-pulse font-mono text-[12px] text-ink-4 mb-2">Running validate...</div>
            <div className="font-mono text-[11px] text-ink-4">Processing {(corpusEntries ?? []).length} documents</div>
          </div>
        )}

        {!running && !result && (
          <div className="px-8 py-12 text-center text-[13px] text-ink-3">
            Click "Run validate" to test the current schema version against the corpus.
          </div>
        )}

        {!running && result && (
          <div className="px-8 pt-6 pb-12 max-w-[900px]">

            {/* Regression callout */}
            {result.regressions.length > 0 && (
              <div className="mb-6 border-l-[3px] border-vermillion-2 bg-vermillion-2/[0.04] rounded-r-sm px-5 py-4">
                <div className="font-mono text-[10px] font-medium text-vermillion-2 uppercase tracking-[0.1em] mb-2">
                  Regression · {result.regressions.length} field{result.regressions.length !== 1 ? "s" : ""}
                </div>
                {result.regressions.map((r) => (
                  <div key={r.name} className="mb-2 last:mb-0">
                    <div className="text-[13px] text-ink mb-1">
                      <span className="font-mono font-medium text-vermillion-2">{r.name}</span>
                      {" — "}{r.failingDocs.length} doc{r.failingDocs.length !== 1 ? "s" : ""} affected
                    </div>
                    <div className="space-y-1.5 mt-2">
                      {r.failingDocs.map((d) => (
                        <div key={d.id} className="flex items-start justify-between gap-3">
                          <div className="font-mono text-[11px]">
                            <span className="text-ink-4">{d.filename}</span>
                            <div className="mt-0.5">
                              <span className="text-ink-4">expected </span>
                              <span className="text-green">{d.expected}</span>
                              <span className="text-ink-4"> got </span>
                              <span className="text-vermillion-2">{d.got}</span>
                            </div>
                          </div>
                          <Link href={pathname.replace("/validate", "/build") + `?doc=${d.id}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors shrink-0">
                            Fix <ExternalLink className="w-2.5 h-2.5" />
                          </Link>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Per-field results table */}
            <div className="mb-6">
              <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-3"
                style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>Per-field results</h2>
              <div className="border border-border rounded-sm overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-2/50">
                      <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4 w-8"></th>
                      <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">Field</th>
                      <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">Accuracy</th>
                      <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4">Delta</th>
                      <th className="text-left px-4 py-2 font-mono text-[9px] font-medium tracking-[0.1em] uppercase text-ink-4 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.fields.map((f) => (
                      <Fragment key={f.name}>
                        <tr onClick={() => f.failingDocs.length > 0 && setExpandedField(expandedField === f.name ? null : f.name)}
                          className={`border-t border-border transition-colors ${f.failingDocs.length > 0 ? "cursor-pointer hover:bg-cream-2/50" : ""} ${f.status === "regressed" ? "bg-vermillion-2/[0.02]" : ""}`}>
                          <td className="px-4 py-2.5">
                            {f.status === "regressed" ? <AlertTriangle className="w-3.5 h-3.5 text-vermillion-2" /> :
                             f.status === "failing" ? <XCircle className="w-3.5 h-3.5 text-vermillion-2" /> :
                             <CheckCircle2 className="w-3.5 h-3.5 text-green" />}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-ink">{f.name}</td>
                          <td className="px-4 py-2.5">
                            <span className={`font-mono text-[11px] font-medium ${f.accuracy >= 98 ? "text-green" : f.accuracy >= 95 ? "text-ink" : "text-vermillion-2"}`}>
                              {f.accuracy.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            {f.prevAccuracy !== null && (
                              <span className={`font-mono text-[10px] ${f.accuracy >= f.prevAccuracy ? "text-green" : "text-vermillion-2"}`}>
                                {f.accuracy >= f.prevAccuracy ? "+" : ""}{(f.accuracy - f.prevAccuracy).toFixed(1)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {f.failingDocs.length > 0 && (
                              <ChevronDown className={`w-3.5 h-3.5 text-ink-4 transition-transform ${expandedField === f.name ? "rotate-180" : ""}`} />
                            )}
                          </td>
                        </tr>
                        {expandedField === f.name && f.failingDocs.length > 0 && (
                          <tr key={`${f.name}-detail`}>
                            <td colSpan={5} className="bg-cream-2/30 px-4 py-3">
                              <div className="space-y-2">
                                {f.failingDocs.map((d) => (
                                  <div key={d.id} className="flex items-center justify-between gap-4 px-3 py-2 border border-border rounded-sm bg-cream">
                                    <div>
                                      <div className="font-mono text-[11px] text-ink">{d.filename}</div>
                                      <div className="font-mono text-[10px] text-ink-4 mt-0.5">
                                        Expected: <span className="text-ink">{d.expected}</span>
                                        {" · "}Got: <span className="text-vermillion-2">{d.got}</span>
                                        {" · "}Conf: {(d.confidence * 100).toFixed(0)}%
                                      </div>
                                    </div>
                                    <Link href={pathname.replace("/validate", "/build") + `?doc=${d.id}`}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors shrink-0">
                                      Fix in Build <ExternalLink className="w-2.5 h-2.5" />
                                    </Link>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Failing documents */}
            {result.failingDocs.length > 0 && (
              <div>
                <h2 className="font-display text-[18px] font-medium tracking-tight text-ink mb-3"
                  style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
                  Failing documents ({result.failingDocs.length} of {result.docsTotal})
                </h2>
                <div className="border border-border rounded-sm divide-y divide-border">
                  {result.failingDocs.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
                      <div>
                        <div className="font-mono text-[11px] text-ink">{d.filename}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {d.failedFields.map((f) => (
                            <span key={f} className="font-mono text-[9px] text-vermillion-2 bg-vermillion-3 px-1.5 py-0.5 rounded-sm">{f}</span>
                          ))}
                          <span className="font-mono text-[9px] text-ink-4">worst: {(d.worstConfidence * 100).toFixed(0)}%</span>
                        </div>
                      </div>
                      <Link href={pathname.replace("/validate", "/build") + `?doc=${d.id}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors shrink-0">
                        Fix in Build <ExternalLink className="w-2.5 h-2.5" />
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Run history */}
            {runHistory.length > 0 && (
              <div className="mt-8">
                <button onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-2 font-display text-[18px] font-medium tracking-tight text-ink mb-3 hover:text-vermillion-2 transition-colors"
                  style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
                  Run history ({runHistory.length})
                  <ChevronDown className={`w-4 h-4 text-ink-4 transition-transform ${showHistory ? "rotate-180" : ""}`} />
                </button>
                {showHistory && (
                  <div className="border border-border rounded-sm divide-y divide-border">
                    {runHistory.map((r) => {
                      const acc = r.accuracy ? (parseFloat(r.accuracy) * 100).toFixed(1) : "—";
                      const isSelected = selectedRunId === r.id;
                      return (
                        <div key={r.id}
                          className={`flex items-center justify-between gap-4 px-4 py-3 transition-colors ${isSelected ? "bg-cream-2" : "hover:bg-cream-2/50"}`}>
                          <div className="flex items-center gap-4">
                            <span className="font-mono text-[11px] text-ink font-medium">
                              {r.versionNumber !== null ? `v${r.versionNumber}` : "—"}
                            </span>
                            <span className={`font-mono text-[11px] font-medium ${parseFloat(acc) >= 97 ? "text-green" : parseFloat(acc) >= 95 ? "text-ink" : "text-vermillion-2"}`}>
                              {acc}%
                            </span>
                            <span className="font-mono text-[10px] text-ink-4">
                              {r.docsPassed}/{r.docsTotal} docs passed
                            </span>
                            {r.regressionsCount > 0 && (
                              <span className="font-mono text-[9px] text-vermillion-2 bg-vermillion-3 px-1.5 py-0.5 rounded-sm">
                                {r.regressionsCount} regression{r.regressionsCount !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[10px] text-ink-4">
                            {r.completedAt ? timeAgo(r.completedAt) : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
