"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PdfViewer, type BBoxHighlight, type EmbedMessage } from "@/components/shared/PdfViewer";

/**
 * Embeddable PDF viewer — serves as a standalone page that can be iframed
 * by external clients (Superkey, etc.) or used internally in the dashboard.
 *
 * Two modes:
 *
 * 1. Document mode: ?job=<slug>&doc=<docId>&token=<hmac>
 *    Fetches PDF URL + provenance highlights from the Koji API.
 *
 * 2. URL mode: ?url=<pdfUrl>&highlights=<base64json>
 *    Client provides everything directly. No API calls.
 *
 * Supports postMessage from parent frame:
 *   { type: "koji:setActiveField", field: "carrier" }
 *   { type: "koji:setHighlights", highlights: [...] }
 *   { type: "koji:goToPage", page: 3 }
 */
export default function EmbedViewerPage() {
  return (
    <Suspense fallback={
      <div className="h-screen flex items-center justify-center bg-white">
        <span className="animate-pulse font-mono text-[12px] text-neutral-400">Loading viewer...</span>
      </div>
    }>
      <EmbedViewerInner />
    </Suspense>
  );
}

function EmbedViewerInner() {
  const searchParams = useSearchParams();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<BBoxHighlight[]>([]);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Parse query params and load data
  useEffect(() => {
    const url = searchParams.get("url");
    const job = searchParams.get("job");
    const doc = searchParams.get("doc");
    const token = searchParams.get("token");
    const highlightsParam = searchParams.get("highlights");
    const fieldParam = searchParams.get("field");

    if (fieldParam) setActiveField(fieldParam);

    // URL mode — client provides everything
    if (url) {
      setPdfUrl(url);
      if (highlightsParam) {
        try {
          const decoded = JSON.parse(atob(highlightsParam));
          setHighlights(decoded);
        } catch {
          console.warn("[embed] Invalid highlights param");
        }
      }
      setLoading(false);
      return;
    }

    // Document mode — fetch from API
    if (job && doc) {
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      fetch(`/api/jobs/${job}/documents/${doc}/embed-data${qs}`)
        .then((r) => {
          if (!r.ok) throw new Error(`API returned ${r.status}`);
          return r.json();
        })
        .then((data: { previewUrl: string; highlights: BBoxHighlight[]; filename: string }) => {
          setPdfUrl(data.previewUrl);
          setHighlights(data.highlights ?? []);
        })
        .catch((err) => {
          setError(err.message);
        })
        .finally(() => setLoading(false));
      return;
    }

    setError("Missing required params: provide ?url=... or ?job=...&doc=...&token=...");
    setLoading(false);
  }, [searchParams]);

  // Listen for postMessage from parent frame
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const msg = e.data as EmbedMessage;
      if (!msg?.type?.startsWith("koji:")) return;

      switch (msg.type) {
        case "koji:setActiveField":
          setActiveField(msg.field);
          break;
        case "koji:setHighlights":
          setHighlights(msg.highlights);
          break;
        case "koji:goToPage":
          // PdfViewer handles this via activeField → page navigation
          // For direct page control, we'd need to expose a ref
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-white">
        <span className="animate-pulse font-mono text-[12px] text-neutral-400">Loading viewer...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-white">
        <span className="font-mono text-[12px] text-red-500">{error}</span>
      </div>
    );
  }

  if (!pdfUrl) {
    return (
      <div className="h-screen flex items-center justify-center bg-white">
        <span className="font-mono text-[12px] text-neutral-400">No document to display</span>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-white">
      <PdfViewer
        url={pdfUrl}
        highlights={highlights}
        activeField={activeField}
      />
    </div>
  );
}
