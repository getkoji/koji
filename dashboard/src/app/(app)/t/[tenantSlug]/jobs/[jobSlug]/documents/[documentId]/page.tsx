"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";
import { useParams } from "next/navigation";
import { Crosshair, X, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@koji/ui";
import { DocumentViewer, pickDocumentRenderer } from "@/components/shared/DocumentViewer";
import type { RegionSelection } from "@/components/shared/PdfViewer";
import { useAuth } from "@/lib/auth-context";
import { parseOverride } from "@/lib/parse-override";
import type { TraceStage, TraceField } from "@/lib/types";
import { Timeline } from "@/components/surfaces/trace/Timeline";
import { StageDetail } from "@/components/surfaces/trace/StageDetail";
import { TraceResults } from "@/components/surfaces/trace/TraceResults";
import { StageTimeline } from "@/components/surfaces/trace/StageTimeline";
import { DetailLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { jobs as jobsApi, type DocumentDetail, type TraceStageRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { prettyStageName } from "./format";
import type { ResolutionRung } from "@/lib/provenance-resolution";

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="uppercase tracking-[0.08em] text-[9.5px]">{label}</span>
      <span className="text-ink">{value}</span>
    </>
  );
}

function MetaDot() {
  return <span className="text-cream-4 text-[8px]">●</span>;
}

const GhostButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function GhostButton({ children, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed${className ? ` ${className}` : ""}`}
      {...props}
    >
      {children}
    </button>
  );
});

export default function TraceViewPage() {
  const params = useParams<{ tenantSlug: string; jobSlug: string; documentId: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  const jobSlug = params?.jobSlug ?? "";
  const documentId = params?.documentId ?? "";

  const { data, loading, error, refetch } = useApi(
    useCallback(() => jobsApi.document(jobSlug, documentId), [jobSlug, documentId]),
  );

  const isProcessing = data
    ? !["delivered", "review", "failed"].includes(data.status)
    : false;

  // ── SSE subscription for in-progress documents ──
  // Replaces setInterval polling: subscribes to real-time stage updates,
  // refetches on status changes, and auto-closes on terminal state.
  const [sseStages, setSseStages] = useState<TraceStageRow[]>([]);
  useEffect(() => {
    if (!isProcessing || !data) return;
    const es = new EventSource(`/api/jobs/${jobSlug}/documents/${documentId}/stream`);

    es.addEventListener("stage", (e) => {
      try {
        const stage = JSON.parse(e.data) as TraceStageRow;
        setSseStages((prev) => {
          const exists = prev.some((s) => s.id === stage.id);
          if (exists) return prev.map((s) => (s.id === stage.id ? stage : s));
          return [...prev, stage];
        });
      } catch { /* ignore malformed events */ }
    });

    es.addEventListener("status", () => {
      refetch();
    });

    es.addEventListener("done", () => {
      es.close();
      refetch();
    });

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors. If the connection
      // is fully dead the browser will stop retrying — fall back to a single
      // refetch so the page isn't stuck.
      es.close();
      refetch();
    };

    return () => es.close();
  }, [isProcessing, jobSlug, documentId, data, refetch]);

  // Merge SSE stages with the initial data stages. SSE stages take precedence
  // (they're newer) and are appended if not already present.
  const mergedStageRows = useMemo(() => {
    const base = data?.stages ?? [];
    if (sseStages.length === 0) return base;
    const map = new Map(base.map((s) => [s.id, s]));
    for (const s of sseStages) map.set(s.id, s);
    return Array.from(map.values()).sort((a, b) => a.stageOrder - b.stageOrder);
  }, [data?.stages, sseStages]);

  const stages = useMemo<TraceStage[]>(
    () => (data ? mapStages(mergedStageRows, data.trace?.totalDurationMs ?? null) : []),
    [data, mergedStageRows],
  );

  // Memoize the preview URL so the PDF viewer doesn't re-mount on every poll.
  const previewUrl = useRef<string | null>(null);
  if (data?.documentPreviewUrl && !previewUrl.current) {
    previewUrl.current = data.documentPreviewUrl;
  }
  // "Open doc" serves the ORIGINAL source document, not the searchable
  // derivative the inline viewer uses. `?original=1` makes the preview
  // endpoint bypass the `.searchable.pdf` (which has an added OCR text
  // layer, and for signed PDFs a stripped signature) and return the
  // authoritative source bytes.
  const openDocUrl = data?.documentPreviewUrl
    ? `${data.documentPreviewUrl}${data.documentPreviewUrl.includes("?") ? "&" : "?"}original=1`
    : null;
  const fields = useMemo<TraceField[]>(() => (data ? mapFields(data) : []), [data]);

  // ── Side-by-side state ──
  const [activeField, setActiveField] = useState<string | null>(null);

  // ── Correct-field state (manual corrections, oss-381) ──
  // One field at a time: pencil on a scalar row opens the correction bar;
  // "point on document" arms the PDF selection layer and resolves the drag
  // to the text underneath (same machinery as the review queue).
  const { hasPermission } = useAuth();
  const [correcting, setCorrecting] = useState<{
    field: string;
    original: unknown;
    value: string;
    pointing: boolean;
    anchored: {
      page: number;
      bbox: { x: number; y: number; w: number; h: number };
      words: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
      text: string;
    } | null;
    saving: boolean;
    error: string | null;
  } | null>(null);

  // Corrections are for settled documents; mid-flight extractions would race
  // the pipeline's own writes.
  const canCorrect =
    hasPermission("review:act") &&
    data != null &&
    ["delivered", "review", "failed"].includes(data.status);
  const canPoint =
    canCorrect &&
    pickDocumentRenderer(data!.mimeType, data!.documentPreviewUrl, data!.filename) === "pdf";

  const startCorrection = useCallback((field: string, currentValue: unknown) => {
    setCorrecting({
      field,
      original: currentValue,
      value:
        currentValue == null
          ? ""
          : typeof currentValue === "string"
            ? currentValue
            : typeof currentValue === "number" || typeof currentValue === "boolean"
              ? String(currentValue)
              : JSON.stringify(currentValue),
      pointing: false,
      anchored: null,
      saving: false,
      error: null,
    });
  }, []);

  const handleRegionSelected = useCallback(
    async (region: RegionSelection) => {
      const r = await jobsApi.resolveRegion(jobSlug, documentId, region).catch(() => null);
      setCorrecting((c) => {
        if (!c) return c;
        if (r?.text != null) {
          return {
            ...c,
            value: r.text,
            anchored: { page: region.page, bbox: r.bbox ?? region.bbox, words: r.words, text: r.text },
            pointing: false,
            error: null,
          };
        }
        return { ...c, error: "No text under that selection — drag over the value, or type it." };
      });
    },
    [jobSlug, documentId],
  );

  const submitCorrection = useCallback(async () => {
    if (!correcting || correcting.saving) return;
    setCorrecting((c) => (c ? { ...c, saving: true, error: null } : c));
    try {
      await jobsApi.correctDocument(jobSlug, documentId, {
        corrections: [
          {
            field: correcting.field,
            value: parseOverride(correcting.value, correcting.original),
            ...(correcting.anchored
              ? {
                  provenance: {
                    page: correcting.anchored.page,
                    bbox: correcting.anchored.bbox,
                    words: correcting.anchored.words,
                    chunk: correcting.anchored.text,
                  },
                }
              : {}),
          },
        ],
      });
      await refetch();
      setCorrecting(null);
    } catch (err) {
      setCorrecting((c) =>
        c ? { ...c, saving: false, error: err instanceof Error ? err.message : "Correction failed" } : c,
      );
    }
  }, [correcting, jobSlug, documentId, refetch]);

  // Parsed-text view — fetched lazily the first time the user toggles to it
  // (the parsed markdown isn't part of the document-detail payload).
  const [parsedMarkdown, setParsedMarkdown] = useState<string | null>(null);
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const requestParsed = useCallback(() => {
    if (parsedMarkdown !== null || markdownLoading) return;
    setMarkdownLoading(true);
    jobsApi
      .documentMarkdown(jobSlug, documentId)
      .then((res) => setParsedMarkdown(res.markdown ?? ""))
      .catch(() => setParsedMarkdown(""))
      .finally(() => setMarkdownLoading(false));
  }, [parsedMarkdown, markdownLoading, jobSlug, documentId]);

  // Stash the last known extraction results so a rerun doesn't flash to the
  // empty/fallback layout while the document is reprocessing. The stash is
  // cleared once fresh results arrive.
  const lastExtraction = useRef<{
    extractionJson: Record<string, unknown>;
    confidenceScoresJson: Record<string, number> | null;
    provenanceJson: DocumentDetail["provenanceJson"];
  } | null>(null);

  const liveExtraction = data?.extractionJson != null
    && typeof data.extractionJson === "object"
    && Object.keys(data.extractionJson as Record<string, unknown>).length > 0;

  if (liveExtraction) {
    lastExtraction.current = {
      extractionJson: data.extractionJson as Record<string, unknown>,
      confidenceScoresJson: data.confidenceScoresJson ?? null,
      provenanceJson: data.provenanceJson ?? null,
    };
  }

  // Use live data if available, otherwise fall back to stashed results
  const displayExtraction = liveExtraction
    ? {
        extractionJson: data.extractionJson as Record<string, unknown>,
        confidenceScoresJson: data.confidenceScoresJson,
        provenanceJson: data.provenanceJson,
      }
    : lastExtraction.current;

  const hasExtraction = displayExtraction != null;

  // Convert provenanceJson → BBoxHighlight[]. Array items get indexed keys
  // (field[0]) and their properties get dotted keys (field[0].limit) so
  // clicking a specific property highlights that value on the PDF.
  const highlights = useMemo(() => {
    const prov = displayExtraction?.provenanceJson as Record<string, any> | null;
    if (!prov) return [];
    const out: Array<{ field: string; page: number; bbox?: any; words?: any; reasoning?: string; resolution?: ResolutionRung }> = [];
    for (const [field, v] of Object.entries(prov)) {
      if (!v) continue;
      if (v.items && Array.isArray(v.items)) {
        for (let i = 0; i < v.items.length; i++) {
          const item = v.items[i];
          if (!item) continue;
          if (item.words?.length || (item.bbox && item.page) || item.page) {
            out.push({ field: `${field}[${i}]`, page: item.words?.[0]?.page ?? item.page ?? 1, bbox: item.bbox, words: item.words, reasoning: item.reasoning, resolution: item.resolution });
          }
          // Per-property highlights within the item
          if (item.properties && typeof item.properties === "object") {
            for (const [prop, pSpan] of Object.entries(item.properties as Record<string, any>)) {
              if (!pSpan) continue;
              if (pSpan.words?.length || (pSpan.bbox && pSpan.page) || pSpan.page) {
                out.push({ field: `${field}[${i}].${prop}`, page: pSpan.words?.[0]?.page ?? pSpan.page ?? 1, bbox: pSpan.bbox, words: pSpan.words, resolution: pSpan.resolution });
              }
            }
          }
        }
        continue;
      }
      if (v.words?.length || (v.bbox && v.page)) {
        out.push({ field, page: v.words?.[0]?.page ?? v.page ?? 1, bbox: v.bbox, words: v.words, reasoning: v.reasoning, resolution: v.resolution });
      }
    }
    return out;
  }, [displayExtraction?.provenanceJson]);

  const [selectedStage, setSelectedStage] = useState(0);
  const [copiedTrace, setCopiedTrace] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [failing, setFailing] = useState(false);

  const handleRerun = useCallback(
    async (reparse: boolean) => {
      if (!data) return;
      setRerunning(true);
      try {
        await jobsApi.rerunDocument(jobSlug, documentId, { reparse });
        await refetch();
      } catch {
        // Swallow — the refetch below will surface the real state.
      } finally {
        setRerunning(false);
      }
    },
    [data, jobSlug, documentId, refetch],
  );

  const handleForceFail = useCallback(async () => {
    if (!data) return;
    setFailing(true);
    try {
      await jobsApi.failDocument(jobSlug, documentId, "Manually failed by operator");
      await refetch();
    } catch {
      // Swallow
    } finally {
      setFailing(false);
    }
  }, [data, jobSlug, documentId, refetch]);

  const handleCopyTrace = useCallback(() => {
    const id = data?.trace?.traceExternalId;
    if (!id) return;
    navigator.clipboard?.writeText(id);
    setCopiedTrace(true);
    setTimeout(() => setCopiedTrace(false), 1500);
  }, [data?.trace?.traceExternalId]);

  const handleDownloadJson = useCallback(() => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const baseName = data.filename.replace(/\.[^.]+$/, "") || data.documentId;
    a.download = `${baseName}-trace.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [data]);
  const clampedStage = Math.min(selectedStage, Math.max(0, stages.length - 1));

  if (loading && !data) {
    return (
      <DetailLayout
        header={
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
              { label: jobSlug, href: `/t/${tenantSlug}/jobs/${jobSlug}` },
              { label: documentId },
            ]}
          />
        }
        sidebar={
          <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">
            Loading trace…
          </div>
        }
        sidebarWidth="0.42fr"
      >
        <div />
      </DetailLayout>
    );
  }

  if (error || !data) {
    return (
      <DetailLayout
        header={
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: `/t/${tenantSlug}` },
              { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
              { label: jobSlug, href: `/t/${tenantSlug}/jobs/${jobSlug}` },
              { label: documentId },
            ]}
          />
        }
        sidebar={<div />}
        sidebarWidth="0.42fr"
      >
        <EmptyState
          title={error?.message.includes("not found") ? "Document not found" : "Cannot reach API"}
          description={error?.message ?? "No data"}
        />
      </DetailLayout>
    );
  }

  const badge = statusBadge(data.status);
  const schemaLabel = data.schemaName && data.schemaVersion !== null
    ? `${data.schemaName} ${data.schemaVersionLabel ?? `v${data.schemaVersion}`}`
    : data.schemaName ?? "—";
  const startedLabel = formatTimestamp(data.trace?.startedAt ?? data.startedAt ?? data.createdAt);
  const traceIdLabel = data.trace?.traceExternalId ?? "—";
  // Parser engine that produced this document's markdown — read from the parse
  // stage's recorded summary (`parse.summary_json.engine`). Surfacing only.
  const parseStageRow = mergedStageRows.find((s) => s.stageName === "parse");
  const parserLabel =
    parseStageRow?.summaryJson && typeof parseStageRow.summaryJson === "object"
      ? ((parseStageRow.summaryJson as Record<string, unknown>).engine as string | undefined) ?? null
      : null;

  const header = (
    <>
      <Breadcrumbs
        items={[
          { label: tenantSlug, href: `/t/${tenantSlug}` },
          { label: "Jobs", href: `/t/${tenantSlug}/jobs` },
          { label: jobSlug, href: `/t/${tenantSlug}/jobs/${jobSlug}` },
          { label: data.filename },
        ]}
      />
      <PageHeader
        title={data.filename}
        badge={
          <span
            className={`font-mono text-[10px] font-medium px-2.5 py-1 rounded-sm tracking-[0.08em] uppercase ${badge.className}`}
          >
            {badge.label}
          </span>
        }
        meta={
          <>
            <MetaItem label="Trace" value={traceIdLabel} />
            <MetaDot />
            <MetaItem label="Started" value={startedLabel} />
            <MetaDot />
            <MetaItem label="Schema" value={schemaLabel} />
            {parserLabel && (
              <>
                <MetaDot />
                <MetaItem label="Parser" value={parserLabel} />
              </>
            )}
          </>
        }
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <GhostButton
                  disabled={rerunning || data.status === "extracting"}
                  title={
                    data.status === "extracting"
                      ? "Document is currently processing"
                      : "Re-queue this document"
                  }
                >
                  {rerunning ? (
                    <span className="inline-block w-3.5 h-3.5 border-2 border-ink/30 border-t-ink rounded-full animate-spin" />
                  ) : (
                    <>
                      Rerun
                      <ChevronDown className="w-3.5 h-3.5 opacity-50" />
                    </>
                  )}
                </GhostButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[280px]">
                <DropdownMenuLabel className="font-mono text-[10px] tracking-[0.1em] uppercase text-ink-4">
                  Rerun this document
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => handleRerun(false)}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-medium">Re-extract only</span>
                  <span className="text-[11px] text-ink-4">
                    Reuse the cached parse — faster, no re-parse cost.
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleRerun(true)}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-medium">Reparse &amp; extract</span>
                  <span className="text-[11px] text-ink-4">
                    Parse the document again from source, then extract. Use when
                    the parsed text itself looks wrong.
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {(data.status === "extracting" || data.status === "parsing") && (
              <GhostButton
                onClick={handleForceFail}
                disabled={failing}
                title="Force-fail this stuck document"
              >
                {failing ? (
                  <span className="inline-block w-3.5 h-3.5 border-2 border-vermillion-2/30 border-t-vermillion-2 rounded-full animate-spin" />
                ) : <span className="text-vermillion-2">Force Fail</span>}
              </GhostButton>
            )}
            <GhostButton
              onClick={handleCopyTrace}
              disabled={!data.trace?.traceExternalId}
              title={
                data.trace?.traceExternalId
                  ? "Copy the trace's external ID to the clipboard"
                  : "No trace recorded for this document"
              }
            >
              {copiedTrace ? "Copied" : "Copy trace ID"}
            </GhostButton>
            <GhostButton onClick={handleDownloadJson}>Download JSON</GhostButton>
            {openDocUrl ? (
              <a
                href={openDocUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
              >
                Open doc ↗
              </a>
            ) : (
              <button
                type="button"
                disabled
                title="Document file isn't available in storage"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream opacity-40 cursor-not-allowed"
              >
                Open doc ↗
              </button>
            )}
          </>
        }
      />
    </>
  );

  const metrics = buildMetrics(data, stages);

  const metricsStrip = (
    <div className="grid grid-cols-5 gap-px bg-border border border-border rounded-sm mb-1">
      {metrics.map((m) => (
        <div key={m.label} className="bg-cream px-4 py-3.5 flex flex-col gap-0.5">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
            {m.label}
          </span>
          <span
            className={`font-display text-[22px] font-medium leading-none tracking-tight ${
              m.ok ? "text-green" : "text-ink"
            }`}
            style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
          >
            {m.value}
            {m.unit && (
              <span className="font-body text-[11px] font-normal text-ink-3 ml-0.5 tracking-normal">
                {m.unit}
              </span>
            )}
          </span>
          <span className={`font-mono text-[10px] mt-0.5 ${m.warn ? "text-[#B6861A]" : "text-ink-4"}`}>
            {m.sub}
          </span>
        </div>
      ))}
    </div>
  );

  if (stages.length === 0) {
    return (
      <DetailLayout
        header={header}
        metricsStrip={metricsStrip}
        sidebar={
          <div className="font-mono text-[11px] text-ink-4 py-8 text-center">
            No trace stages recorded for this document yet.
          </div>
        }
        sidebarWidth="0.42fr"
      >
        <div />
      </DetailLayout>
    );
  }

  // ── Side-by-side layout: PDF left, results + timeline right ──
  // Only when extraction results exist. Otherwise fall back to the
  // original Timeline + StageDetail layout.
  if (hasExtraction) {
    const pdfUrl = previewUrl.current ?? data.documentPreviewUrl;
    return (
      <DetailLayout
        header={header}
        metricsStrip={metricsStrip}
        sidebar={
          <div className="h-full" data-testid="trace-pdf-viewer">
            <DocumentViewer
              url={pdfUrl}
              mimeType={data.mimeType}
              filename={data.filename}
              highlights={highlights}
              activeField={activeField}
              onActiveFieldChange={setActiveField}
              overflow="scroll"
              mode="scroll"
              lazy={false}
              markdown={parsedMarkdown}
              markdownLoading={markdownLoading}
              provenance={data.provenanceJson}
              onRequestParsed={requestParsed}
              selection={
                canPoint && correcting
                  ? {
                      active: correcting.pointing,
                      onRegionSelected: handleRegionSelected,
                      snapped: correcting.anchored
                        ? {
                            field: correcting.field,
                            page: correcting.anchored.page,
                            bbox: correcting.anchored.bbox,
                            words: correcting.anchored.words,
                          }
                        : null,
                    }
                  : undefined
              }
            />
          </div>
        }
        sidebarWidth="1fr"
      >
        <div className="flex flex-col h-full min-h-0" data-testid="trace-results-panel">
          {/* Re-extracting banner — above the table so it doesn't overlap */}
          {isProcessing && !liveExtraction && (
            <div className="flex items-center gap-2 px-4 py-2 bg-[#2B6A9E]/[0.08] border border-[#2B6A9E]/20 rounded-sm mb-2 shrink-0">
              <span className="inline-block w-3 h-3 border-2 border-[#2B6A9E]/30 border-t-[#2B6A9E] rounded-full animate-spin" />
              <span className="font-mono text-[11px] text-[#2B6A9E]">
                {data.status === "parsing" ? "Reparsing" : "Re-extracting"} — showing previous results
              </span>
            </div>
          )}

          {/* Document-fit warning — the schema's `fit` block flagged this as a
              likely wrong document. Surfaced on the processed document so a
              misfiled upload is obvious here, not just in the build/test flow. */}
          {data.fitJson && !data.fitJson.ok && (
            <div
              className={`flex items-start gap-2 px-4 py-2 rounded-sm mb-2 shrink-0 border ${
                data.fitJson.action === "reject"
                  ? "bg-vermillion-3/[0.15] border-vermillion-2/30"
                  : "bg-[#B6861A]/[0.10] border-[#B6861A]/25"
              }`}
            >
              <span
                className={`font-mono text-[10px] font-medium uppercase tracking-[0.1em] mt-px shrink-0 ${
                  data.fitJson.action === "reject" ? "text-vermillion-2" : "text-[#B6861A]"
                }`}
              >
                {data.fitJson.action === "reject" ? "Wrong document — rejected" : "Possible wrong document"}
              </span>
              <span className="text-[11px] text-ink leading-snug">
                {data.fitJson.message ?? `Document fit check failed (${data.fitJson.reason ?? "unknown"}).`}
              </span>
            </div>
          )}

          {/* Correction bar — one field at a time, opened by the pencil on a
              scalar row. "Point on document" arms the PDF selection layer;
              the drag resolves to the text underneath and prefills the value. */}
          {correcting && (
            <div
              data-testid="correction-bar"
              className="border border-[#B6861A]/40 bg-[#B6861A]/[0.06] rounded-sm px-3 py-2 mb-2 shrink-0 flex flex-col gap-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9.5px] tracking-[0.1em] uppercase text-[#B6861A] shrink-0">
                  Correct
                </span>
                <code className="font-mono text-[11px] text-ink font-medium shrink-0">
                  {correcting.field}
                </code>
                <input
                  type="text"
                  autoFocus
                  value={correcting.value}
                  onChange={(e) =>
                    setCorrecting((c) => (c ? { ...c, value: e.target.value } : c))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitCorrection();
                    if (e.key === "Escape") setCorrecting(null);
                  }}
                  className="flex-1 min-w-0 font-mono text-[12px] text-ink bg-cream border border-border-strong rounded-sm px-2 py-1 outline-none focus:border-ink transition-colors"
                />
                {canPoint && (
                  <button
                    type="button"
                    data-testid="point-on-document"
                    onClick={() =>
                      setCorrecting((c) =>
                        c ? { ...c, pointing: !c.pointing, error: null } : c,
                      )
                    }
                    title="Drag on the document where the correct value is"
                    className={`shrink-0 inline-flex items-center gap-1 font-mono text-[10px] rounded-sm border px-1.5 py-1 transition-colors ${
                      correcting.pointing
                        ? "border-vermillion-2 bg-vermillion-3/40 text-vermillion-2"
                        : "border-border-strong text-ink-3 hover:border-ink hover:text-ink"
                    }`}
                  >
                    <Crosshair className="w-3 h-3" />
                    {correcting.pointing ? "drag on the document" : "point"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={submitCorrection}
                  disabled={correcting.saving}
                  className="shrink-0 px-2.5 py-1 rounded-sm text-[11.5px] font-medium bg-green text-cream hover:bg-ink transition-colors disabled:opacity-40"
                >
                  {correcting.saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setCorrecting(null)}
                  title="Cancel"
                  className="shrink-0 p-1 rounded-sm text-ink-4 hover:text-ink transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {correcting.anchored && (
                <span className="inline-flex items-center gap-1 font-mono text-[10px] text-green">
                  <Crosshair className="w-3 h-3" />
                  anchored to p.{correcting.anchored.page} — saved as the field&apos;s source highlight
                </span>
              )}
              {correcting.error && (
                <span className="font-mono text-[10px] text-vermillion-2">{correcting.error}</span>
              )}
            </div>
          )}

          {/* Extraction results — click a field to highlight in PDF */}
          <div className={`flex-1 min-h-0 border border-border rounded-sm flex flex-col ${isProcessing && !liveExtraction ? "opacity-60" : ""}`}>
            <TraceResults
              extractionJson={displayExtraction!.extractionJson}
              confidenceScoresJson={displayExtraction!.confidenceScoresJson}
              provenanceJson={displayExtraction!.provenanceJson}
              activeField={activeField}
              onFieldClick={setActiveField}
              onCorrectField={canCorrect ? startCorrection : undefined}
            />
          </div>

          {/* Compact stage timeline */}
          <div className="mt-3 border border-border rounded-sm p-3 overflow-y-auto max-h-[240px] shrink-0" data-testid="trace-stage-timeline">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[9px] font-medium tracking-[0.14em] uppercase text-ink-4">
                Pipeline stages
              </span>
              {isProcessing && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-[#2B6A9E]/30 border-t-[#2B6A9E] rounded-full animate-spin" />
                  <span className="font-mono text-[10px] text-[#2B6A9E]">Running</span>
                </span>
              )}
            </div>
            <StageTimeline
              stages={mergedStageRows}
              documentStatus={data.status}
            />
          </div>
        </div>
      </DetailLayout>
    );
  }

  // ── Fallback: original Timeline + StageDetail layout ──
  // Used when no extraction results exist (e.g. still processing, parse-only).
  return (
    <DetailLayout
      header={header}
      metricsStrip={metricsStrip}
      sidebar={
        <Timeline
          stages={stages}
          selectedIndex={clampedStage}
          onSelect={setSelectedStage}
        />
      }
      sidebarWidth="0.42fr"
    >
      <StageDetail
        stage={stages[clampedStage]!}
        stageIndex={clampedStage}
        totalStages={stages.length}
        onPrev={() => setSelectedStage((i) => Math.max(0, i - 1))}
        onNext={() => setSelectedStage((i) => Math.min(stages.length - 1, i + 1))}
        fields={fields}
        jobSlug={jobSlug}
        documentId={documentId}
        documentPreviewUrl={previewUrl.current ?? data.documentPreviewUrl}
        documentMimeType={data.mimeType}
      />
    </DetailLayout>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Derivations — pure functions that turn API rows into the component shapes
// the existing Timeline / StageDetail / metrics strip already render.
// No JSX changes here, just shape adapters.

function mapStages(
  rows: TraceStageRow[],
  totalDurationMs: number | null,
): TraceStage[] {
  if (rows.length === 0) return [];

  const total =
    totalDurationMs && totalDurationMs > 0
      ? totalDurationMs
      : rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) || 1;

  let cursorMs = 0;
  return rows.map((r) => {
    const dur = Math.max(0, r.durationMs ?? 0);
    const startPct = (cursorMs / total) * 100;
    const widthPct = Math.max(0.4, (dur / total) * 100);
    cursorMs += dur;
    return {
      name: prettyStageName(r.stageName),
      rawName: r.stageName,
      durationMs: dur,
      startPct,
      widthPct,
      status: normalizeStatus(r.status),
      meta: stageMeta(r),
      output: r.summaryJson ?? null,
    };
  });
}

function mapFields(doc: DocumentDetail): TraceField[] {
  const extraction =
    doc.extractionJson && typeof doc.extractionJson === "object"
      ? (doc.extractionJson as Record<string, unknown>)
      : {};
  const baseConfidence = doc.confidence === null ? 0 : Number(doc.confidence);

  const validation =
    doc.validationJson && typeof doc.validationJson === "object"
      ? (doc.validationJson as { error_cause?: string; message?: string })
      : null;

  const keys = Object.keys(extraction);
  if (keys.length === 0) return [];

  return keys.map((name) => {
    const value = extraction[name];
    const formatted =
      value === null || value === undefined
        ? "null"
        : typeof value === "string"
          ? `"${value}"`
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value);
    return {
      name,
      value: formatted,
      chunk: "—",
      confidence: Number.isFinite(baseConfidence) ? baseConfidence : 0,
      ...(validation?.error_cause && value == null
        ? {
            wrong: true,
            diagnostic: validation.message ?? `Extraction ${validation.error_cause}`,
          }
        : {}),
    };
  });
}

function buildMetrics(
  doc: DocumentDetail,
  stages: TraceStage[],
): Array<{ label: string; value: string; unit: string; sub: string; ok?: boolean; warn?: boolean }> {
  // `?? ` alone is wrong here: a stored total of 0 (e.g. DAG runs before the
  // duration fix) is not "no data" — it's a bad value we must fall past. Prefer
  // the first positive source, else sum the stage durations we already have.
  const stageSum = stages.reduce((s, x) => s + x.durationMs, 0);
  const totalMs =
    (doc.trace?.totalDurationMs && doc.trace.totalDurationMs > 0 && doc.trace.totalDurationMs) ||
    (doc.durationMs && doc.durationMs > 0 && doc.durationMs) ||
    stageSum;
  const totalSec = totalMs / 1000;

  const passed = stages.filter((s) => s.status === "ok").length;
  const fail = stages.filter((s) => s.status === "fail").length;
  const warn = stages.filter((s) => s.status === "warn").length;

  const extraction =
    doc.extractionJson && typeof doc.extractionJson === "object"
      ? (doc.extractionJson as Record<string, unknown>)
      : {};
  const fieldCount = Object.keys(extraction).length;
  const emptyFields = Object.values(extraction).filter((v) => v === null || v === undefined).length;

  const cost = doc.costUsd !== null ? `$${Number(doc.costUsd).toFixed(5)}` : "—";
  const status = doc.status;

  return [
    {
      label: "Total duration",
      value: totalSec.toFixed(1),
      unit: "s",
      sub: `${stages.length} stage${stages.length === 1 ? "" : "s"}`,
    },
    {
      label: "Stages",
      value: `${passed}`,
      unit: `/ ${stages.length}`,
      sub:
        fail > 0
          ? `${fail} failed`
          : warn > 0
            ? `${warn} flagged`
            : "all complete",
      ok: fail === 0 && warn === 0 && stages.length > 0,
    },
    {
      label: "Fields extracted",
      value: `${fieldCount - emptyFields}`,
      unit: `/ ${fieldCount || "?"}`,
      sub:
        emptyFields > 0
          ? `${emptyFields} empty`
          : doc.confidence !== null
            ? `confidence ${Number(doc.confidence).toFixed(2)}`
            : "—",
      warn: emptyFields > 0,
    },
    {
      label: "LLM cost",
      value: cost,
      unit: "",
      sub: "gpt-4o-mini",
    },
    {
      label: "Status",
      value: status,
      unit: "",
      sub: doc.completedAt
        ? `completed ${formatTimestamp(doc.completedAt)}`
        : "in flight",
      ok: status === "delivered",
      warn: status === "review",
    },
  ];
}

function normalizeStatus(s: string): "ok" | "warn" | "fail" {
  if (s === "fail" || s === "failed") return "fail";
  if (s === "warn" || s === "review") return "warn";
  if (s === "in_flight") return "warn";
  return "ok";
}

// `STAGE_LABELS` and `prettyStageName` live in ./format so they can be
// unit-tested — vitest in the dashboard package can't load page.tsx
// (Next.js component module).

function stageMeta(r: TraceStageRow): string {
  if (r.errorMessage) return r.errorMessage;
  const s = r.summaryJson;
  if (!s || typeof s !== "object") return "—";

  if (r.stageName === "deliver") {
    const delivered = Number((s as Record<string, unknown>).targets_delivered ?? 0);
    const failed = Number((s as Record<string, unknown>).targets_failed ?? 0);
    const total = Number((s as Record<string, unknown>).targets_total ?? 0);
    const eventType = (s as Record<string, unknown>).event_type;
    const parts: string[] = [
      `delivered: ${delivered}/${total}`,
      ...(failed > 0 ? [`failed: ${failed}`] : []),
      ...(typeof eventType === "string" && eventType.length > 0 ? [`event: ${eventType}`] : []),
    ];
    return parts.join(" · ") || "—";
  }

  const parts: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (v === null || v === undefined) continue;
    if (k === "targets") continue;
    const formatted =
      typeof v === "number" || typeof v === "boolean" || typeof v === "string"
        ? `${v}`
        : JSON.stringify(v);
    parts.push(`${k.replaceAll("_", " ")}: ${formatted}`);
  }
  return parts.slice(0, 3).join(" · ") || "—";
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "delivered":
      return { label: "delivered", className: "bg-green/[0.12] text-green" };
    case "review":
      return { label: "review", className: "bg-[#B6861A]/[0.14] text-[#B6861A]" };
    case "failed":
      return { label: "failed", className: "bg-vermillion-3 text-vermillion-2" };
    case "extracting":
      return { label: "extracting", className: "bg-[#2B6A9E]/[0.12] text-[#2B6A9E]" };
    default:
      return { label: status, className: "bg-cream-2 text-ink-3" };
  }
}
