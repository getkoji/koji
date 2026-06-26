"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { ChevronLeft, ChevronRight, Highlighter } from "lucide-react";
import dynamic from "next/dynamic";

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
  field: string;
  page: number;
  bbox?: { x: number; y: number; w: number; h: number };
  words?: WordBox[];
  reasoning?: string;
}

/** Highlight colors, overridable by the embedding host (query param / koji:setTheme). */
export interface HighlightTheme {
  /** CSS color for the active/selected highlight box. Pass rgba()/hsla() for translucency. */
  activeColor?: string;
  /** CSS color for all other (inactive) highlight boxes. */
  inactiveColor?: string;
}

/** Messages the embed viewer accepts from its parent frame (inbound). */
export type EmbedMessage =
  | { type: "koji:setActiveField"; field: string | null }
  | { type: "koji:setHighlights"; highlights: BBoxHighlight[] }
  | { type: "koji:goToPage"; page: number }
  | { type: "koji:setToken"; token: string }
  | { type: "koji:setTheme"; theme: HighlightTheme };

/** Messages the embed viewer emits to its parent frame (outbound). */
export type EmbedOutboundMessage =
  | { type: "koji:ready"; pageCount: number }
  | { type: "koji:fieldClicked"; field: string; page: number };

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
  /** Highlight colors — overrides the default vermillion/cream styling. */
  theme?: HighlightTheme;
  /** Control scrollbar behavior: "auto" (default, may flash), "scroll" (always visible), "hidden" (no scrollbars) */
  overflow?: "auto" | "scroll" | "hidden";
  /** Display mode: "paginated" shows one page at a time with arrows, "scroll" renders all pages in a scrollable container */
  mode?: "paginated" | "scroll";
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

export function PdfViewer({ url, highlights = [], activeField, onPageChange, targetPage, onFieldClick, onLoad, theme, overflow = "auto", mode = "paginated" }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);

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

  // Auto-navigate to highlighted field's page + scroll to highlight
  useEffect(() => {
    if (!activeField || !highlights.length) return;
    const hit = highlights.find((h) => h.field === activeField);
    if (!hit) return;

    if (mode === "paginated") {
      if (hit.page !== currentPage) {
        setCurrentPage(hit.page);
        onPageChange?.(hit.page);
      }
    }

    setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-highlight-field="${activeField}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);
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
      {/* Toolbar: page navigation + highlight toggle */}
      {(totalPages > 1 || highlights.length > 0) && (
        <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
          {totalPages > 1 && mode === "paginated" ? (
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-ink-3" />
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            {totalPages > 1 && (
              <span className="font-mono text-[10px] text-ink-4">
                {currentPage} / {totalPages}
              </span>
            )}
            {highlights.length > 0 && (
              <button
                onClick={() => setShowHighlights((v) => !v)}
                className={`p-0.5 rounded transition-colors ${showHighlights ? "bg-vermillion-3/30 text-vermillion-2" : "text-ink-4 hover:bg-cream-2"}`}
                title={showHighlights ? "Hide highlights" : "Show highlights"}
              >
                <Highlighter className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {totalPages > 1 && mode === "paginated" ? (
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronRight className="w-3.5 h-3.5 text-ink-3" />
            </button>
          ) : <span />}
        </div>
      )}

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
        const boxClass = `absolute rounded-sm transition-all cursor-pointer ${
          isActive
            ? "bg-vermillion-3/40 ring-2 ring-vermillion-2/60"
            : "bg-cream-3/30 ring-1 ring-ink-4/20 hover:bg-vermillion-3/20 hover:ring-vermillion-2/40"
        }`;
        // Host-supplied theme overrides the default vermillion/cream colors.
        // Inline styles win over the Tailwind utilities above (background +
        // box-shadow ring). Pass rgba()/hsla() for translucent fills.
        const themeColor = isActive ? theme?.activeColor : theme?.inactiveColor;
        const themeStyle: React.CSSProperties = themeColor
          ? { backgroundColor: themeColor, boxShadow: `0 0 0 ${isActive ? 2 : 1}px ${themeColor}` }
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
  onFieldClick,
}: {
  className: string;
  style: React.CSSProperties;
  field: string;
  page: number;
  reasoning?: string;
  isActive?: boolean;
  onFieldClick?: (field: string, page: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={boxRef}
      data-highlight-field={field}
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
            <div className="font-mono text-[10px] font-medium text-cream/70">{field}</div>
            {reasoning && (
              <p className="text-[11px] leading-snug mt-0.5">{reasoning}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
