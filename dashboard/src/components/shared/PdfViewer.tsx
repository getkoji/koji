"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

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
  /** Per-word bounding boxes for precise highlighting */
  words?: WordBox[];
  /** LLM reasoning for why this value was selected */
  reasoning?: string;
}

/** Messages the embed viewer listens for from a parent frame. */
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const textLayerInstance = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [rendering, setRendering] = useState(false);
  const [pdfjsLib, setPdfjsLib] = useState<any>(null);
  // Store viewport dimensions for the overlay layer
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number; scale: number } | null>(null);

  // Load pdfjs-dist dynamically (client-only)
  useEffect(() => {
    import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.mjs",
        import.meta.url,
      ).toString();
      setPdfjsLib(lib);
    });
  }, []);

  // Load the PDF document
  useEffect(() => {
    if (!pdfjsLib || !url) return;
    let cancelled = false;

    pdfjsLib.getDocument(url).promise.then((doc: any) => {
      if (cancelled) return;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);
    }).catch((err: any) => {
      console.warn("[PdfViewer] Failed to load PDF:", err);
    });

    return () => { cancelled = true; };
  }, [pdfjsLib, url]);

  // Render current page: canvas + text layer
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    if (rendering) return;
    setRendering(true);

    try {
      const page = await pdfDoc.getPage(currentPage);
      const container = containerRef.current;
      const containerWidth = container.clientWidth;

      // Scale to fit container width (same as the original working approach)
      const unscaledViewport = page.getViewport({ scale: 1 });
      const scale = containerWidth / unscaledViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = canvasRef.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Store viewport size for text layer + highlight overlays
      setViewportSize({ w: unscaledViewport.width, h: unscaledViewport.height, scale });

      // Render text layer after state update (next tick so ref is mounted)
      requestAnimationFrame(() => {
        if (!textLayerRef.current) return;
        if (textLayerInstance.current) {
          try { textLayerInstance.current.cancel(); } catch { /* ok */ }
        }
        const textDiv = textLayerRef.current;
        textDiv.innerHTML = "";

        const textViewport = page.getViewport({ scale: 1 });
        textDiv.style.width = `${textViewport.width}px`;
        textDiv.style.height = `${textViewport.height}px`;
        textDiv.style.setProperty("--total-scale-factor", "1");

        page.getTextContent().then(async (textContent: any) => {
          const { TextLayer } = await import("pdfjs-dist");
          const tl = new TextLayer({
            textContentSource: textContent,
            container: textDiv,
            viewport: textViewport,
          });
          await tl.render();
          textLayerInstance.current = tl;
        });
      });
    } catch (err) {
      console.warn("[PdfViewer] Render error:", err);
    } finally {
      setRendering(false);
    }
  }, [pdfDoc, currentPage, rendering]);

  useEffect(() => {
    renderPage();
  }, [pdfDoc, currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-navigate to highlighted field's page + scroll to highlight
  useEffect(() => {
    if (!activeField || !highlights.length) return;
    const hit = highlights.find((h) => h.field === activeField);
    if (!hit) return;
    if (hit.page !== currentPage) {
      setCurrentPage(hit.page);
      onPageChange?.(hit.page);
    }
    // Scroll to the highlight box after a short delay (allow page render)
    setTimeout(() => {
      const el = containerRef.current?.querySelector(`[data-highlight-field="${activeField}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);
  }, [activeField]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter highlights for current page
  const pageHighlights = highlights.filter((h) => h.page === currentPage);

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

      {/* PDF canvas + text layer + highlight overlays */}
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-auto">
        {/*
          The canvas is always in the DOM so renderPage can draw to it.
          After render, viewportSize is set and the scaling wrapper + text
          layer + highlights appear on top. Canvas uses w-full so it fills
          the container; the internal resolution is set by renderPage.
        */}
        <canvas ref={canvasRef} className="w-full" style={{ display: viewportSize ? "block" : "none" }} />

        {/* Text layer — absolutely positioned over canvas */}
        {viewportSize && (
          <div
            ref={textLayerRef}
            className="textLayer"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: viewportSize.w,
              height: viewportSize.h,
              transformOrigin: "top left",
              transform: `scale(${viewportSize.scale})`,
            }}
          />
        )}

        {/* Bounding box highlights — same scale transform as text layer */}
        {viewportSize && pageHighlights.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: viewportSize.w,
              height: viewportSize.h,
              transformOrigin: "top left",
              transform: `scale(${viewportSize.scale})`,
              pointerEvents: "none",
            }}
          >
            {pageHighlights.map((h, i) => {
              const isActive = h.field === activeField;
              const boxClass = `absolute rounded-sm transition-all cursor-pointer ${
                isActive
                  ? "bg-vermillion-3/40 ring-2 ring-vermillion-2/60"
                  : "bg-cream-3/30 ring-1 ring-ink-4/20 hover:bg-vermillion-3/20 hover:ring-vermillion-2/40"
              }`;
              const vw = viewportSize.w;
              const vh = viewportSize.h;

              if (h.words && h.words.length > 0) {
                return h.words
                  .filter((w) => w.page === currentPage)
                  .map((w, wi) => (
                    <HoverBox
                      key={`${h.field}-${i}-w${wi}`}
                      className={boxClass}
                      style={{
                        left: w.x * vw,
                        top: w.y * vh,
                        width: w.w * vw,
                        height: w.h * vh,
                        pointerEvents: "auto",
                      }}
                      field={h.field}
                      reasoning={h.reasoning}
                      isActive={isActive}
                    />
                  ));
              }

              if (!h.bbox) return null;
              return (
                <HoverBox
                  key={`${h.field}-${i}`}
                  className={boxClass}
                  style={{
                    left: h.bbox.x * vw,
                    top: h.bbox.y * vh,
                    width: h.bbox.w * vw,
                    height: h.bbox.h * vh,
                    pointerEvents: "auto",
                  }}
                  field={h.field}
                  reasoning={h.reasoning}
                  isActive={isActive}
                />
              );
            })}
          </div>
        )}

        {/* Loading state */}
        {!pdfDoc && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="animate-pulse font-mono text-[11px] text-ink-4">Loading PDF...</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Highlight box with a styled popover on hover showing field name + reasoning. */
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
