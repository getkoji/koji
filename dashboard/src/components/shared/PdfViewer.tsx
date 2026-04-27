"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BBoxHighlight {
  field: string;
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [rendering, setRendering] = useState(false);
  const [pdfjsLib, setPdfjsLib] = useState<any>(null);

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

  // Render current page to canvas
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;
    if (rendering) return;
    setRendering(true);

    try {
      const page = await pdfDoc.getPage(currentPage);
      const container = containerRef.current;
      const containerWidth = container.clientWidth;

      // Scale to fit container width
      const unscaledViewport = page.getViewport({ scale: 1 });
      const scale = containerWidth / unscaledViewport.width;
      const viewport = page.getViewport({ scale });

      const canvas = canvasRef.current;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (err) {
      console.warn("[PdfViewer] Render error:", err);
    } finally {
      setRendering(false);
    }
  }, [pdfDoc, currentPage, rendering]);

  useEffect(() => {
    renderPage();
  }, [pdfDoc, currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-navigate to highlighted field's page
  useEffect(() => {
    if (!activeField || !highlights.length) return;
    const hit = highlights.find((h) => h.field === activeField);
    if (hit && hit.page !== currentPage) {
      setCurrentPage(hit.page);
      onPageChange?.(hit.page);
    }
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

      {/* PDF canvas + overlay */}
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-auto">
        <canvas ref={canvasRef} className="w-full" />

        {/* Bounding box overlays */}
        {canvasRef.current && pageHighlights.length > 0 && (
          <div
            className="absolute top-0 left-0 pointer-events-none"
            style={{
              width: canvasRef.current.width,
              height: canvasRef.current.height,
              // Scale the overlay to match the CSS-scaled canvas
              transformOrigin: "top left",
              transform: `scale(${(containerRef.current?.clientWidth ?? canvasRef.current.width) / canvasRef.current.width})`,
            }}
          >
            {pageHighlights.map((h, i) => {
              const isActive = h.field === activeField;
              return (
                <div
                  key={`${h.field}-${i}`}
                  className={`absolute rounded-sm transition-all ${
                    isActive
                      ? "bg-vermillion-3/40 ring-2 ring-vermillion-2/60"
                      : "bg-cream-3/30 ring-1 ring-ink-4/20"
                  }`}
                  style={{
                    left: h.bbox.x * canvasRef.current!.width,
                    top: h.bbox.y * canvasRef.current!.height,
                    width: h.bbox.w * canvasRef.current!.width,
                    height: h.bbox.h * canvasRef.current!.height,
                  }}
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
