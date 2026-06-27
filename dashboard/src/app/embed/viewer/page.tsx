"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  PdfViewer,
  type BBoxHighlight,
  type EmbedMessage,
  type EmbedOutboundMessage,
  type HighlightTheme,
  type ViewMode,
  type ViewOverflow,
} from "@/components/shared/PdfViewer";

/**
 * Embeddable PDF viewer — a standalone page designed to be iframed by external
 * cross-origin clients as well as used internally.
 *
 * It is cookieless by design: the iframe is cross-origin and runs with
 * third-party cookies blocked, so the page never relies on a session cookie.
 * Document-mode auth is the HMAC `documentToken` passed in the query string;
 * its own static assets (the PDF.js worker, etc.) are served unauthenticated
 * by the middleware so the worker loads without a redirect to /sign-in.
 *
 * Two modes:
 *
 * 1. Document mode: ?job=<slug>&doc=<docId>&token=<hmac>
 *    Fetches PDF URL + provenance highlights from the Koji API.
 *
 * 2. URL mode: ?url=<pdfUrl>&highlights=<base64json>
 *    Client provides everything directly. No API calls.
 *
 * Theming (optional): ?activeColor=<css>&inactiveColor=<css>
 *
 * Layout (optional): ?mode=paginated|scroll&overflow=auto|scroll|hidden
 *   paginated (default) = arrow nav, one page at a time; scroll = all pages
 *   stacked in a scrollable column.
 *
 * Field picker (optional): a dropdown of extracted field → value is shown by
 *   default when highlights exist; selecting one jumps to its highlight. Hide
 *   it with ?fieldPicker=off (e.g. when the host drives selection itself).
 *
 * Outbound origin (optional): ?parentOrigin=<https://host> — the targetOrigin
 * the viewer posts outbound messages to. Falls back to the embedding page's
 * origin (document.referrer). Never posts to "*" unless neither is known.
 *
 * Inbound postMessage (parent → viewer):
 *   { type: "koji:setActiveField", field: "carrier" | null }
 *   { type: "koji:setHighlights", highlights: [...] }
 *   { type: "koji:goToPage", page: 3 }
 *   { type: "koji:setToken", token: "<fresh documentToken>" }   // refresh w/o iframe reload
 *   { type: "koji:setTheme", theme: { activeColor, inactiveColor } }
 *   { type: "koji:setViewMode", mode: "scroll", overflow: "auto" }  // both optional
 *
 * Outbound postMessage (viewer → parent), posted to parentOrigin (never "*"):
 *   { type: "koji:ready", pageCount: 5 }                          // PDF loaded, controllable
 *   { type: "koji:fieldClicked", field: "carrier", page: 2 }     // user clicked a highlight
 *   { type: "koji:pageChanged", page: 3 }                        // most-visible page changed
 *   { type: "koji:visibleField", field: "carrier" | null, page: 3 }  // most-visible field changed
 *
 * The koji:pageChanged / koji:visibleField events fire on scroll (mode=scroll)
 * and on page navigation (mode=paginated), for both user and programmatic
 * scroll. They are debounced (~120ms) and deduped (only on actual change), and
 * only emit after koji:ready.
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

/** Replace (or add) the `token` query param on a same-origin preview URL. */
function swapToken(url: string, token: string): string {
  try {
    // Preview URLs are app-relative (e.g. /api/jobs/.../preview?token=...).
    // Resolve against a dummy base so URL() can parse, then strip it back off.
    const base = "http://embed.local";
    const u = new URL(url, base);
    u.searchParams.set("token", token);
    const out = u.toString();
    return out.startsWith(base) ? out.slice(base.length) : out;
  } catch {
    return url;
  }
}

const VIEW_MODES: readonly ViewMode[] = ["paginated", "scroll"];
const VIEW_OVERFLOWS: readonly ViewOverflow[] = ["auto", "scroll", "hidden"];

/** Narrow an untrusted string to a ViewMode, or undefined if not a valid one. */
function asViewMode(v: string | null | undefined): ViewMode | undefined {
  return v && (VIEW_MODES as readonly string[]).includes(v) ? (v as ViewMode) : undefined;
}
/** Narrow an untrusted string to a ViewOverflow, or undefined if not a valid one. */
function asViewOverflow(v: string | null | undefined): ViewOverflow | undefined {
  return v && (VIEW_OVERFLOWS as readonly string[]).includes(v) ? (v as ViewOverflow) : undefined;
}

function EmbedViewerInner() {
  const searchParams = useSearchParams();
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<BBoxHighlight[]>([]);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [targetPage, setTargetPage] = useState<number | null>(null);
  const [theme, setTheme] = useState<HighlightTheme | undefined>(undefined);
  // Scroll/pagination config — host-controlled via ?mode / ?overflow query
  // params (validated; unknown values fall back to the defaults) and the
  // koji:setViewMode message. Defaults match the dashboard reviewer surface.
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => asViewMode(searchParams.get("mode")) ?? "paginated",
  );
  const [overflow, setOverflow] = useState<ViewOverflow>(
    () => asViewOverflow(searchParams.get("overflow")) ?? "auto",
  );
  // The built-in field/value picker is shown by default; hosts that drive
  // selection from their own UI can hide it with ?fieldPicker=off.
  const showFieldPicker = useMemo(() => {
    const v = searchParams.get("fieldPicker");
    return v !== "off" && v !== "0" && v !== "false";
  }, [searchParams]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // targetOrigin for outbound messages. Prefer an explicit ?parentOrigin=,
  // then the embedding page's origin (document.referrer). Posting to "*" leaks
  // messages to any parent, so we only fall back to it when nothing else is
  // known, and warn.
  const parentOrigin = useMemo(() => {
    const explicit = searchParams.get("parentOrigin") || searchParams.get("targetOrigin");
    if (explicit) return explicit;
    if (typeof document !== "undefined" && document.referrer) {
      try {
        return new URL(document.referrer).origin;
      } catch {
        /* ignore malformed referrer */
      }
    }
    return null;
  }, [searchParams]);

  const postToParent = useCallback(
    (message: EmbedOutboundMessage) => {
      if (typeof window === "undefined" || window.parent === window) return;
      const target = parentOrigin ?? "*";
      if (target === "*") {
        console.warn(
          "[embed] No parentOrigin/targetOrigin known — posting to '*'. Pass ?parentOrigin=https://your-app to restrict.",
        );
      }
      window.parent.postMessage(message, target);
    },
    [parentOrigin],
  );

  // Select a field: mark it active (drives the highlight pulse + scroll) and
  // navigate to its page so it lands in view in both paginated and scroll
  // layouts. Used by the built-in field picker.
  const selectField = useCallback(
    (field: string | null) => {
      setActiveField(field);
      if (!field) return;
      const hit = highlights.find((h) => h.field === field);
      if (hit) setTargetPage(hit.page);
    },
    [highlights],
  );

  // Outbound scroll-position events (koji:pageChanged / koji:visibleField).
  // The parent can't observe our scroll across the origin boundary, so we
  // broadcast the page + most-visible field the viewer already tracks.
  // Rules: only after koji:ready, only on actual change (deduped), debounced
  // (~120ms) so fast scrolling can't flood the channel, and — honoring the
  // never-"*" rule — skipped entirely when no parentOrigin is known. Both
  // user scroll and programmatic navigation (koji:goToPage / koji:setActiveField)
  // emit; the dedupe makes that safe for the parent.
  const hasReadyRef = useRef(false);
  const lastPageRef = useRef<number>(1);
  const lastVisibleFieldRef = useRef<string | null | undefined>(undefined);
  const pageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePageChange = useCallback(
    (page: number) => {
      if (pageTimerRef.current) clearTimeout(pageTimerRef.current);
      pageTimerRef.current = setTimeout(() => {
        if (!hasReadyRef.current || !parentOrigin) return;
        if (page === lastPageRef.current) return;
        lastPageRef.current = page;
        postToParent({ type: "koji:pageChanged", page });
      }, 120);
    },
    [parentOrigin, postToParent],
  );

  const handleVisibleFieldChange = useCallback(
    (field: string | null, page: number) => {
      if (fieldTimerRef.current) clearTimeout(fieldTimerRef.current);
      fieldTimerRef.current = setTimeout(() => {
        if (!hasReadyRef.current || !parentOrigin) return;
        if (field === lastVisibleFieldRef.current) return;
        lastVisibleFieldRef.current = field;
        postToParent({ type: "koji:visibleField", field, page });
      }, 120);
    },
    [parentOrigin, postToParent],
  );

  useEffect(
    () => () => {
      if (pageTimerRef.current) clearTimeout(pageTimerRef.current);
      if (fieldTimerRef.current) clearTimeout(fieldTimerRef.current);
    },
    [],
  );

  // Parse query params and load data
  useEffect(() => {
    const url = searchParams.get("url");
    const job = searchParams.get("job");
    const doc = searchParams.get("doc");
    const token = searchParams.get("token");
    const highlightsParam = searchParams.get("highlights");
    const fieldParam = searchParams.get("field");
    const activeColor = searchParams.get("activeColor");
    const inactiveColor = searchParams.get("inactiveColor");

    if (fieldParam) setActiveField(fieldParam);
    if (activeColor || inactiveColor) {
      setTheme({
        activeColor: activeColor ?? undefined,
        inactiveColor: inactiveColor ?? undefined,
      });
    }

    // URL mode — client provides everything
    if (url) {
      setPdfUrl(url);
      if (highlightsParam) {
        try {
          // UTF-8-safe base64 decode: atob() yields a binary string, so reading
          // it back through TextDecoder restores multi-byte chars (labels /
          // values like "Coverage — Crime" or accented names). For pure-ASCII
          // payloads this is identical to JSON.parse(atob(...)).
          const bytes = Uint8Array.from(atob(highlightsParam), (c) => c.charCodeAt(0));
          const decoded = JSON.parse(new TextDecoder().decode(bytes));
          setHighlights(decoded);
        } catch {
          console.warn("[embed] Invalid highlights param");
        }
      }
      setLoading(false);
      return;
    }

    // Document mode — fetch from API. Raw fetch (not the shared api client) is
    // deliberate: the embed is cookieless and must NOT depend on a session;
    // auth is the HMAC token in the query string.
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
          setTargetPage(msg.page);
          break;
        case "koji:setToken":
          // Refresh the document token without reloading the iframe. We swap
          // the token on the preview URL so subsequent (range) fetches stay
          // authorized through a long review session. The PdfViewer component
          // stays mounted, so the current page and selection are preserved.
          setPdfUrl((prev) => (prev ? swapToken(prev, msg.token) : prev));
          break;
        case "koji:setTheme":
          setTheme(msg.theme);
          break;
        case "koji:setViewMode":
          // Either field is optional; ignore unknown values so a bad message
          // can't wedge the viewer into an invalid layout.
          if (asViewMode(msg.mode)) setViewMode(msg.mode!);
          if (asViewOverflow(msg.overflow)) setOverflow(msg.overflow!);
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

  // The field picker lives inside the viewer toolbar (passed as toolbarSlot)
  // rather than floating over the document, so it can't cover the page or the
  // nav controls. It takes the toolbar's flexible left space and truncates.
  const fieldPicker =
    showFieldPicker && highlights.length > 0 ? (
      <select
        aria-label="Jump to extracted field"
        value={activeField ?? ""}
        onChange={(e) => selectField(e.target.value || null)}
        className="w-full max-w-full truncate rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-400"
      >
        <option value="">Jump to field…</option>
        {highlights.map((h) => {
          // The option's value is the stable match key (field); the visible
          // text prefers an explicit label so opaque keys (record ids) don't
          // leak into the UI.
          const display = h.label ?? h.field;
          return (
            <option key={h.field} value={h.field}>
              {h.value ? `${display}: ${h.value}` : display}
            </option>
          );
        })}
      </select>
    ) : undefined;

  return (
    <div className="h-screen w-screen bg-white">
      <PdfViewer
        url={pdfUrl}
        highlights={highlights}
        activeField={activeField}
        targetPage={targetPage}
        theme={theme}
        mode={viewMode}
        overflow={overflow}
        toolbarSlot={fieldPicker}
        onPageChange={handlePageChange}
        onVisibleFieldChange={handleVisibleFieldChange}
        onLoad={({ pageCount }) => {
          hasReadyRef.current = true;
          postToParent({ type: "koji:ready", pageCount });
        }}
        onFieldClick={(field, page) => {
          setActiveField(field);
          postToParent({ type: "koji:fieldClicked", field, page });
        }}
      />
    </div>
  );
}
