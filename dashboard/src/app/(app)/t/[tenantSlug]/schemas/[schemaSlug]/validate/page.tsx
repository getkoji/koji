"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ExternalLink, Database } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

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

// ── Mock data ──

const MOCK_RESULT: ValidateResult = {
  overallAccuracy: 96.2,
  prevAccuracy: 97.8,
  docsTotal: 38,
  docsPassed: 36,
  fieldCount: 9,
  durationMs: 45200,
  costUsd: 1.216,
  passed: true,
  schemaVersion: 5,
  ranAt: new Date(Date.now() - 120000).toISOString(),
  regressions: [
    {
      name: "total_premium", accuracy: 95.2, prevAccuracy: 99.4, status: "regressed",
      failingDocs: [
        { id: "doc-1", filename: "POLI-25-070125.pdf", expected: "4,250.00", got: "500.00", confidence: 0.72 },
        { id: "doc-2", filename: "invoice-0087.pdf", expected: "1,850.00", got: "1,805.00", confidence: 0.68 },
      ],
    },
  ],
  fields: [
    { name: "total_premium", accuracy: 95.2, prevAccuracy: 99.4, status: "regressed", failingDocs: [
      { id: "doc-1", filename: "POLI-25-070125.pdf", expected: "4,250.00", got: "500.00", confidence: 0.72 },
      { id: "doc-2", filename: "invoice-0087.pdf", expected: "1,850.00", got: "1,805.00", confidence: 0.68 },
    ]},
    { name: "general_aggregate", accuracy: 94.3, prevAccuracy: 96.8, status: "regressed", failingDocs: [
      { id: "doc-2", filename: "invoice-0087.pdf", expected: "2,000,000", got: "1,000,000", confidence: 0.65 },
    ]},
    { name: "policy_type", accuracy: 96.5, prevAccuracy: 97.1, status: "pass", failingDocs: [] },
    { name: "policy_number", accuracy: 97.8, prevAccuracy: 98.4, status: "pass", failingDocs: [] },
    { name: "insurer_name", accuracy: 98.0, prevAccuracy: 98.1, status: "pass", failingDocs: [] },
    { name: "each_occurrence_limit", accuracy: 98.0, prevAccuracy: 98.2, status: "pass", failingDocs: [] },
    { name: "expiration_date", accuracy: 98.2, prevAccuracy: 98.3, status: "pass", failingDocs: [] },
    { name: "effective_date", accuracy: 99.1, prevAccuracy: 99.0, status: "pass", failingDocs: [] },
    { name: "named_insured", accuracy: 99.3, prevAccuracy: 99.2, status: "pass", failingDocs: [] },
  ],
  failingDocs: [
    { id: "doc-1", filename: "POLI-25-070125.pdf", failedFields: ["total_premium"], worstConfidence: 0.72 },
    { id: "doc-2", filename: "invoice-0087.pdf", failedFields: ["total_premium", "general_aggregate"], worstConfidence: 0.65 },
  ],
};

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

  const [result, setResult] = useState<ValidateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadedFromDb, setLoadedFromDb] = useState(false);

  const { data: corpusEntries, loading: corpusLoading } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );

  // Run history from schema_runs
  const { data: perfData, loading: perfLoading } = useApi(
    useCallback(() => api.get<{ runs: Array<{ id: string; versionNumber: number | null; accuracy: string | null; docsTotal: number; docsPassed: number; regressionsCount: number; completedAt: string | null; createdAt: string }> }>(`/api/schemas/${schemaSlug}/performance`), [schemaSlug]),
  );

  const runHistory = (perfData?.runs ?? []).slice().reverse();

  // Auto-load latest run results on page load
  useEffect(() => {
    if (loadedFromDb || !perfData || perfData.runs.length === 0) return;
    const latest = perfData.runs[perfData.runs.length - 1]!;
    const prev = perfData.runs.length >= 2 ? perfData.runs[perfData.runs.length - 2] : null;
    const acc = latest.accuracy ? parseFloat(latest.accuracy) * 100 : 0;
    const prevAcc = prev?.accuracy ? parseFloat(prev.accuracy) * 100 : null;

    // Build result from the DB run — use mock field details since
    // corpus_version_results aren't populated yet
    setResult({
      ...MOCK_RESULT,
      overallAccuracy: acc,
      prevAccuracy: prevAcc,
      docsTotal: latest.docsTotal,
      docsPassed: latest.docsPassed,
      schemaVersion: latest.versionNumber ?? 0,
      ranAt: latest.completedAt ?? latest.createdAt,
      passed: acc >= 95,
    });
    setLoadedFromDb(true);
  }, [perfData, loadedFromDb]);

  const hasCorpus = (corpusEntries ?? []).length > 0;
  const hasRuns = runHistory.length > 0;

  function handleRun() {
    setRunning(true);
    // Simulate a run — replace with real API call when validate is wired
    setTimeout(() => {
      setResult(MOCK_RESULT);
      setRunning(false);
    }, 2500);
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

  // ── Empty state: no corpus ──
  if (!hasCorpus && !result) {
    return (
      <div className="h-[calc(100vh-60px)] flex items-center justify-center">
        <div className="text-center max-w-[400px]">
          <Database className="w-10 h-10 text-ink-4 mx-auto mb-4" />
          <h2 className="font-display text-[20px] font-medium text-ink mb-2" style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}>
            No corpus entries for this schema
          </h2>
          <p className="text-[13px] text-ink-3 mb-4">Add documents to the corpus before running validate.</p>
          <Link href={pathname.replace("/validate", "/corpus")}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
            Go to Corpus <ExternalLink className="w-3.5 h-3.5" />
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
                Run validate to test the current schema version against {(corpusEntries ?? []).length} corpus entries.
              </p>
            )}
          </div>

          <button onClick={handleRun} disabled={running}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50 shrink-0">
            <ShieldCheck className="w-4 h-4" />
            {running ? "Running..." : result ? "Re-run" : "Run validate"}
          </button>
        </div>

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
                    <div className="text-[13px] text-ink">
                      <span className="font-mono font-medium text-vermillion-2">{r.name}</span>
                      {" "}dropped from {r.prevAccuracy?.toFixed(1)}% to {r.accuracy.toFixed(1)}%
                      {" "}({r.failingDocs.length} doc{r.failingDocs.length !== 1 ? "s" : ""} affected)
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {r.failingDocs.map((d) => (
                        <Link key={d.id} href={pathname.replace("/validate", "/build") + `?doc=${d.id}`}
                          className="inline-flex items-center gap-1 font-mono text-[10px] text-vermillion-2 hover:text-ink transition-colors">
                          Fix {d.filename} <ExternalLink className="w-2.5 h-2.5" />
                        </Link>
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
                      <>
                        <tr key={f.name} onClick={() => f.failingDocs.length > 0 && setExpandedField(expandedField === f.name ? null : f.name)}
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
                      </>
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
