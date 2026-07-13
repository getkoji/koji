"use client";

/**
 * Corpus labeling queue — a focused, keyboard-driven stepper for building
 * ground truth across many documents.
 *
 * The corpus is effectively a work queue: some entries have no ground truth,
 * some have drafts, some are approved. This surface steps through them one at a
 * time with the good editor — the shared DocumentViewer (so draw-a-box-to-
 * correct works) on the left and the confirm-vs-correct funnel
 * (`GroundTruthPanel`) on the right — the same pattern the review queue uses.
 *
 * Per entry it seeds the funnel from any existing ground truth, and offers an
 * optional "Propose with AI" (runs extraction) to pre-fill. Saving advances to
 * the next entry. All the backend already exists (corpus resolve-region,
 * versioned GT with geometry); this is the queue shell over it.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { X, ChevronLeft, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { DocumentViewer } from "@/components/shared/DocumentViewer";
import type { SelectionConfig, BBoxHighlight } from "@/components/shared/PdfViewer";
import { runExtraction, type ExtractionProgress } from "@/lib/extraction-run";
import { GroundTruthPanel } from "../build/GroundTruthPanel";

export interface QueueEntry {
  id: string;
  filename: string;
  mimeType: string;
  reviewStatus?: string | null;
  hasGroundTruth?: boolean;
}

interface ProvSpan {
  page?: number;
  bbox?: { x: number; y: number; w: number; h: number };
  words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
  resolution?: string;
}
type ProvMap = Record<string, ProvSpan | null>;

interface Seed {
  extracted: Record<string, unknown>;
  provenance: ProvMap | undefined;
}

interface Props {
  schemaSlug: string;
  tenantSlug: string;
  schemaYaml: string | null;
  /** Scalar schema field names — shown in the funnel even when empty. */
  scalarFields: string[];
  /** Extraction model preference (optional; server falls back to tenant default). */
  model?: string;
  /** Ordered queue of entries to label (parent decides ordering/filtering). */
  queue: QueueEntry[];
  /** Entry id to start on. */
  startId: string;
  /** Called after a save so the parent can refetch the list / statuses. */
  onSaved?: (entryId: string) => void;
  onExit: () => void;
}

function statusLabel(e: QueueEntry): { text: string; cls: string } {
  if (e.reviewStatus === "approved") return { text: "approved", cls: "text-green border-green/30 bg-green/10" };
  if (e.reviewStatus === "draft" || e.hasGroundTruth)
    return { text: "draft", cls: "text-yellow-700 border-yellow-600/30 bg-yellow-500/10" };
  return { text: "needs GT", cls: "text-vermillion-2 border-vermillion-2/30 bg-vermillion-3/20" };
}

/** Flatten a provenance map into scalar-field highlights for the viewer. */
function toHighlights(prov: ProvMap | undefined): BBoxHighlight[] {
  if (!prov) return [];
  const out: BBoxHighlight[] = [];
  for (const [field, v] of Object.entries(prov)) {
    if (!v) continue;
    const page = v.words?.[0]?.page ?? v.page;
    if (page == null) continue;
    if (v.words?.length || v.bbox != null) {
      out.push({ field, page, bbox: v.bbox, words: v.words });
    }
  }
  return out;
}

export function CorpusLabelStepper({
  schemaSlug,
  tenantSlug,
  schemaYaml,
  scalarFields,
  model,
  queue,
  startId,
  onSaved,
  onExit,
}: Props) {
  // Freeze the order for the session: saving an entry flips its status, which
  // would otherwise re-sort the parent's queue and shuffle entries out from
  // under the cursor. We navigate this fixed id order and only read *status*
  // from the live `queue` prop (so badges/counts still refresh after a save).
  const [orderedIds] = useState(() => queue.map((e) => e.id));
  const queueById = useMemo(() => new Map(queue.map((e) => [e.id, e])), [queue]);
  const orderedQueue: QueueEntry[] = useMemo(
    () => orderedIds.map((id) => queueById.get(id)).filter((e): e is QueueEntry => e != null),
    [orderedIds, queueById],
  );

  const startIndex = Math.max(0, orderedQueue.findIndex((e) => e.id === startId));
  const [index, setIndex] = useState(startIndex);
  const entry = orderedQueue[index] ?? null;

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [seed, setSeed] = useState<Seed>({ extracted: {}, provenance: undefined });
  const [seedVersion, setSeedVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [gtSelection, setGtSelection] = useState<SelectionConfig | null>(null);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [progress, setProgress] = useState<ExtractionProgress | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= orderedQueue.length) return;
      setIndex(next);
      setGtSelection(null);
      setActiveField(null);
      setRunError(null);
    },
    [orderedQueue.length],
  );

  // Load preview URL + existing ground truth whenever the entry changes.
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setLoading(true);
    setPreviewUrl(null);
    setSeed({ extracted: {}, provenance: undefined });
    (async () => {
      try {
        const [urlRes, gtRes] = await Promise.all([
          api.get<{ url: string }>(`/api/schemas/${schemaSlug}/corpus/${entry.id}/url`).catch(() => null),
          api
            .get<{ data: Array<{ payloadJson: Record<string, unknown>; provenanceJson: ProvMap | null }> }>(
              `/api/schemas/${schemaSlug}/corpus/${entry.id}/ground-truth`,
            )
            .catch(() => null),
        ]);
        if (cancelled) return;
        setPreviewUrl(urlRes?.url ?? null);
        const latest = gtRes?.data?.[0];
        setSeed({
          extracted: latest?.payloadJson ?? {},
          provenance: latest?.provenanceJson ?? undefined,
        });
        setSeedVersion((v) => v + 1);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry?.id, schemaSlug]);

  const propose = useCallback(async () => {
    if (!entry || !schemaYaml) return;
    setExtracting(true);
    setRunError(null);
    setProgress({ pages: 0, scanned: false, ocr_skipped: false, estimated_seconds: 0, percent: 0, estimated_remaining_seconds: 0, phase: "detecting" });
    try {
      await runExtraction({
        corpusEntryId: entry.id,
        schemaYaml,
        tenantSlug,
        model,
        onProgress: (patch) => setProgress((p) => ({ ...(p ?? ({} as ExtractionProgress)), ...patch })),
        onComplete: (result) => {
          setSeed({
            extracted: result.extracted ?? {},
            provenance: (result.provenance as ProvMap | null) ?? undefined,
          });
          setSeedVersion((v) => v + 1);
        },
        onError: (err) => setRunError(err),
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Extraction failed.");
    } finally {
      setExtracting(false);
      setProgress(null);
    }
  }, [entry?.id, schemaYaml, tenantSlug, model]);

  const handleSaved = useCallback(() => {
    if (entry) onSaved?.(entry.id);
    // Advance to the next entry; if this was the last, stay put (the panel
    // shows its saved state).
    if (index < orderedQueue.length - 1) goTo(index + 1);
  }, [entry, index, orderedQueue.length, goTo, onSaved]);

  // Keyboard: next/prev/skip. Save lives in the funnel (and auto-advances).
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "arrowright") { e.preventDefault(); goTo(index + 1); }
      else if (k === "k" || k === "arrowleft") { e.preventDefault(); goTo(index - 1); }
      else if (k === "s") { e.preventDefault(); goTo(index + 1); }
      else if (k === "escape") { e.preventDefault(); onExit(); }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, goTo, onExit]);

  const highlights = useMemo(() => toHighlights(seed.provenance), [seed.provenance]);
  const remaining = orderedQueue.filter((e) => e.reviewStatus !== "approved").length;

  if (!entry) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-[13px] text-ink font-medium mb-2">Nothing to label</div>
          <button onClick={onExit} className="text-[12px] text-ink-3 underline">Back to corpus</button>
        </div>
      </div>
    );
  }

  const status = statusLabel(entry);

  return (
    <div className="h-full flex flex-col bg-cream">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onExit} title="Exit labeling (Esc)" className="text-ink-4 hover:text-ink transition-colors p-1 rounded-sm hover:bg-cream-2 shrink-0">
            <X className="w-4 h-4" />
          </button>
          <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 shrink-0">Labeling</span>
          <span className="text-[12px] text-ink truncate min-w-0" title={entry.filename}>{entry.filename}</span>
          <span className={`shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded-sm border ${status.cls}`}>{status.text}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-mono text-ink-4">
            {index + 1} / {orderedQueue.length} · {remaining} to go
          </span>
          <button onClick={() => goTo(index - 1)} disabled={index === 0} title="Previous (k)" className="p-1 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 disabled:opacity-30">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => goTo(index + 1)} disabled={index >= orderedQueue.length - 1} title="Skip (s) / Next (j)" className="p-1 rounded-sm text-ink-4 hover:text-ink hover:bg-cream-2 disabled:opacity-30">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body: document | funnel */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_360px]">
        {/* Document */}
        <div className="min-h-0 border-r border-border overflow-hidden">
          {previewUrl ? (
            <DocumentViewer
              url={previewUrl}
              mimeType={entry.mimeType}
              filename={entry.filename}
              highlights={highlights}
              activeField={activeField}
              onActiveFieldChange={setActiveField}
              selection={gtSelection ?? undefined}
              lazy={false}
              className="h-full overflow-hidden"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-ink-4">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview unavailable"}
            </div>
          )}
        </div>

        {/* Funnel */}
        <div className="min-h-0 overflow-y-auto p-3 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-ink-3">Ground truth</span>
            <button
              onClick={propose}
              disabled={extracting || !schemaYaml}
              title="Run extraction to pre-fill proposed values"
              className="flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-medium bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors disabled:opacity-50"
            >
              {extracting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {extracting ? (progress?.phase === "parsing" ? "Parsing…" : "Extracting…") : "Propose with AI"}
            </button>
          </div>
          {runError && <p className="text-[11px] text-vermillion-2 mb-2">{runError}</p>}
          <GroundTruthPanel
            key={`${entry.id}:${seedVersion}`}
            schemaSlug={schemaSlug}
            entryId={entry.id}
            extracted={seed.extracted}
            provenance={seed.provenance}
            schemaFields={scalarFields}
            onSelectionConfigChange={setGtSelection}
            onFocusField={setActiveField}
            onSaved={handleSaved}
          />
        </div>
      </div>
    </div>
  );
}
