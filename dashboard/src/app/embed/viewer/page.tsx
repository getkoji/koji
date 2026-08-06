"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  PdfViewer,
  type BBoxHighlight,
  type EmbedMessage,
  type EmbedOutboundMessage,
  type HighlightTheme,
  type PdfViewerHandle,
  type RegionSelection,
  type ViewMode,
  type ViewOverflow,
  type WordBox,
} from "@/components/shared/PdfViewer";
import {
  clampZoom,
  FIT_ZOOM,
  isRotation,
  parseToolsParam,
  stepRotation,
  stepZoom,
  type Rotation,
  type ViewerToolName,
} from "@/lib/pdf-tools";
import { usePageTitle } from "@/lib/use-page-title";

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
 * Tools (optional): ?tools=select,zoom,search,rotate,download,print,fullscreen
 *   — a comma-separated list, all OFF by default (?tools=all turns on every
 *   one). Each name adds its control to the toolbar AND unlocks the matching
 *   inbound messages; unknown names are ignored so an embed URL written for a
 *   newer viewer still works. The tools:
 *
 *   - select     region selection (highlight-to-correct): a crosshair toolbar
 *                toggle appears, the host can arm/disarm it via
 *                koji:setSelectionMode, and a completed drag emits
 *                koji:regionSelected. In Document mode the viewer resolves the
 *                region to the text underneath via POST .../resolve-region
 *                (same HMAC token) before emitting; in URL mode it emits the
 *                raw rectangle with text: null.
 *   - zoom       − / % / + controls plus Ctrl/Cmd+wheel (and trackpad pinch).
 *                100% is fit-to-width. koji:setZoom drives it.
 *   - search     find-in-document across ALL pages (the browser's own find
 *                only sees rendered ones), with match highlighting and
 *                prev/next. Cmd/Ctrl+F opens it. koji:search drives it.
 *   - rotate     90° clockwise per click. Highlights and region selection
 *                rotate with the page. koji:setRotation drives it.
 *   - download   saves the original PDF (uses the document's filename).
 *   - print      prints the original PDF, not the rendered canvases.
 *   - fullscreen expands the viewer. Pass allow="fullscreen" on the iframe —
 *                without it a cross-origin host blocks the request and the
 *                button hides itself.
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
 *   { type: "koji:setSelectionMode", field: "carrier" | null }  // arm/disarm region select (?tools=select)
 *   { type: "koji:setZoom", zoom: 1.5 | "in" | "out" | "fit" }  // (?tools=zoom)
 *   { type: "koji:setRotation", rotation: 90 | "cw" | "ccw" }   // (?tools=rotate)
 *   { type: "koji:search", query: "policy number" | null }      // (?tools=search)
 *   { type: "koji:searchNext" } / { type: "koji:searchPrev" }   // (?tools=search)
 *
 * Outbound postMessage (viewer → parent), posted to parentOrigin (never "*"):
 *   { type: "koji:ready", pageCount: 5 }                          // PDF loaded, controllable
 *   { type: "koji:fieldClicked", field: "carrier", page: 2 }     // user clicked a highlight
 *   { type: "koji:pageChanged", page: 3 }                        // most-visible page changed
 *   { type: "koji:visibleField", field: "carrier" | null, page: 3 }  // most-visible field changed
 *   { type: "koji:regionSelected", field, page, bbox, text, words }  // region picked + resolved (?tools=select)
 *   { type: "koji:zoomChanged", zoom: 1.5 }                      // (?tools=zoom)
 *   { type: "koji:rotationChanged", rotation: 90 }               // (?tools=rotate)
 *   { type: "koji:searchResults", query, total, activeIndex, page }  // (?tools=search)
 *
 * The tool echoes fire for host-driven changes as well as user-driven ones
 * (deduped on value), so a parent mirroring the controls in its own chrome
 * stays in sync either way.
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
  usePageTitle("Document Viewer");
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
  // Optional tools are all OFF unless listed in ?tools= (comma-separated).
  // Unknown names are ignored so a future tool name doesn't break old embeds.
  const tools = useMemo(() => parseToolsParam(searchParams.get("tools")), [searchParams]);
  const selectToolEnabled = !!tools.select;
  // Region-selection state (?tools=select). `field` is what the host armed
  // selection for via koji:setSelectionMode (null when the built-in toolbar
  // toggle armed it); it is echoed back on koji:regionSelected.
  const [selectState, setSelectState] = useState<{ armed: boolean; field: string | null }>({
    armed: false,
    field: null,
  });
  const [snapped, setSnapped] = useState<BBoxHighlight | null>(null);
  // Tool state the host can both drive and observe. The viewer renders the
  // controls; this page owns the values so koji:setZoom / koji:setRotation /
  // koji:search and the toolbar buttons converge on the same state.
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  // Search next/prev are events, not state — they go through the viewer's
  // imperative handle rather than a prop.
  const viewerRef = useRef<PdfViewerHandle>(null);
  // Document-mode context for resolve-region calls. Mirrors the query params;
  // koji:setToken refreshes the token here too so resolution keeps working
  // through long review sessions.
  const [docCtx, setDocCtx] = useState<{ job: string; doc: string; token: string | null } | null>(
    null,
  );
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

  // Select a field: just mark it active. PdfViewer's activeField effect handles
  // navigating to its page + scrolling to the box, so the field picker and an
  // inbound koji:setActiveField behave identically (no separate targetPage).
  const selectField = useCallback((field: string | null) => {
    setActiveField(field);
  }, []);

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

  // Tool-state echoes. Emitting from an effect (rather than from each button's
  // handler) is what makes host-driven changes echo too — koji:setZoom and a
  // click on the − button land in the same state and produce the same message.
  // Seeded with the defaults so a fresh mount doesn't announce a no-op.
  const lastZoomRef = useRef(FIT_ZOOM);
  useEffect(() => {
    if (lastZoomRef.current === zoom) return;
    lastZoomRef.current = zoom;
    postToParent({ type: "koji:zoomChanged", zoom });
  }, [zoom, postToParent]);

  const lastRotationRef = useRef<Rotation>(0);
  useEffect(() => {
    if (lastRotationRef.current === rotation) return;
    lastRotationRef.current = rotation;
    postToParent({ type: "koji:rotationChanged", rotation });
  }, [rotation, postToParent]);

  // Search results. Unlike zoom/rotation these fire while the user types, so
  // they're held until the document is ready and skipped entirely until a
  // search has actually happened (an empty query on mount is not news).
  const searchedRef = useRef(false);
  const handleSearchResults = useCallback(
    (results: { query: string; total: number; activeIndex: number; page: number | null }) => {
      if (!hasReadyRef.current) return;
      if (!results.query && !searchedRef.current) return;
      searchedRef.current = !!results.query;
      postToParent({ type: "koji:searchResults", ...results });
    },
    [postToParent],
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
      // No embed-data to read a name from; let the host name the download.
      setFilename(searchParams.get("filename"));
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
      setDocCtx({ job, doc, token });
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      fetch(`/api/jobs/${job}/documents/${doc}/embed-data${qs}`)
        .then((r) => {
          if (!r.ok) throw new Error(`API returned ${r.status}`);
          return r.json();
        })
        .then((data: { previewUrl: string; highlights: BBoxHighlight[]; filename: string }) => {
          setPdfUrl(data.previewUrl);
          setHighlights(data.highlights ?? []);
          // Kept for the download tool — the preview path is opaque, so this
          // is the only place the real filename comes from.
          setFilename(data.filename ?? null);
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
    /**
     * Tool-gated messages follow koji:setSelectionMode's precedent: a message
     * for a tool this embed didn't opt into is ignored with a console warning
     * rather than silently applied, so `?tools=` stays the single switch for
     * what an embed can do.
     */
    function toolEnabled(tool: ViewerToolName, type: string): boolean {
      if (tools[tool]) return true;
      console.warn(`[embed] ${type} ignored — enable the tool with ?tools=${tool}`);
      return false;
    }

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
          setDocCtx((prev) => (prev ? { ...prev, token: msg.token } : prev));
          break;
        case "koji:setSelectionMode":
          if (!selectToolEnabled) {
            console.warn(
              "[embed] koji:setSelectionMode ignored — enable the tool with ?tools=select",
            );
            break;
          }
          if (msg.field === null) {
            setSelectState({ armed: false, field: null });
            setSnapped(null);
          } else {
            setSelectState({ armed: true, field: msg.field });
            setSnapped(null);
          }
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
        case "koji:setZoom": {
          if (!toolEnabled("zoom", msg.type)) break;
          const z = msg.zoom;
          setZoom((prev) =>
            z === "in" || z === "out"
              ? stepZoom(prev, z)
              : z === "fit"
                ? FIT_ZOOM
                : clampZoom(Number(z)),
          );
          break;
        }
        case "koji:setRotation": {
          if (!toolEnabled("rotate", msg.type)) break;
          const r = msg.rotation;
          if (r === "cw" || r === "ccw") {
            setRotation((prev) => stepRotation(prev, r));
          } else if (isRotation(r)) {
            setRotation(r);
          } else {
            console.warn("[embed] koji:setRotation ignored — expected 0/90/180/270, 'cw' or 'ccw'");
          }
          break;
        }
        case "koji:search":
          if (!toolEnabled("search", msg.type)) break;
          setSearchQuery(msg.query);
          break;
        case "koji:searchNext":
          if (!toolEnabled("search", msg.type)) break;
          viewerRef.current?.searchNext();
          break;
        case "koji:searchPrev":
          if (!toolEnabled("search", msg.type)) break;
          viewerRef.current?.searchPrev();
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [selectToolEnabled, tools]);

  // A completed selection drag: resolve the region to the text underneath
  // (Document mode — raw fetch with the HMAC token, same cookieless posture
  // as embed-data), echo the snapped words on the page, and emit
  // koji:regionSelected. URL mode has no document to resolve against, so the
  // raw rectangle is emitted with text: null for the host to handle.
  const handleRegionSelected = useCallback(
    async (region: RegionSelection) => {
      let text: string | null = null;
      let words: WordBox[] = [];
      let bbox = region.bbox;
      if (docCtx) {
        try {
          const qs = docCtx.token ? `?token=${encodeURIComponent(docCtx.token)}` : "";
          const r = await fetch(
            `/api/jobs/${docCtx.job}/documents/${docCtx.doc}/resolve-region${qs}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(region),
            },
          );
          if (r.ok) {
            const data = (await r.json()) as {
              text: string | null;
              words: WordBox[];
              bbox: { x: number; y: number; w: number; h: number } | null;
            };
            if (data.text != null) {
              text = data.text;
              words = data.words ?? [];
              bbox = data.bbox ?? region.bbox;
            }
          }
        } catch {
          // Resolution failed (network, expired token) — emit text: null so
          // the host falls back to manual input rather than hanging.
        }
      }
      setSnapped(
        text != null
          ? { field: selectState.field ?? "__selection", page: region.page, bbox, words }
          : null,
      );
      postToParent({
        type: "koji:regionSelected",
        field: selectState.field,
        page: region.page,
        bbox,
        text,
        words,
      });
    },
    [docCtx, selectState.field, postToParent],
  );

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

  // The self-serve crosshair lives in the viewer's tool group with the rest of
  // the tools (it used to sit beside the field picker, which split the toolbar
  // in two once zoom/search/rotate arrived). Hosts that drive selection via
  // koji:setSelectionMode keep working — both paths write the same state.
  const toolbarSlot = fieldPicker ? (
    <div className="flex min-w-0 items-center gap-1.5">{fieldPicker}</div>
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
        toolbarSlot={toolbarSlot}
        tools={tools}
        filename={filename}
        controlRef={viewerRef}
        zoom={zoom}
        onZoomChange={setZoom}
        rotation={rotation}
        onRotationChange={setRotation}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearchResults={handleSearchResults}
        selection={
          selectToolEnabled
            ? {
                active: selectState.armed,
                onRegionSelected: handleRegionSelected,
                snapped,
                onToggleActive: () => {
                  setSnapped(null);
                  setSelectState((s) => ({ armed: !s.armed, field: s.armed ? null : s.field }));
                },
              }
            : undefined
        }
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
