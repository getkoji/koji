"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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

export type EmbedMessage =
  | { type: "koji:setActiveField"; field: string | null }
  | { type: "koji:setHighlights"; highlights: BBoxHighlight[] }
  | { type: "koji:goToPage"; page: number };

interface PdfViewerProps {
  url: string;
  highlights?: BBoxHighlight[];
  activeField?: string | null;
  onPageChange?: (page: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PdfViewer({ url, highlights = [], activeField, onPageChange }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // Load react-pdf CSS client-side
  useEffect(() => {
    import("react-pdf/dist/Page/TextLayer.css");
    import("react-pdf/dist/Page/AnnotationLayer.css");
  }, []);
  const [totalPages, setTotalPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);

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

  // Auto-navigate to highlighted field's page + scroll to highlight
  useEffect(() => {
    if (!activeField || !highlights.length) return;
    const hit = highlights.find((h) => h.field === activeField);
    if (!hit) return;
    if (hit.page !== currentPage) {
      setCurrentPage(hit.page);
      onPageChange?.(hit.page);
    }
    setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-highlight-field="${activeField}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);
  }, [activeField]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageHighlights = useMemo(
    () => highlights.filter((h) => h.page === currentPage),
    [highlights, currentPage],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Page navigation */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-ink-3" />
          </button>
          <span className="font-mono text-[10px] text-ink-4">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="p-0.5 rounded hover:bg-cream-2 disabled:opacity-30 disabled:cursor-default"
          >
            <ChevronRight className="w-3.5 h-3.5 text-ink-3" />
          </button>
        </div>
      )}

      {/* PDF document */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto">
        <ReactPdfDocument
          file={url}
          onLoadSuccess={(pdf) => setTotalPages(pdf.numPages)}
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
          <ReactPdfPage
            pageNumber={currentPage}
            width={containerWidth}
            renderAnnotationLayer={false}
          >
            {/* Bounding box highlights — children of Page share its coordinate space */}
            {pageHighlights.length > 0 && (
              <HighlightOverlay
                highlights={pageHighlights}
                activeField={activeField ?? null}
                currentPage={currentPage}
              />
            )}
          </ReactPdfPage>
        </ReactPdfDocument>
      </div>
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
}: {
  highlights: BBoxHighlight[];
  activeField: string | null;
  currentPage: number;
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
                }}
                field={h.field}
                reasoning={h.reasoning}
                isActive={isActive}
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
            }}
            field={h.field}
            reasoning={h.reasoning}
            isActive={isActive}
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
  reasoning,
  isActive,
}: {
  className: string;
  style: React.CSSProperties;
  field: string;
  reasoning?: string;
  isActive?: boolean;
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
