"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { ChevronLeft, ChevronRight, Highlighter } from "lucide-react";
import dynamic from "next/dynamic";
import {
  sourceConfidence,
  type ResolutionRung,
  type SourceConfidence,
  SOURCE_CONFIDENCE_LABEL,
  SOURCE_CONFIDENCE_DESCRIPTION,
} from "@/lib/provenance-resolution";

// react-pdf uses pdfjs which requires DOM APIs (DOMMatrix, canvas) that don't
// exist during SSR. Import the entire component client-side only.
const ReactPdfDocument = dynamic(
  () => import("react-pdf").then((mod) => {
    mod.pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
    return { default: mod.Document };
  }),
  { ssr: false },
);

const ReactPdfPage = dynamic(
  () => import("react-pdf").then((mod) => ({ default: mod.Page })),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WordBox {
  text: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BBoxHighlight {
  /** Stable match key — what koji:setActiveField / koji:fieldClicked use. */
  field: string;
  page: number;
  bbox?: { x: number; y: number; w: number; h: number };
  words?: WordBox[];
  reasoning?: string;
  /** Extracted value for this field (from embed-data); shown in the field picker. */
  value?: string;
  /**
   * Human-readable display name for the field picker. Lets a consumer use an
   * opaque/stable `field` key (e.g. a record id) without the dropdown showing
   * it raw — the picker renders `label ?? field`.
   */
  label?: string;
  /**
   * How this field's geometry was resolved — the provenance resolution "rung"
   * (see `@/lib/provenance-resolution`). Drives exact vs. best-guess highlight
   * styling. Absent for host-supplied highlights (treated as exact).
   */
  resolution?: ResolutionRung;
}

/** Highlight colors, overridable by the embedding host (query param / koji:setTheme). */
export interface HighlightTheme {
  /** CSS color for the active/selected highlight box. Pass rgba()/hsla() for translucency. */
  activeColor?: string;
  /** CSS color for all other (inactive) highlight boxes. */
  inactiveColor?: string;
}

/**
 * A region of a page the user selected, in the repo-wide bbox convention:
 * normalized [0,1] fractions of the page, origin top-left, page 1-indexed.
 * This is exactly the shape `POST .../resolve-region` accepts.
 */
export interface RegionSelection {
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Region-selection config (highlight-to-correct). When `active`, a crosshair
 * drag layer sits over each page; releasing the drag reports the normalized
 * region via `onRegionSelected`. The viewer stays network-free: the host
 * resolves the region (resolve-region endpoint) and passes the result back
 * as `snapped`, which renders as an echo highlight so the drag visibly snaps
 * to the matched words. `snapped` renders whether or not `active` is still
 * set, so the echo survives the host disarming selection mode after a pick.
 */
export interface SelectionConfig {
  active: boolean;
  onRegionSelected: (region: RegionSelection) => void;
  snapped?: BBoxHighlight | null;
}

/** Display mode: paginated (arrow nav, one page) or scroll (all pages stacked). */
export type ViewMode = "paginated" | "scroll";
/** Scrollbar behavior for the viewer container. */
export type ViewOverflow = "auto" | "scroll" | "hidden";

/** Messages the embed viewer accepts from its parent frame (inbound). */
export type EmbedMessage =
  | { type: "koji:setActiveField"; field: string | null }
  | { type: "koji:setHighlights"; highlights: BBoxHighlight[] }
  | { type: "koji:goToPage"; page: number }
  | { type: "koji:setToken"; token: string }
  | { type: "koji:setTheme"; theme: HighlightTheme }
  | { type: "koji:setViewMode"; mode?: ViewMode; overflow?: ViewOverflow };

/** Messages the embed viewer emits to its parent frame (outbound). */
export type EmbedOutboundMessage =
  | { type: "koji:ready"; pageCount: number }
  | { type: "koji:fieldClicked"; field: string; page: number }
  | { type: "koji:pageChanged"; page: number }
  | { type: "koji:visibleField"; field: string | null; page: number };

interface PdfViewerProps {
  url: string;
  highlights?: BBoxHighlight[];
  activeField?: string | null;
  onPageChange?: (page: number) => void;
  /** Imperative page navigation — set/bump to jump to a page (wires koji:goToPage). */
  targetPage?: number | null;
  /** Fired when the user clicks a highlight box in the PDF. */
  onFieldClick?: (field: string, page: number) => void;
  /** Fired once the PDF document has loaded, with its page count. */
  onLoad?: (info: { pageCount: number }) => void;
  /**
   * Fired when the highlighted field whose box is most prominently in view
   * changes (page is the field's page; null when no highlighted field is in
   * view). Drives the embed's outbound koji:visibleField. When omitted, the
   * tracking observer is not set up.
   */
  onVisibleFieldChange?: (field: string | null, page: number) => void;
  /** Highlight colors — overrides the default vermillion/cream styling. */
  theme?: HighlightTheme;
  /** Control scrollbar behavior: "auto" (default, may flash), "scroll" (always visible), "hidden" (no scrollbars) */
  overflow?: ViewOverflow;
  /** Display mode: "paginated" shows one page at a time with arrows, "scroll" renders all pages in a scrollable container */
  mode?: ViewMode;
  /** Optional element rendered at the start of the toolbar (e.g. a field picker). Constrained so it can't crowd out the page nav. */
  toolbarSlot?: React.ReactNode;
  /** Region selection (highlight-to-correct) — see SelectionConfig. */
  selection?: SelectionConfig;
}

// Tailwind only ships classes it can see as literal strings. Mapping the
// overflow prop through this dictionary keeps the class names statically
// visible to the JIT compiler, so all three options actually generate CSS.
// Previously this used `overflow-${overflow}` which compiled to no CSS at
// all and silently broke scrolling.
const overflowClass: Record<NonNullable<PdfViewerProps["overflow"]>, string> = {
  auto: "overflow-auto",
  scroll: "overflow-scroll",
  hidden: "overflow-hidden",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PdfViewer({ url, highlights = [], activeField, onPageChange, targetPage, onFieldClick, onLoad, onVisibleFieldChange, theme, overflow = "auto", mode = "paginated", toolbarSlot, selection }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  // Mirror currentPage into a ref so the (mount-once) visible-field observer
  // can read it without being torn down on every page change.
  const currentPageRef = useRef(1);
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Load react-pdf CSS client-side
  useEffect(() => {
    import("react-pdf/dist/Page/TextLayer.css");
    import("react-pdf/dist/Page/AnnotationLayer.css");
  }, []);
  const [totalPages, setTotalPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [showHighlights, setShowHighlights] = useState(true);

  // Measure container width for responsive page sizing
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Track visible page in scroll mode via IntersectionObserver
  const pageObserverRef = useRef<IntersectionObserver | null>(null);
  const visiblePageRef = useRef<number>(1);

  const setupPageObserver = useCallback(() => {
    if (mode !== "scroll" || !containerRef.current) return;
    pageObserverRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the most visible page
        let maxRatio = 0;
        let maxPage = visiblePageRef.current;
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio;
            maxPage = page;
          }
        }
        if (maxPage !== visiblePageRef.current) {
          visiblePageRef.current = maxPage;
          setCurrentPage(maxPage);
          onPageChange?.(maxPage);
        }
      },
      { root: containerRef.current, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    const pages = containerRef.current.querySelectorAll("[data-page-number]");
    pages.forEach((el) => observer.observe(el));
    pageObserverRef.current = observer;

    return () => observer.disconnect();
  }, [mode, onPageChange]);

  // Auto-navigate to the active field's page + scroll to its highlight. This
  // must be self-sufficient: it fires for ANY activeField change — inbound
  // koji:setActiveField, the ?field= param, AND the field picker — so the scroll
  // can't depend on a separate targetPage being set alongside it.
  useEffect(() => {
    if (!activeField || !highlights.length) return;
    const hit = highlights.find((h) => h.field === activeField);
    if (!hit) return;

    if (mode === "paginated") {
      if (hit.page !== currentPage) {
        setCurrentPage(hit.page);
        onPageChange?.(hit.page);
      }
    } else {
      // Scroll mode: bring the field's page into view first so its lazily
      // mounted highlight box exists before we scroll to it.
      const pageEl = containerRef.current?.querySelector(`[data-page-number="${hit.page}"]`);
      pageEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Find the box by attribute comparison (not an interpolated selector) so
    // opaque/special-character field keys can't break the lookup, and retry
    // until the box has mounted (paginated re-render / lazy scroll page).
    let cancelled = false;
    let attempts = 0;
    const scrollToBox = () => {
      if (cancelled) return;
      const boxes = containerRef.current?.querySelectorAll("[data-highlight-field]");
      const el = boxes
        ? Array.from(boxes).find((b) => b.getAttribute("data-highlight-field") === activeField)
        : undefined;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (attempts++ < 20) setTimeout(scrollToBox, 50); // up to ~1s
    };
    const t = setTimeout(scrollToBox, 150);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [activeField]); // eslint-disable-line react-hooks/exhaustive-deps

  // Imperative page navigation (koji:goToPage). The parent passes a target
  // page; clamp it to the document bounds once known and navigate.
  useEffect(() => {
    if (targetPage == null) return;
    const clamped = totalPages > 0 ? Math.min(Math.max(1, targetPage), totalPages) : Math.max(1, targetPage);
    if (mode === "paginated") {
      setCurrentPage((prev) => {
        if (prev !== clamped) onPageChange?.(clamped);
        return clamped;
      });
    } else {
      const el = containerRef.current?.querySelector(`[data-page-number="${clamped}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [targetPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track which highlighted field's box is most prominently in view and report
  // changes (for the embed's outbound koji:visibleField). Reuses the same
  // approach as the page observer but over highlight boxes. A MutationObserver
  // picks up boxes as pages lazily mount/unmount; the IntersectionObserver
  // tracks how much of each box is visible. The "most prominent" field is the
  // single most-visible box. Only runs when a consumer is listening.
  const visibleFieldRef = useRef<string | null>(null);
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !onVisibleFieldChange) return;

    const ratios = new Map<Element, { field: string; ratio: number }>();
    const recompute = () => {
      let bestEl: Element | null = null;
      let bestField: string | null = null;
      let bestRatio = 0;
      for (const [el, { field, ratio }] of ratios) {
        if (!el.isConnected) {
          ratios.delete(el);
          continue;
        }
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestField = field;
          bestEl = el;
        }
      }
      const result = bestRatio > 0 ? bestField : null;
      if (result === visibleFieldRef.current) return;
      visibleFieldRef.current = result;
      let page = currentPageRef.current;
      if (bestEl) {
        const pageEl = bestEl.closest("[data-page-number]") as HTMLElement | null;
        const p = Number(pageEl?.dataset.pageNumber);
        if (p) page = p;
      }
      onVisibleFieldChange(result, page);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const field = (e.target as HTMLElement).dataset.highlightField;
          if (field) ratios.set(e.target, { field, ratio: e.intersectionRatio });
        }
        recompute();
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    const observed = new WeakSet<Element>();
    const observeBoxes = () => {
      root.querySelectorAll("[data-highlight-field]").forEach((el) => {
        if (!observed.has(el)) {
          observed.add(el);
          io.observe(el);
        }
      });
    };
    observeBoxes();
    // Re-observe newly mounted boxes and prune removed ones (lazy pages,
    // paginated page flips, highlight toggling).
    const mo = new MutationObserver(() => {
      observeBoxes();
      recompute();
    });
    mo.observe(root, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      visibleFieldRef.current = null;
    };
  }, [onVisibleFieldChange]);

  // Memoize file object — react-pdf uses === equality check and re-loads
  // the PDF on every render if the object reference changes.
  const file = useMemo(() => ({ url }), [url]);

  const pageHighlights = useMemo(
    () => highlights.filter((h) => h.page === currentPage),
    [highlights, currentPage],
  );

  const allPageNumbers = useMemo(
    () => Array.from({ length: totalPages }, (_, i) => i + 1),
    [totalPages],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar: optional slot (e.g. field picker) + page navigation + highlight toggle */}
      {(totalPages > 1 || highlights.length > 0 || toolbarSlot) && (() => {
        const prevBtn =
          totalPages > 1 && mode === "paginated" ? (
            <button
              onClick={() =>
                setCurrentPage((p) => {
                  const np = Math.max(1, p - 1);
                  if (np !== p) onPageChange?.(np);
                  return np;
                })
              }
              disabled={currentPage <= 1}
              className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-ink-3" />
            </button>
          ) : null;
        const nextBtn =
          totalPages > 1 && mode === "paginated" ? (
            <button
              onClick={() =>
                setCurrentPage((p) => {
                  const np = Math.min(totalPages, p + 1);
                  if (np !== p) onPageChange?.(np);
                  return np;
                })
              }
              disabled={currentPage >= totalPages}
              className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronRight className="w-3.5 h-3.5 text-ink-3" />
            </button>
          ) : null;
        const pageLabel =
          totalPages > 1 ? (
            <span className="font-mono text-[10px] text-ink-4 whitespace-nowrap">
              {currentPage} / {totalPages}
            </span>
          ) : null;
        const highlightToggle =
          highlights.length > 0 ? (
            <button
              onClick={() => setShowHighlights((v) => !v)}
              className={`p-0.5 rounded transition-colors ${showHighlights ? "bg-vermillion-3/30 text-vermillion-2" : "text-ink-4 hover:bg-cream-2"}`}
              title={showHighlights ? "Hide highlights" : "Show highlights"}
            >
              <Highlighter className="w-3.5 h-3.5" />
            </button>
          ) : null;

        // With a toolbar slot (the embed field picker), give the slot the
        // flexible space on the left and pin the page nav + toggle to the
        // right so the slot can never crowd them out. Without a slot, keep the
        // original prev | center | next layout used by the dashboard surfaces.
        return toolbarSlot ? (
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
            <div className="min-w-0 flex-1">{toolbarSlot}</div>
            <div className="flex items-center gap-1 shrink-0">
              {prevBtn}
              {pageLabel}
              {nextBtn}
              {highlightToggle}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
            {prevBtn ?? <span />}
            <div className="flex items-center gap-2">
              {pageLabel}
              {highlightToggle}
            </div>
            {nextBtn ?? <span />}
          </div>
        );
      })()}

      {/* PDF document. Tailwind class names MUST be literal strings — a
          template like `overflow-${overflow}` does not get picked up by the
          JIT compiler, so the generated CSS will be missing the overflow
          rule and the container will not scroll. Use an explicit map. */}
      <div ref={containerRef} className={`flex-1 min-h-0 ${overflowClass[overflow]}`}>
        <ReactPdfDocument
          file={file}
          onLoadSuccess={(pdf) => {
            setTotalPages(pdf.numPages);
            onLoad?.({ pageCount: pdf.numPages });
            // Setup page observer after pages render in scroll mode
            if (mode === "scroll") {
              setTimeout(setupPageObserver, 300);
            }
          }}
          onLoadError={(err) => console.error("[PdfViewer] Load error:", err)}
          loading={
            <div className="flex items-center justify-center h-full">
              <span className="animate-pulse font-mono text-[11px] text-ink-4">Loading PDF...</span>
            </div>
          }
          error={
            <div className="flex items-center justify-center h-full">
              <span className="font-mono text-[11px] text-vermillion-2">Failed to load PDF</span>
            </div>
          }
        >
          {mode === "paginated" ? (
            <ReactPdfPage
              pageNumber={currentPage}
              width={containerWidth}
              renderAnnotationLayer={false}
            >
              {showHighlights && pageHighlights.length > 0 && (
                <HighlightOverlay
                  highlights={pageHighlights}
                  activeField={activeField ?? null}
                  currentPage={currentPage}
                  onFieldClick={onFieldClick}
                  theme={theme}
                />
              )}
              {selection && (selection.active || selection.snapped) && (
                <SelectionLayer page={currentPage} selection={selection} theme={theme} />
              )}
            </ReactPdfPage>
          ) : (
            allPageNumbers.map((pageNum) => (
              <LazyPage
                key={pageNum}
                pageNumber={pageNum}
                width={containerWidth}
                scrollRoot={containerRef.current}
              >
                <ReactPdfPage
                  pageNumber={pageNum}
                  width={containerWidth}
                  renderAnnotationLayer={false}
                >
                  {showHighlights && (
                    <HighlightOverlay
                      highlights={highlights.filter((h) => h.page === pageNum)}
                      activeField={activeField ?? null}
                      currentPage={pageNum}
                      onFieldClick={onFieldClick}
                      theme={theme}
                    />
                  )}
                  {selection && (selection.active || selection.snapped) && (
                    <SelectionLayer page={pageNum} selection={selection} theme={theme} />
                  )}
                </ReactPdfPage>
              </LazyPage>
            ))
          )}
        </ReactPdfDocument>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lazy page wrapper — used in scroll mode to defer page render until the
// row is within (or near) the viewport. Without this, mounting a
// 300-page PDF causes react-pdf to schedule 300 simultaneous renders and
// the dashboard freezes for several seconds. The wrapper claims its
// estimated box up front so scroll positions stay stable as pages
// hydrate, and once a page has been rendered it stays rendered — the
// user can scroll back without re-paying the cost.
// ---------------------------------------------------------------------------

/**
 * Approximate page height assuming US-Letter aspect ratio (11/8.5). Used
 * as a placeholder height before the page has actually been rendered and
 * the browser knows the real box. Wrong for landscape or A3 documents
 * but only matters for the placeholder — the real page replaces it the
 * moment it scrolls into view.
 */
const ESTIMATED_PAGE_ASPECT = 11 / 8.5;

function LazyPage({
  pageNumber,
  width,
  scrollRoot,
  children,
}: {
  pageNumber: number;
  width: number | undefined;
  scrollRoot: HTMLDivElement | null;
  children: React.ReactNode;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  // First page always renders immediately so the document has something
  // to show on initial load; later pages hydrate on scroll.
  const [hasRendered, setHasRendered] = useState(pageNumber === 1);

  useEffect(() => {
    if (hasRendered) return;
    const el = elRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setHasRendered(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setHasRendered(true);
            observer.disconnect();
            return;
          }
        }
      },
      // Mount a couple of viewports ahead/behind so fast scrolling
      // doesn't reveal placeholder boxes.
      { root: scrollRoot, rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRendered, scrollRoot]);

  const placeholderHeight = width ? width * ESTIMATED_PAGE_ASPECT : 800;

  return (
    <div
      ref={elRef}
      data-page-number={pageNumber}
      data-rendered={hasRendered ? "true" : "false"}
      style={hasRendered ? undefined : { minHeight: placeholderHeight }}
    >
      {hasRendered ? (
        children
      ) : (
        <div
          className="flex items-center justify-center text-ink-4 font-mono text-[10px]"
          style={{ height: placeholderHeight }}
        >
          Page {pageNumber}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection layer — rendered as a child of <Page>, above the highlight
// overlay. While armed it captures pointer input (crosshair, marquee drag)
// and reports the released rectangle in normalized page coordinates — the
// exact shape resolve-region accepts. The percentage math is the highlight
// overlay's transform in reverse: page-relative pixels ÷ rendered page size.
// It also renders the host's `snapped` result (the resolved words) as an
// echo highlight, so a sloppy drag visibly snaps to clean word boundaries.
// ---------------------------------------------------------------------------

/**
 * Drags smaller than this many rendered pixels in either dimension are
 * discarded as click noise rather than reported as a selection.
 */
const MIN_DRAG_PX = 4;

function SelectionLayer({
  page,
  selection,
  theme,
}: {
  page: number;
  selection: SelectionConfig;
  theme?: HighlightTheme;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const toPageFraction = (e: React.PointerEvent) => {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  // Escape cancels an in-flight drag without emitting a selection.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);

  const marquee = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  const marqueeColor = theme?.activeColor;
  const snapped = selection.snapped;

  return (
    <div
      ref={layerRef}
      data-selection-layer={page}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 4,
        // While armed the layer owns the pointer (highlight clicks and text
        // selection underneath are intentionally suspended — the user is
        // aiming). When only echoing `snapped`, stay click-through.
        pointerEvents: selection.active ? "auto" : "none",
        cursor: selection.active ? "crosshair" : undefined,
        // Let pointer events drive the drag on touch devices instead of
        // scrolling the page.
        touchAction: selection.active ? "none" : undefined,
      }}
      onPointerDown={(e) => {
        if (!selection.active || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = toPageFraction(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = toPageFraction(e);
        setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
      }}
      onPointerUp={(e) => {
        if (!drag || !marquee) return;
        setDrag(null);
        const rect = layerRef.current!.getBoundingClientRect();
        if (marquee.w * rect.width < MIN_DRAG_PX || marquee.h * rect.height < MIN_DRAG_PX) return;
        selection.onRegionSelected({ page, bbox: marquee });
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {marquee && (
        <div
          data-selection-marquee=""
          className={
            marqueeColor
              ? "absolute rounded-sm pointer-events-none"
              : "absolute rounded-sm pointer-events-none border-2 border-vermillion-2/80 bg-vermillion-3/20"
          }
          style={{
            left: `${marquee.x * 100}%`,
            top: `${marquee.y * 100}%`,
            width: `${marquee.w * 100}%`,
            height: `${marquee.h * 100}%`,
            ...(marqueeColor
              ? { backgroundColor: marqueeColor, boxShadow: `0 0 0 2px ${marqueeColor}` }
              : {}),
          }}
        />
      )}
      {snapped &&
        (snapped.words && snapped.words.length > 0
          ? snapped.words.filter((w) => w.page === page)
          : snapped.page === page && snapped.bbox
            ? [{ ...snapped.bbox, page: snapped.page }]
            : []
        ).map((box, i) => (
          <div
            key={`snap-${i}`}
            data-selection-snapped=""
            className={
              marqueeColor
                ? "absolute rounded-sm pointer-events-none animate-pulse"
                : "absolute rounded-sm pointer-events-none animate-pulse bg-vermillion-3/40 ring-2 ring-vermillion-2/60"
            }
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
              ...(marqueeColor
                ? { backgroundColor: marqueeColor, boxShadow: `0 0 0 2px ${marqueeColor}` }
                : {}),
            }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlight overlay — rendered as a child of <Page>
// ---------------------------------------------------------------------------

function HighlightOverlay({
  highlights,
  activeField,
  currentPage,
  onFieldClick,
  theme,
}: {
  highlights: BBoxHighlight[];
  activeField: string | null;
  currentPage: number;
  onFieldClick?: (field: string, page: number) => void;
  theme?: HighlightTheme;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      {highlights.map((h, i) => {
        const isActive = h.field === activeField;
        // Highlights always carry geometry (they wouldn't be rendered
        // otherwise), so pass hasSource=true — the rung alone decides exact
        // vs. best-guess. A best-guess (fuzzy) box is drawn with a dashed,
        // muted border so it reads as approximate at a glance.
        const confidence = sourceConfidence(h.resolution, true);
        const isApprox = confidence === "approximate";
        const base = "absolute rounded-sm transition-all cursor-pointer";
        const exactActive = "bg-vermillion-3/40 ring-2 ring-vermillion-2/60";
        const exactIdle =
          "bg-cream-3/30 ring-1 ring-ink-4/20 hover:bg-vermillion-3/20 hover:ring-vermillion-2/40";
        const approxActive =
          "bg-vermillion-3/20 border-2 border-dashed border-vermillion-2/70";
        const approxIdle =
          "bg-cream-3/15 border border-dashed border-ink-4/50 hover:bg-vermillion-3/15 hover:border-vermillion-2/50";
        const boxClass = `${base} ${
          isApprox
            ? isActive
              ? approxActive
              : approxIdle
            : isActive
              ? exactActive
              : exactIdle
        }`;
        // Host-supplied theme overrides the default vermillion/cream colors.
        // Inline styles win over the Tailwind utilities above. For a best-guess
        // box, express the theme color as a dashed border so the approximate
        // affordance survives a custom theme; otherwise use the solid ring.
        const themeColor = isActive ? theme?.activeColor : theme?.inactiveColor;
        const themeStyle: React.CSSProperties = themeColor
          ? isApprox
            ? { backgroundColor: themeColor, border: `${isActive ? 2 : 1}px dashed ${themeColor}`, boxShadow: "none" }
            : { backgroundColor: themeColor, boxShadow: `0 0 0 ${isActive ? 2 : 1}px ${themeColor}` }
          : {};

        // Per-word boxes (precise highlights) — use percentage positioning
        if (h.words && h.words.length > 0) {
          return h.words
            .filter((w) => w.page === currentPage)
            .map((w, wi) => (
              <HoverBox
                key={`${h.field}-${i}-w${wi}`}
                className={boxClass}
                style={{
                  left: `${w.x * 100}%`,
                  top: `${w.y * 100}%`,
                  width: `${w.w * 100}%`,
                  height: `${w.h * 100}%`,
                  pointerEvents: "auto",
                  ...themeStyle,
                }}
                field={h.field}
                page={currentPage}
                reasoning={h.reasoning}
                isActive={isActive}
                confidence={confidence}
                onFieldClick={onFieldClick}
              />
            ));
        }

        // Fallback: single enclosing bbox
        if (!h.bbox) return null;
        return (
          <HoverBox
            key={`${h.field}-${i}`}
            className={boxClass}
            style={{
              left: `${h.bbox.x * 100}%`,
              top: `${h.bbox.y * 100}%`,
              width: `${h.bbox.w * 100}%`,
              height: `${h.bbox.h * 100}%`,
              pointerEvents: "auto",
              ...themeStyle,
            }}
            field={h.field}
            page={currentPage}
            reasoning={h.reasoning}
            isActive={isActive}
            confidence={confidence}
            onFieldClick={onFieldClick}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hover box with tooltip
// ---------------------------------------------------------------------------

function HoverBox({
  className,
  style,
  field,
  page,
  reasoning,
  isActive,
  confidence = "exact",
  onFieldClick,
}: {
  className: string;
  style: React.CSSProperties;
  field: string;
  page: number;
  reasoning?: string;
  isActive?: boolean;
  confidence?: SourceConfidence;
  onFieldClick?: (field: string, page: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const isApprox = confidence === "approximate";

  return (
    <div
      ref={boxRef}
      data-highlight-field={field}
      data-highlight-confidence={confidence}
      className={`${className} ${isActive ? "animate-pulse" : ""}`}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onFieldClick ? () => onFieldClick(field, page) : undefined}
    >
      {hovered && (
        <div
          className="absolute z-50 pointer-events-none"
          style={{ bottom: "100%", left: 0, marginBottom: 4 }}
        >
          <div className="bg-ink text-cream rounded-sm px-2.5 py-1.5 shadow-lg max-w-[280px] whitespace-normal">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-mono text-[10px] font-medium text-cream/70 truncate min-w-0">{field}</span>
              {isApprox && (
                <span className="shrink-0 rounded-sm bg-cream/20 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-cream">
                  {SOURCE_CONFIDENCE_LABEL.approximate}
                </span>
              )}
            </div>
            {isApprox && (
              <p className="text-[10px] leading-snug mt-0.5 text-cream/70">
                {SOURCE_CONFIDENCE_DESCRIPTION.approximate}
              </p>
            )}
            {reasoning && (
              <p className="text-[11px] leading-snug mt-0.5">{reasoning}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
