"use client";

import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { TraceStage, TraceField } from "@/lib/types";
import { Timeline } from "@/components/surfaces/trace/Timeline";
import { StageDetail } from "@/components/surfaces/trace/StageDetail";
import { DetailLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { jobs as jobsApi, type DocumentDetail, type TraceStageRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";

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

function GhostButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

export default function TraceViewPage() {
  const params = useParams<{ tenantSlug: string; jobSlug: string; documentId: string }>();
  const tenantSlug = params?.tenantSlug ?? "";
  const jobSlug = params?.jobSlug ?? "";
  const documentId = params?.documentId ?? "";

  const { data, loading, error } = useApi(
    useCallback(() => jobsApi.document(jobSlug, documentId), [jobSlug, documentId]),
  );

  const stages = useMemo<TraceStage[]>(
    () => (data ? mapStages(data.stages, data.trace?.totalDurationMs ?? null) : []),
    [data],
  );
  const fields = useMemo<TraceField[]>(() => (data ? mapFields(data) : []), [data]);

  // Clamp selected index to stages length so a short trace doesn't blow up.
  const [selectedStage, setSelectedStage] = useState(0);
  const [copiedTrace, setCopiedTrace] = useState(false);

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
    ? `${data.schemaName} v${data.schemaVersion}`
    : data.schemaName ?? "—";
  const startedLabel = formatTimestamp(data.trace?.startedAt ?? data.startedAt ?? data.createdAt);
  const traceIdLabel = data.trace?.traceExternalId ?? "—";

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
          </>
        }
        actions={
          <>
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
            {data.documentPreviewUrl ? (
              <a
                href={data.documentPreviewUrl}
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

  // Anchor the percent scale to the real trace duration when we have it;
  // otherwise sum the stage durations as a fallback so the Timeline always
  // fills its bar.
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
      durationMs: dur,
      startPct,
      widthPct,
      status: normalizeStatus(r.status),
      meta: stageMeta(r),
    };
  });
}

function mapFields(doc: DocumentDetail): TraceField[] {
  const extraction =
    doc.extractionJson && typeof doc.extractionJson === "object"
      ? (doc.extractionJson as Record<string, unknown>)
      : {};
  const baseConfidence = doc.confidence === null ? 0 : Number(doc.confidence);

  // Pull review_item-style diagnostics off the validation blob if present —
  // a failed doc stores { error_cause, message } there.
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
      // Per-field chunk attribution + confidence isn't persisted yet — show
      // a doc-level confidence uniformly until we save confidence_scores.
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
  const totalMs =
    doc.trace?.totalDurationMs ??
    doc.durationMs ??
    stages.reduce((s, x) => s + x.durationMs, 0);
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
  return "ok";
}

const STAGE_LABELS: Record<string, string> = {
  ingress: "Ingress",
  integrity: "Integrity check",
  ocr_quality: "OCR quality",
  classify: "Classify",
  extract: "Extract",
  normalize: "Normalize",
  validate: "Validate",
  review: "Review queue",
  hitl_router: "Review queue",
  human_review: "Human review",
  emit: "Emit",
};

function prettyStageName(name: string): string {
  return STAGE_LABELS[name] ?? name.replaceAll("_", " ");
}

function stageMeta(r: TraceStageRow): string {
  if (r.errorMessage) return r.errorMessage;
  const s = r.summaryJson;
  if (!s || typeof s !== "object") return "—";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (v === null || v === undefined) continue;
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
