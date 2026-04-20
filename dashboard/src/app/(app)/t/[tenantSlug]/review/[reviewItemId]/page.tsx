"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Check, X, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import { Breadcrumbs, StickyHeader } from "@/components/layouts";
import { EmptyState } from "@/components/shared/EmptyState";
import { review as reviewApi, type ReviewDetail } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { reasonLabel, reasonTone, formatRelativeTime } from "../format";

type DecisionKind = "accept" | "override" | "reject" | "skip";

export default function ReviewDetailPage() {
  const params = useParams<{ tenantSlug: string; reviewItemId: string }>();
  const router = useRouter();
  const tenantSlug = params?.tenantSlug ?? "";
  const reviewItemId = params?.reviewItemId ?? "";

  // `null` means the user hasn't touched the field — display the model's proposal.
  // A string means they've edited it (including to empty). Reset on route change.
  const [userOverride, setUserOverride] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [submitting, setSubmitting] = useState<DecisionKind | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Items the user chose to skip in this session — hidden from the next-item cursor
  // so "skip" actually advances instead of looping. State (not ref) so useMemo
  // recomputes the queue position when we skip.
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());

  const {
    data: item,
    loading: itemLoading,
    error: itemError,
  } = useApi(useCallback(() => reviewApi.get(reviewItemId), [reviewItemId]));

  const { data: queueIds } = useApi(useCallback(() => reviewApi.queueIds("pending"), []));

  // Queue position math
  const queuePosition = useMemo(() => {
    if (!queueIds || !item) return null;
    const live = queueIds.filter((id) => !skippedIds.has(id));
    const idx = live.indexOf(item.id);
    if (idx === -1) return null;
    return { index: idx + 1, total: live.length };
  }, [queueIds, item, skippedIds]);

  const nextPendingId = useMemo(() => {
    if (!queueIds || !item) return null;
    const live = queueIds.filter((id) => !skippedIds.has(id));
    const idx = live.indexOf(item.id);
    const next = live[idx + 1] ?? live.find((id) => id !== item.id) ?? null;
    return next;
  }, [queueIds, item, skippedIds]);

  const prevPendingId = useMemo(() => {
    if (!queueIds || !item) return null;
    const live = queueIds.filter((id) => !skippedIds.has(id));
    const idx = live.indexOf(item.id);
    return idx > 0 ? (live[idx - 1] ?? null) : null;
  }, [queueIds, item, skippedIds]);

  const goToNext = useCallback(() => {
    if (nextPendingId) {
      router.push(`/t/${tenantSlug}/review/${nextPendingId}`);
    } else {
      router.push(`/t/${tenantSlug}/review`);
    }
  }, [nextPendingId, router, tenantSlug]);

  const goToPrev = useCallback(() => {
    if (prevPendingId) {
      router.push(`/t/${tenantSlug}/review/${prevPendingId}`);
    }
  }, [prevPendingId, router, tenantSlug]);

  const submitAccept = useCallback(async () => {
    if (!item || submitting) return;
    setSubmitting("accept");
    setErrorMsg(null);
    try {
      await reviewApi.accept(item.id, note.trim() ? { note: note.trim() } : undefined);
      goToNext();
    } catch (err) {
      setSubmitting(null);
      setErrorMsg(err instanceof Error ? err.message : "Accept failed");
    }
  }, [item, note, submitting, goToNext]);

  const submitOverride = useCallback(async () => {
    if (!item || submitting || userOverride === null) return;
    const parsed = parseOverride(userOverride, item.proposedValue);
    setSubmitting("override");
    setErrorMsg(null);
    try {
      await reviewApi.override(item.id, {
        value: parsed,
        note: note.trim() || undefined,
      });
      goToNext();
    } catch (err) {
      setSubmitting(null);
      setErrorMsg(err instanceof Error ? err.message : "Override failed");
    }
  }, [item, userOverride, note, submitting, goToNext]);

  const submitReject = useCallback(async () => {
    if (!item || submitting || !rejectReason.trim()) return;
    setSubmitting("reject");
    setErrorMsg(null);
    try {
      await reviewApi.reject(item.id, { reason: rejectReason.trim() });
      goToNext();
    } catch (err) {
      setSubmitting(null);
      setErrorMsg(err instanceof Error ? err.message : "Reject failed");
    }
  }, [item, rejectReason, submitting, goToNext]);

  const submitSkip = useCallback(async () => {
    if (!item || submitting) return;
    setSubmitting("skip");
    setSkippedIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    try {
      await reviewApi.skip(item.id);
    } catch {
      // Skip is best-effort; advance regardless.
    }
    goToNext();
  }, [item, submitting, goToNext]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!item || rejectOpen) return;
    function handler(e: KeyboardEvent) {
      // Ignore when a text input / textarea is focused
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        submitAccept();
      } else if (k === "e" || k === "o") {
        e.preventDefault();
        submitOverride();
      } else if (k === "r") {
        e.preventDefault();
        setRejectOpen(true);
      } else if (k === "s" || k === "j") {
        e.preventDefault();
        submitSkip();
      } else if (k === "k") {
        e.preventDefault();
        goToPrev();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [item, rejectOpen, submitAccept, submitOverride, submitSkip, goToPrev]);

  if (itemError) {
    return (
      <ReviewShell tenantSlug={tenantSlug} reviewItemId={reviewItemId}>
        <EmptyState
          title={itemError.message.includes("not found") ? "Review item not found" : "Cannot reach API"}
          description={itemError.message}
          action={
            <Link
              href={`/t/${tenantSlug}/review`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to queue
            </Link>
          }
        />
      </ReviewShell>
    );
  }

  if (!item || itemLoading) {
    return (
      <ReviewShell tenantSlug={tenantSlug} reviewItemId={reviewItemId}>
        <div className="animate-pulse font-mono text-[11px] text-ink-4 py-8 text-center">
          Loading...
        </div>
      </ReviewShell>
    );
  }

  const isResolved = item.status !== "pending";
  const confidence = item.confidence === null ? null : Number(item.confidence);

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs
          items={[
            { label: tenantSlug, href: `/t/${tenantSlug}` },
            { label: "Review", href: `/t/${tenantSlug}/review` },
            { label: item.documentFilename ?? item.id },
          ]}
        />
        <ReviewHeader
          item={item}
          queuePosition={queuePosition}
          onPrev={prevPendingId ? goToPrev : null}
          onNext={nextPendingId ? goToNext : null}
        />
      </StickyHeader>

      <div className="flex-1 min-h-0 grid grid-cols-2 gap-4 px-10 pt-4 pb-4 overflow-hidden">
        <DocumentPreview url={item.documentPreviewUrl} mimeType={item.documentMimeType} />
        <div className="flex flex-col min-h-0 gap-4 overflow-y-auto">
          <FieldPanel item={item} confidence={confidence} />

          {!isResolved ? (
            <DecisionPanel
              item={item}
              overrideValue={userOverride ?? stringifyValue(item.proposedValue)}
              overrideChanged={userOverride !== null}
              onOverrideChange={setUserOverride}
              note={note}
              onNoteChange={setNote}
              submitting={submitting}
              onAccept={submitAccept}
              onOverride={submitOverride}
              onSkip={submitSkip}
              onRejectOpen={() => setRejectOpen(true)}
              error={errorMsg}
            />
          ) : (
            <ResolvedPanel item={item} />
          )}
        </div>
      </div>

      {rejectOpen && (
        <RejectDialog
          reason={rejectReason}
          onReason={setRejectReason}
          submitting={submitting === "reject"}
          onClose={() => {
            setRejectOpen(false);
            setRejectReason("");
          }}
          onSubmit={submitReject}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

function ReviewShell({
  tenantSlug,
  reviewItemId,
  children,
}: {
  tenantSlug: string;
  reviewItemId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <StickyHeader>
        <Breadcrumbs
          items={[
            { label: tenantSlug, href: `/t/${tenantSlug}` },
            { label: "Review", href: `/t/${tenantSlug}/review` },
            { label: reviewItemId },
          ]}
        />
      </StickyHeader>
      <div className="flex-1 overflow-y-auto px-10 pt-4 pb-8">{children}</div>
    </div>
  );
}

function ReviewHeader({
  item,
  queuePosition,
  onPrev,
  onNext,
}: {
  item: ReviewDetail;
  queuePosition: { index: number; total: number } | null;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const tone = reasonTone(item.reason);
  const reasonPillStyles =
    tone === "warn"
      ? "bg-[#B6861A]/[0.14] text-[#B6861A]"
      : tone === "fail"
      ? "bg-vermillion-3 text-vermillion-2"
      : "bg-cream-2 text-ink-3";

  return (
    <div className="flex items-start justify-between gap-6 mt-2">
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h1
            className="font-display text-[26px] font-medium leading-none tracking-tight text-ink m-0"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            {item.documentFilename ?? "Unknown document"}
          </h1>
          <code className="font-mono text-[11px] text-vermillion-2 bg-vermillion-3/40 px-2 py-0.5 rounded-sm">
            {item.fieldName}
          </code>
          <span
            className={`inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] ${reasonPillStyles}`}
          >
            {reasonLabel(item.reason)}
            {item.confidence !== null && (
              <span className="ml-1 font-normal">· {Number(item.confidence).toFixed(2)}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3 flex-wrap">
          {item.schemaName && (
            <>
              <span>
                {item.schemaName}
                {item.schemaVersion !== null && (
                  <span className="text-ink-4 ml-1">v{item.schemaVersion}</span>
                )}
              </span>
              <span className="text-cream-4 text-[8px]">●</span>
            </>
          )}
          {item.jobSlug && (
            <>
              <span>job {item.jobSlug}</span>
              <span className="text-cream-4 text-[8px]">●</span>
            </>
          )}
          <span>flagged {formatRelativeTime(item.createdAt)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {queuePosition && (
          <span className="font-mono text-[10px] text-ink-4 px-2">
            Item {queuePosition.index} of {queuePosition.total} pending
          </span>
        )}
        <button
          type="button"
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-3 border border-border-strong rounded-sm px-2 py-1 hover:border-ink hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-3 h-3" />
          prev
          <span className="text-ink-4 text-[10px] ml-0.5 px-1 border border-border rounded-[2px]">
            K
          </span>
        </button>
        <button
          type="button"
          onClick={onNext ?? undefined}
          disabled={!onNext}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-3 border border-border-strong rounded-sm px-2 py-1 hover:border-ink hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          next
          <ChevronRight className="w-3 h-3" />
          <span className="text-ink-4 text-[10px] ml-0.5 px-1 border border-border rounded-[2px]">
            J
          </span>
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Document preview

function DocumentPreview({
  url,
  mimeType,
}: {
  url: string | null;
  mimeType: string | null;
}) {
  const [errored, setErrored] = useState(false);

  if (!url) {
    return (
      <div className="flex items-center justify-center border border-border rounded-sm bg-cream-2/40 text-ink-3 text-[13px]">
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <FileText className="w-6 h-6 text-ink-4" />
          <span>Document preview unavailable.</span>
          <span className="font-mono text-[10px] text-ink-4 max-w-[36ch]">
            The source file isn&apos;t in storage yet. Previews appear once the pipeline finishes
            ingesting the document.
          </span>
        </div>
      </div>
    );
  }

  if (errored) {
    return (
      <div className="flex items-center justify-center border border-border rounded-sm bg-cream-2/40 text-ink-3 text-[13px]">
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <FileText className="w-6 h-6 text-ink-4" />
          <span>Preview failed to load.</span>
          <span className="font-mono text-[10px] text-ink-4">
            The signed URL may have expired or the object is missing.
          </span>
        </div>
      </div>
    );
  }

  const isImage = mimeType?.startsWith("image/");
  return (
    <div className="border border-border rounded-sm bg-cream-2/40 overflow-hidden">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="Document preview"
          className="w-full h-full object-contain"
          onError={() => setErrored(true)}
        />
      ) : (
        <iframe
          src={url}
          className="w-full h-full border-0"
          title="Document preview"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Field + decision panels

function FieldPanel({
  item,
  confidence,
}: {
  item: ReviewDetail;
  confidence: number | null;
}) {
  const extraction = (item.documentExtractionJson ?? null) as Record<string, unknown> | null;
  const allFields = extraction ? Object.entries(extraction) : [];
  // The flagged field always at the top.
  const orderedFields: [string, unknown][] = [
    [item.fieldName, item.proposedValue],
    ...allFields.filter(([k]) => k !== item.fieldName),
  ];

  return (
    <div className="border border-border rounded-sm bg-cream">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-cream-2/50">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
          Extraction
        </span>
        <span className="font-mono text-[10px] text-ink-4">
          {orderedFields.length} {orderedFields.length === 1 ? "field" : "fields"}
        </span>
      </div>
      <div className="divide-y divide-dotted divide-border">
        {orderedFields.map(([name, value]) => {
          const isFlagged = name === item.fieldName;
          return (
            <div
              key={name}
              className={`grid grid-cols-[140px_1fr_100px] gap-3 items-center px-4 py-2 ${
                isFlagged ? "bg-[#B6861A]/[0.08]" : ""
              }`}
            >
              <code
                className={`font-mono text-[11.5px] truncate ${
                  isFlagged ? "text-vermillion-2 font-medium" : "text-ink-2"
                }`}
              >
                {name}
              </code>
              <span className="font-mono text-[11.5px] text-ink truncate">
                {stringifyValue(value)}
              </span>
              <div className="flex justify-end">
                {isFlagged && confidence !== null ? (
                  <ConfidenceIndicator confidence={confidence} />
                ) : (
                  <span className="font-mono text-[10px] text-ink-4">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfidenceIndicator({ confidence }: { confidence: number }) {
  const pct = Math.min(1, Math.max(0, confidence)) * 100;
  const color = confidence < 0.7 ? "bg-[#B6861A]" : confidence < 0.9 ? "bg-ink-3" : "bg-green";
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-cream-2 rounded-full overflow-hidden min-w-[32px]">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">
        {confidence.toFixed(2)}
      </span>
    </div>
  );
}

function DecisionPanel({
  item,
  overrideValue,
  overrideChanged,
  onOverrideChange,
  note,
  onNoteChange,
  submitting,
  onAccept,
  onOverride,
  onSkip,
  onRejectOpen,
  error,
}: {
  item: ReviewDetail;
  overrideValue: string;
  overrideChanged: boolean;
  onOverrideChange: (v: string) => void;
  note: string;
  onNoteChange: (n: string) => void;
  submitting: DecisionKind | null;
  onAccept: () => void;
  onOverride: () => void;
  onSkip: () => void;
  onRejectOpen: () => void;
  error: string | null;
}) {
  return (
    <div className="border border-border rounded-sm bg-cream">
      <div className="px-4 py-2 border-b border-border bg-cream-2/50">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
          Decision
        </span>
      </div>
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4">
              Model proposed
            </span>
            <code className="font-mono text-[12px] text-ink bg-cream-2 border border-border rounded-sm px-2 py-1.5 break-all">
              {stringifyValue(item.proposedValue)}
            </code>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4">
              Your override
            </span>
            <input
              type="text"
              value={overrideValue}
              onChange={(e) => onOverrideChange(e.target.value)}
              className="font-mono text-[12px] text-ink bg-cream border border-border-strong rounded-sm px-2 py-1.5 outline-none focus:border-ink transition-colors"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4">
            Note (optional)
          </span>
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="why you accepted, overrode, or rejected…"
            rows={2}
            className="font-mono text-[11.5px] text-ink bg-cream-2 border border-border rounded-sm px-2 py-1.5 outline-none focus:border-ink focus:bg-cream transition-colors resize-none"
          />
        </div>

        {error && (
          <div className="font-mono text-[11px] text-vermillion-2 bg-vermillion-3/50 px-2 py-1 rounded-sm">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <DecisionButton
            label="Approve"
            shortcut="A"
            variant="primary"
            loading={submitting === "accept"}
            disabled={submitting !== null}
            onClick={onAccept}
          />
          <DecisionButton
            label={overrideChanged ? "Approve with edits" : "Override"}
            shortcut="E"
            variant="outline"
            loading={submitting === "override"}
            disabled={submitting !== null || !overrideChanged}
            onClick={onOverride}
          />
          <DecisionButton
            label="Reject"
            shortcut="R"
            variant="danger"
            loading={submitting === "reject"}
            disabled={submitting !== null}
            onClick={onRejectOpen}
          />
          <span className="flex-1" />
          <DecisionButton
            label="Skip"
            shortcut="S"
            variant="ghost"
            loading={submitting === "skip"}
            disabled={submitting !== null}
            onClick={onSkip}
          />
        </div>
      </div>
    </div>
  );
}

function DecisionButton({
  label,
  shortcut,
  variant,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  shortcut: string;
  variant: "primary" | "outline" | "danger" | "ghost";
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const base =
    "inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const variants: Record<typeof variant, string> = {
    primary: "bg-green text-cream hover:bg-ink",
    outline: "bg-cream text-green border border-green/60 hover:border-green hover:bg-green/[0.05]",
    danger: "bg-vermillion-2 text-cream hover:bg-ink",
    ghost: "bg-cream text-ink-3 border border-border-strong hover:border-ink hover:text-ink",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${variants[variant]}`}
    >
      {loading ? "…" : label}
      <span
        className={`font-mono text-[9.5px] px-1 rounded-[2px] ${
          variant === "primary" || variant === "danger"
            ? "text-cream/70 border border-cream/40"
            : "text-ink-4 border border-border"
        }`}
      >
        {shortcut}
      </span>
    </button>
  );
}

function RejectDialog({
  reason,
  onReason,
  submitting,
  onClose,
  onSubmit,
}: {
  reason: string;
  onReason: (r: string) => void;
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-ink/20" onClick={onClose} />
      <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[460px] p-6">
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-display text-[20px] font-medium text-ink leading-tight">
            Reject this review
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-4 hover:text-ink transition-colors p-1 -m-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">
          The document will be marked failed and won&apos;t proceed to delivery.
        </p>
        <label className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4 block mb-1">
          Reason (required)
        </label>
        <textarea
          ref={textareaRef}
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={3}
          placeholder="e.g. unreadable scan, wrong document type…"
          className="w-full font-mono text-[12px] text-ink bg-cream-2 border border-border rounded-sm px-2.5 py-1.5 outline-none focus:border-ink focus:bg-cream transition-colors resize-none"
        />
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!reason.trim() || submitting}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Rejecting…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResolvedPanel({ item }: { item: ReviewDetail }) {
  return (
    <div className="border border-border rounded-sm bg-cream">
      <div className="px-4 py-2 border-b border-border bg-cream-2/50 flex items-center gap-2">
        <Check className="w-3.5 h-3.5 text-green" />
        <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
          {item.resolution === "rejected" ? "Rejected" : "Approved"} ·{" "}
          {formatRelativeTime(item.resolvedAt)}
        </span>
      </div>
      <div className="p-4 flex flex-col gap-3">
        <div>
          <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4 block mb-1">
            Final value
          </span>
          <code className="font-mono text-[12px] text-ink bg-cream-2 border border-border rounded-sm px-2 py-1.5 block break-all">
            {stringifyValue(item.finalValue ?? item.proposedValue)}
          </code>
        </div>
        {item.note && (
          <div>
            <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-ink-4 block mb-1">
              Note
            </span>
            <p className="text-[12.5px] text-ink-2 whitespace-pre-wrap">{item.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Helpers

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Try to restore the override value to the same JSON shape the proposal had —
 * if the proposal was a number, parse the input as a number; if it was an
 * object/array, parse as JSON; otherwise keep as string.
 */
function parseOverride(raw: string, proposal: unknown): unknown {
  const trimmed = raw.trim();
  if (typeof proposal === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (proposal !== null && typeof proposal === "object") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
