"use client";

import { useEffect, useImperativeHandle, useRef, useState, useMemo, useCallback } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Download,
  Highlighter,
  Maximize2,
  Minimize2,
  Printer,
  RotateCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  sourceConfidence,
  type ResolutionRung,
  type SourceConfidence,
  SOURCE_CONFIDENCE_LABEL,
  SOURCE_CONFIDENCE_DESCRIPTION,
} from "@/lib/provenance-resolution";
import {
  clampZoom,
  collectHits,
  downloadFilename,
  FIT_ZOOM,
  findMatches,
  formatZoom,
  MAX_ZOOM,
  MIN_SEARCH_QUERY,
  MIN_ZOOM,
  rotateBox,
  stepRotation,
  stepZoom,
  unrotateBox,
  wrapIndex,
  type NormBox,
  type Rotation,
  type SearchHit,
  type ViewerTools,
} from "@/lib/pdf-tools";

export type { Rotation, ViewerTools } from "@/lib/pdf-tools";

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
  /**
   * Arm/disarm from the toolbar. Supply it (with `tools.select`) and the
   * viewer renders the crosshair toggle alongside the other tools; leave it
   * out and selection is host-driven only.
   */
  onToggleActive?: () => void;
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
  | { type: "koji:setViewMode"; mode?: ViewMode; overflow?: ViewOverflow }
  // Arm region selection on behalf of a field (requires ?tools=select on the
  // embed URL); `field: null` disarms and clears the snapped echo.
  | { type: "koji:setSelectionMode"; field: string | null }
  // Tool control. Each requires the matching tool on the embed URL
  // (?tools=zoom / rotate / search) and is ignored (with a console warning)
  // otherwise, exactly like koji:setSelectionMode.
  | { type: "koji:setZoom"; zoom: number | "in" | "out" | "fit" }
  | { type: "koji:setRotation"; rotation: Rotation | "cw" | "ccw" }
  | { type: "koji:search"; query: string | null }
  | { type: "koji:searchNext" }
  | { type: "koji:searchPrev" };

/** Messages the embed viewer emits to its parent frame (outbound). */
export type EmbedOutboundMessage =
  | { type: "koji:ready"; pageCount: number }
  | { type: "koji:fieldClicked"; field: string; page: number }
  | { type: "koji:pageChanged"; page: number }
  | { type: "koji:visibleField"; field: string | null; page: number }
  // The user selected a region (?tools=select). In Document mode the viewer
  // has already resolved the region to the text underneath (resolve-region):
  // `text` is null when nothing was there — treat that as "fall back to
  // manual input". `field` echoes the koji:setSelectionMode field (null when
  // the built-in toolbar toggle armed the selection). In URL mode there is
  // no document to resolve against: text is null, words is empty, and bbox
  // is the raw drag rectangle for the host to resolve itself.
  | {
      type: "koji:regionSelected";
      field: string | null;
      page: number;
      bbox: { x: number; y: number; w: number; h: number };
      text: string | null;
      words: WordBox[];
    }
  // Tool state echoes — emitted for user-driven changes as well as for the
  // host's own koji:setZoom / koji:setRotation / koji:search, so a parent that
  // mirrors the controls in its own chrome stays in sync either way.
  | { type: "koji:zoomChanged"; zoom: number }
  | { type: "koji:rotationChanged"; rotation: Rotation }
  | {
      type: "koji:searchResults";
      query: string;
      /**
       * Total hits in the document, or 0 when nothing matched. Never a
       * transient 0 — the message waits for the scan to finish.
       */
      total: number;
      /** 0-based index of the focused hit, or -1 when there are none. */
      activeIndex: number;
      /** Page of the focused hit, or null when there are none. */
      page: number | null;
    };

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
  /**
   * Which optional tools to expose in the toolbar. All off by default — an
   * embed opts in with `?tools=zoom,search`, and internal dashboard surfaces
   * keep the minimal toolbar unless they ask for more.
   */
  tools?: ViewerTools;
  /** Original filename, used when the download tool saves the file. */
  filename?: string | null;
  /**
   * Zoom multiplier over fit-to-width. Controlled-optional: pass it (with
   * `onZoomChange`) to own the state, or leave it out and the viewer keeps its
   * own. Same pattern for `rotation` and `searchQuery`.
   */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  rotation?: Rotation;
  onRotationChange?: (rotation: Rotation) => void;
  searchQuery?: string | null;
  onSearchQueryChange?: (query: string | null) => void;
  /** Fired whenever the hit list or the focused hit changes. */
  onSearchResults?: (results: {
    query: string;
    total: number;
    activeIndex: number;
    page: number | null;
  }) => void;
  /** Imperative handle for host-driven search navigation (koji:searchNext/Prev). */
  controlRef?: React.Ref<PdfViewerHandle>;
}

/** Imperative surface for things that are events, not state. */
export interface PdfViewerHandle {
  searchNext: () => void;
  searchPrev: () => void;
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

export function PdfViewer({ url, highlights = [], activeField, onPageChange, targetPage, onFieldClick, onLoad, onVisibleFieldChange, theme, overflow = "auto", mode = "paginated", toolbarSlot, selection, tools = {}, filename, zoom: zoomProp, onZoomChange, rotation: rotationProp, onRotationChange, searchQuery: searchQueryProp, onSearchQueryChange, onSearchResults, controlRef }: PdfViewerProps) {
  // The fullscreen target — the whole viewer including its toolbar, so the
  // controls come along instead of leaving a bare page on a black backdrop.
  const rootRef = useRef<HTMLDivElement>(null);
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

  // -------------------------------------------------------------------------
  // Zoom + rotation
  //
  // Both are controlled-optional: pass the value (with its onChange) to own
  // the state from outside — which is how the embed page drives them from
  // koji:setZoom / koji:setRotation and echoes the result back to its host —
  // or omit it and the viewer keeps its own.
  // -------------------------------------------------------------------------
  const [internalZoom, setInternalZoom] = useState(FIT_ZOOM);
  const zoom = clampZoom(zoomProp ?? internalZoom);
  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clampZoom(next);
      if (zoomProp === undefined) setInternalZoom(clamped);
      onZoomChange?.(clamped);
    },
    [zoomProp, onZoomChange],
  );

  const [internalRotation, setInternalRotation] = useState<Rotation>(0);
  const rotation = rotationProp ?? internalRotation;
  const applyRotation = useCallback(
    (next: Rotation) => {
      if (rotationProp === undefined) setInternalRotation(next);
      onRotationChange?.(next);
    },
    [rotationProp, onRotationChange],
  );

  // The rendered page width. Zoom is a multiplier over fit-to-width, so 100%
  // keeps the historical behavior (page exactly fills the container) and
  // anything above it overflows into the container's horizontal scroll.
  const pageWidth = containerWidth ? Math.max(1, containerWidth * zoom) : undefined;

  // Mirror zoom for the (mount-once) wheel handler below.
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Ctrl/Cmd + wheel (and trackpad pinch, which browsers report the same way)
  // zooms instead of scrolling. Registered natively because the listener has
  // to be non-passive to preventDefault the browser's own page zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !tools.zoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoom(stepZoom(zoomRef.current, e.deltaY < 0 ? "in" : "out"));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [tools.zoom, applyZoom]);

  // -------------------------------------------------------------------------
  // Fullscreen
  // -------------------------------------------------------------------------
  const [isFullscreen, setIsFullscreen] = useState(false);
  // `document.fullscreenEnabled` reports whether this document is *permitted*
  // to go fullscreen — false in a cross-origin iframe whose host didn't pass
  // allow="fullscreen". Hide the button in that case rather than ship a
  // control that does nothing. (Chromium reports true for a same-origin
  // iframe with no `allow` attribute, and fullscreen does work there.)
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  useEffect(() => {
    setFullscreenAvailable(typeof document !== "undefined" && !!document.fullscreenEnabled);
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    rootRef.current
      ?.requestFullscreen?.()
      .catch((err) => console.warn("[PdfViewer] Fullscreen request refused:", err));
  }, []);

  // -------------------------------------------------------------------------
  // Download / print
  //
  // Both go through the bytes rather than the URL: the preview endpoint serves
  // Content-Disposition: inline with an opaque path, so a plain <a download>
  // would navigate away (cross-origin) or save a file called "preview".
  // -------------------------------------------------------------------------
  const [busy, setBusy] = useState<"download" | "print" | null>(null);

  const fetchDocumentBlob = useCallback(async () => {
    // Raw fetch by design: this is the same URL pdf.js is already streaming
    // (a token-signed preview path, or the host's own URL in URL mode), not a
    // tenant-scoped API call — see the note in no-raw-fetch.test.ts.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Document fetch returned ${res.status}`);
    return await res.blob();
  }, [url]);

  const handleDownload = useCallback(async () => {
    setBusy("download");
    try {
      const blob = await fetchDocumentBlob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = downloadFilename(filename);
      document.body.append(a);
      a.click();
      a.remove();
      // Revoking immediately races the browser's save in some engines.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      console.error("[PdfViewer] Download failed, opening the document instead:", err);
      window.open(url, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }, [fetchDocumentBlob, filename, url]);

  const handlePrint = useCallback(async () => {
    setBusy("print");
    let href: string | null = null;
    let frame: HTMLIFrameElement | null = null;
    try {
      const blob = await fetchDocumentBlob();
      href = URL.createObjectURL(blob);
      // Print the real PDF, not our canvases: in scroll mode only the pages
      // near the viewport are rendered, so printing this document would emit
      // a handful of screen-resolution pages.
      frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      Object.assign(frame.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        width: "0",
        height: "0",
        border: "0",
      });
      const loaded = new Promise<void>((resolve, reject) => {
        frame!.onload = () => resolve();
        frame!.onerror = () => reject(new Error("print frame failed to load"));
        // The blob is already in memory, so a browser with a PDF viewer loads
        // this in tens of milliseconds. A browser without one never fires the
        // event at all — bail early and open a tab rather than leaving the
        // button dead while the user waits on a timeout.
        setTimeout(() => reject(new Error("print frame timed out")), 5_000);
      });
      frame.src = href;
      document.body.append(frame);
      await loaded;
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      // Tearing the frame down while the print dialog is open cancels the job,
      // so clean up well after the user has had a chance to confirm.
      const doomed = frame;
      const doomedHref = href;
      setTimeout(() => {
        doomed.remove();
        URL.revokeObjectURL(doomedHref);
      }, 60_000);
    } catch (err) {
      // Some engines refuse to print a PDF from a hidden frame. Hand the
      // document to a real tab so the user still gets the browser's print UI.
      console.warn("[PdfViewer] Inline print unavailable, opening in a new tab:", err);
      frame?.remove();
      window.open(href ?? url, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }, [fetchDocumentBlob, url]);

  // -------------------------------------------------------------------------
  // Search
  //
  // The browser's own find can only see pages that are currently rendered —
  // one page in paginated mode, a handful in scroll mode — so it silently
  // misses most of the document. This searches the PDF's text through pdf.js
  // instead, then draws the hits by replaying each match offset against the
  // rendered text layer (see SearchOverlay).
  // -------------------------------------------------------------------------
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null);
  /** Per-page text, index 0 = page 1. Built once per document, on first search. */
  const pageTextsRef = useRef<string[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [internalQuery, setInternalQuery] = useState("");
  const query = searchQueryProp !== undefined ? (searchQueryProp ?? "") : internalQuery;
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [indexing, setIndexing] = useState(false);
  // Hits are stored WITH the query they belong to. Reading the two separately
  // exposes the in-between state — query updated, scan not finished — which a
  // host would receive as a "0 results" koji:searchResults before the real
  // count lands, i.e. a false "nothing found" flash on every search.
  const [search, setSearch] = useState<{ query: string; hits: SearchHit[] }>({
    query: "",
    hits: [],
  });
  const hits = search.hits;
  const [activeHit, setActiveHit] = useState(-1);

  const applyQuery = useCallback(
    (next: string) => {
      if (searchQueryProp === undefined) setInternalQuery(next);
      onSearchQueryChange?.(next === "" ? null : next);
    },
    [searchQueryProp, onSearchQueryChange],
  );

  // A fresh document invalidates the index and any hits drawn against it.
  useEffect(() => {
    pageTextsRef.current = null;
    setSearch({ query: "", hits: [] });
    setActiveHit(-1);
  }, [url]);

  // Typing shouldn't re-scan the document on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const q = debouncedQuery.trim();
    if (q.length < MIN_SEARCH_QUERY) {
      setSearch({ query: q, hits: [] });
      setActiveHit(-1);
      return;
    }
    const pdf = pdfRef.current;
    if (!pdf) return;

    (async () => {
      if (!pageTextsRef.current) {
        setIndexing(true);
        try {
          const texts: string[] = [];
          for (let p = 1; p <= pdf.numPages; p++) {
            const page = (await pdf.getPage(p)) as {
              getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
            };
            const content = await page.getTextContent();
            if (cancelled) return;
            // Concatenate exactly what the rendered text layer will hold:
            // pdf.js appends one span per item containing `item.str` verbatim
            // and skips empty ones. That makes this string and the DOM's
            // textContent agree character for character, which is what lets a
            // match offset found here be replayed against the DOM to draw the
            // box (see SearchOverlay).
            texts.push(content.items.map((i) => i.str ?? "").join(""));
          }
          pageTextsRef.current = texts;
        } catch (err) {
          console.error("[PdfViewer] Could not read the document's text for search:", err);
          return;
        } finally {
          if (!cancelled) setIndexing(false);
        }
      }
      if (cancelled) return;
      const found = collectHits(pageTextsRef.current ?? [], q);
      setSearch({ query: q, hits: found });
      setActiveHit(found.length ? 0 : -1);
    })();

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, totalPages, url]);

  // Whether `hits` describes the query the user has actually typed, or a scan
  // is still in flight. Gates both the counter and the outbound results.
  const searchResolved = search.query === debouncedQuery.trim();

  // Report hit-list changes (the embed turns these into koji:searchResults).
  // Only once the scan has caught up with the query — see the note on `search`.
  useEffect(() => {
    if (!onSearchResults || !searchResolved) return;
    onSearchResults({
      query: search.query,
      total: search.query.length < MIN_SEARCH_QUERY ? 0 : hits.length,
      activeIndex: activeHit,
      page: hits[activeHit]?.page ?? null,
    });
  }, [hits, activeHit, search.query, searchResolved, onSearchResults]);

  // Bring the focused hit into view: page first (so its overlay mounts), then
  // the box itself once it has been drawn — same retry shape as activeField,
  // because the overlay can only measure after the text layer has rendered.
  useEffect(() => {
    const hit = hits[activeHit];
    if (!hit) return;
    if (mode === "paginated") {
      setCurrentPage((prev) => {
        if (prev !== hit.page) onPageChange?.(hit.page);
        return hit.page;
      });
    } else {
      containerRef.current
        ?.querySelector(`[data-page-number="${hit.page}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    let cancelled = false;
    let attempts = 0;
    const scrollToHit = () => {
      if (cancelled) return;
      const el = containerRef.current?.querySelector("[data-search-active]");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (attempts++ < 20) setTimeout(scrollToHit, 50); // up to ~1s
    };
    const t = setTimeout(scrollToHit, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [activeHit, hits]); // eslint-disable-line react-hooks/exhaustive-deps

  // next/prev wrap around, so a reviewer can keep pressing Enter.
  const hitCountRef = useRef(0);
  useEffect(() => {
    hitCountRef.current = hits.length;
  }, [hits.length]);
  const goToHit = useCallback((delta: number) => {
    setActiveHit((cur) => wrapIndex((cur < 0 ? 0 : cur) + delta, hitCountRef.current));
  }, []);

  useImperativeHandle(
    controlRef,
    () => ({ searchNext: () => goToHit(1), searchPrev: () => goToHit(-1) }),
    [goToHit],
  );

  // A query pushed in from outside (koji:search) opens the panel, so the user
  // can see what is being searched and take over the prev/next controls.
  useEffect(() => {
    if (searchQueryProp) setSearchOpen(true);
  }, [searchQueryProp]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after the row has mounted.
    setTimeout(() => searchInputRef.current?.select(), 0);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    applyQuery("");
  }, [applyQuery]);

  // Cmd/Ctrl+F opens *our* search rather than the browser's, which would only
  // find the pages that happen to be rendered. Only bound when the tool is
  // enabled, so surfaces without it leave the native shortcut alone.
  useEffect(() => {
    if (!tools.search) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tools.search, openSearch]);

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

  // A search is "live" once the query is long enough to run. Gates both the
  // per-page overlays and the text-layer render notifications that redraw them.
  const searchActive = !!tools.search && debouncedQuery.trim().length >= MIN_SEARCH_QUERY;
  const [textLayerTick, setTextLayerTick] = useState(0);
  const bumpTextLayer = useCallback(() => setTextLayerTick((t) => t + 1), []);
  const focusedHit = hits[activeHit];

  /** The hit overlay for one page — nothing to draw unless a search is live. */
  const searchOverlayFor = (pageNum: number) =>
    searchActive ? (
      <SearchOverlay
        page={pageNum}
        query={debouncedQuery.trim()}
        activeOrdinal={focusedHit?.page === pageNum ? focusedHit.ordinal : null}
        // Any of these moves the text layer, so the boxes must be re-measured.
        redrawKey={`${textLayerTick}:${pageWidth ?? 0}:${rotation}`}
      />
    ) : null;

  const zoomTool = tools.zoom;
  const anyTool =
    (tools.select && !!selection?.onToggleActive) ||
    zoomTool ||
    tools.search ||
    tools.rotate ||
    tools.download ||
    tools.print ||
    (tools.fullscreen && fullscreenAvailable);

  const searchCountLabel =
    query.trim().length < MIN_SEARCH_QUERY
      ? ""
      : indexing
        ? "reading…"
        : !searchResolved
          ? "searching…"
          : hits.length === 0
            ? "no results"
            : `${activeHit + 1} / ${hits.length}`;

  return (
    <div
      ref={rootRef}
      className={`flex flex-col h-full min-h-0${isFullscreen ? " bg-white" : ""}`}
      data-fullscreen={isFullscreen ? "true" : undefined}
    >
      {/* Toolbar: optional slot (e.g. field picker) + tools + page navigation + highlight toggle */}
      {(totalPages > 1 || highlights.length > 0 || toolbarSlot || anyTool) && (() => {
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

        // Optional tools, in the order a reader reaches for them. Each is
        // rendered only when the embed opted into it (?tools=…).
        const toolButtons = anyTool ? (
          <div className="flex items-center gap-0.5 shrink-0">
            {tools.select && selection?.onToggleActive && (
              <ToolButton
                icon={Crosshair}
                label={
                  selection.active
                    ? "Exit region selection"
                    : "Select a region on the document"
                }
                testId="pdf-tool-select"
                active={selection.active}
                onClick={selection.onToggleActive}
              />
            )}
            {tools.search && (
              <ToolButton
                icon={Search}
                label={searchOpen ? "Close search" : "Find in document"}
                testId="pdf-tool-search"
                active={searchOpen}
                onClick={() => (searchOpen ? closeSearch() : openSearch())}
              />
            )}
            {zoomTool && (
              <>
                <ToolButton
                  icon={ZoomOut}
                  label="Zoom out"
                  testId="pdf-tool-zoom-out"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => applyZoom(stepZoom(zoom, "out"))}
                />
                <button
                  type="button"
                  onClick={() => applyZoom(FIT_ZOOM)}
                  title="Reset zoom to fit width"
                  aria-label="Reset zoom to fit width"
                  data-testid="pdf-tool-zoom-reset"
                  className="rounded px-1 font-mono text-[10px] tabular-nums text-ink-4 hover:bg-cream-2"
                >
                  {formatZoom(zoom)}
                </button>
                <ToolButton
                  icon={ZoomIn}
                  label="Zoom in"
                  testId="pdf-tool-zoom-in"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => applyZoom(stepZoom(zoom, "in"))}
                />
              </>
            )}
            {tools.rotate && (
              <ToolButton
                icon={RotateCw}
                label="Rotate 90° clockwise"
                testId="pdf-tool-rotate"
                active={rotation !== 0}
                onClick={() => applyRotation(stepRotation(rotation, "cw"))}
              />
            )}
            {tools.download && (
              <ToolButton
                icon={Download}
                label="Download document"
                testId="pdf-tool-download"
                disabled={busy === "download"}
                onClick={() => void handleDownload()}
              />
            )}
            {tools.print && (
              <ToolButton
                icon={Printer}
                label="Print document"
                testId="pdf-tool-print"
                disabled={busy === "print"}
                onClick={() => void handlePrint()}
              />
            )}
            {tools.fullscreen && fullscreenAvailable && (
              <ToolButton
                icon={isFullscreen ? Minimize2 : Maximize2}
                label={isFullscreen ? "Exit full screen" : "Full screen"}
                testId="pdf-tool-fullscreen"
                active={isFullscreen}
                onClick={toggleFullscreen}
              />
            )}
          </div>
        ) : null;

        // With a toolbar slot (the embed field picker), give the slot the
        // flexible space on the left and pin the tools + page nav + toggle to
        // the right so the slot can never crowd them out. Without a slot, keep
        // the original prev | center | next layout used by the dashboard
        // surfaces, with the tools sharing the centre group.
        return toolbarSlot ? (
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
            <div className="min-w-0 flex-1">{toolbarSlot}</div>
            <div className="flex items-center gap-1 shrink-0">
              {toolButtons}
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
              {toolButtons}
              {pageLabel}
              {highlightToggle}
            </div>
            {nextBtn ?? <span />}
          </div>
        );
      })()}

      {/* Search row — a second toolbar line so the query field gets real
          estate without squeezing the page nav on a narrow embed. */}
      {tools.search && searchOpen && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border shrink-0">
          <Search className="w-3 h-3 shrink-0 text-ink-4" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => applyQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goToHit(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find in document"
            aria-label="Find in document"
            data-testid="pdf-search-input"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink-2 placeholder:text-ink-4 focus:outline-none"
          />
          <span
            data-testid="pdf-search-count"
            aria-live="polite"
            className="shrink-0 font-mono text-[10px] tabular-nums text-ink-4 whitespace-nowrap"
          >
            {searchCountLabel}
          </span>
          <ToolButton
            icon={ChevronUp}
            label="Previous match"
            testId="pdf-search-prev"
            disabled={hits.length === 0}
            onClick={() => goToHit(-1)}
          />
          <ToolButton
            icon={ChevronDown}
            label="Next match"
            testId="pdf-search-next"
            disabled={hits.length === 0}
            onClick={() => goToHit(1)}
          />
          <ToolButton icon={X} label="Close search" testId="pdf-search-close" onClick={closeSearch} />
        </div>
      )}

      {/* PDF document. Tailwind class names MUST be literal strings — a
          template like `overflow-${overflow}` does not get picked up by the
          JIT compiler, so the generated CSS will be missing the overflow
          rule and the container will not scroll. Use an explicit map. */}
      <div ref={containerRef} className={`flex-1 min-h-0 ${overflowClass[overflow]}`}>
        <ReactPdfDocument
          file={file}
          // w-max lets a zoomed-in page grow past the container (the container
          // scrolls horizontally); min-w-full + items-center keeps a zoomed-out
          // page centred instead of pinned to the left edge.
          className="flex w-max min-w-full flex-col items-center"
          onLoadSuccess={(pdf) => {
            setTotalPages(pdf.numPages);
            // Held for search: pdf.js is the only way to read text off pages
            // that aren't currently rendered.
            pdfRef.current = pdf;
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
              width={pageWidth}
              rotate={rotation}
              renderAnnotationLayer={false}
              onRenderTextLayerSuccess={searchActive ? bumpTextLayer : undefined}
            >
              {showHighlights && pageHighlights.length > 0 && (
                <HighlightOverlay
                  highlights={pageHighlights}
                  activeField={activeField ?? null}
                  currentPage={currentPage}
                  onFieldClick={onFieldClick}
                  theme={theme}
                  rotation={rotation}
                />
              )}
              {searchOverlayFor(currentPage)}
              {selection && (selection.active || selection.snapped) && (
                <SelectionLayer
                  page={currentPage}
                  selection={selection}
                  theme={theme}
                  rotation={rotation}
                />
              )}
            </ReactPdfPage>
          ) : (
            allPageNumbers.map((pageNum) => (
              <LazyPage
                key={pageNum}
                pageNumber={pageNum}
                width={pageWidth}
                scrollRoot={containerRef.current}
                rotation={rotation}
              >
                <ReactPdfPage
                  pageNumber={pageNum}
                  width={pageWidth}
                  rotate={rotation}
                  renderAnnotationLayer={false}
                  onRenderTextLayerSuccess={searchActive ? bumpTextLayer : undefined}
                >
                  {showHighlights && (
                    <HighlightOverlay
                      highlights={highlights.filter((h) => h.page === pageNum)}
                      activeField={activeField ?? null}
                      currentPage={pageNum}
                      onFieldClick={onFieldClick}
                      theme={theme}
                      rotation={rotation}
                    />
                  )}
                  {searchOverlayFor(pageNum)}
                  {selection && (selection.active || selection.snapped) && (
                    <SelectionLayer
                      page={pageNum}
                      selection={selection}
                      theme={theme}
                      rotation={rotation}
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
// Toolbar icon button — one look for every optional tool.
// ---------------------------------------------------------------------------

function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      data-testid={testId}
      className={`rounded p-0.5 transition-colors disabled:cursor-default disabled:opacity-30 ${
        active ? "bg-vermillion-3/30 text-vermillion-2" : "text-ink-3 hover:bg-cream-2"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Search overlay — draws the hits for one page.
//
// The boxes come from the rendered text layer rather than from pdf.js
// geometry: a match can start mid-item and run across several of them, and a
// DOM Range measures exactly that (including the line break in the middle of a
// wrapped phrase) with the browser's own glyph metrics. The page's text layer
// concatenates to the same string the search index was built from, so a match
// offset from the index addresses the same characters here.
// ---------------------------------------------------------------------------

function SearchOverlay({
  page,
  query,
  activeOrdinal,
  redrawKey,
}: {
  page: number;
  query: string;
  /** Which hit on this page is focused, or null if the focused hit is elsewhere. */
  activeOrdinal: number | null;
  /** Changes whenever the text layer moves (re-render, zoom, rotation). */
  redrawKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Array<NormBox & { ordinal: number }>>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure after paint — mid-render the text layer may still be empty or
    // sized against the previous zoom level.
    const raf = requestAnimationFrame(() => {
      const pageEl = el.closest(".react-pdf__Page");
      const layer = pageEl?.querySelector(".react-pdf__Page__textContent");
      const base = el.getBoundingClientRect();
      if (!layer || !base.width || !base.height) {
        setBoxes([]);
        return;
      }

      // Walk the text nodes once, recording where each starts in the page's
      // text, so a character offset can be turned into a (node, offset) pair.
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number }> = [];
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n as Text, start: text.length });
        text += n.nodeValue ?? "";
      }
      if (!nodes.length) {
        setBoxes([]);
        return;
      }

      const locate = (offset: number) => {
        let lo = 0;
        let hi = nodes.length - 1;
        let found = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (nodes[mid].start <= offset) {
            found = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const entry = nodes[found];
        return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.length) };
      };

      const out: Array<NormBox & { ordinal: number }> = [];
      findMatches(text, query).forEach((match, ordinal) => {
        const from = locate(match.start);
        const to = locate(match.end);
        const range = document.createRange();
        try {
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
        } catch {
          return; // Text layer changed under us; the next redraw will catch it.
        }
        // One rect per line the match spans.
        for (const r of Array.from(range.getClientRects())) {
          if (r.width <= 0 || r.height <= 0) continue;
          out.push({
            ordinal,
            x: (r.left - base.left) / base.width,
            y: (r.top - base.top) / base.height,
            w: r.width / base.width,
            h: r.height / base.height,
          });
        }
      });
      setBoxes(out);
    });
    return () => cancelAnimationFrame(raf);
  }, [query, redrawKey, page]);

  // The container always renders — it is what the effect measures against, so
  // returning null while there are no boxes would mean never finding any.
  return (
    <div
      data-search-layer={page}
      ref={ref}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        // Under the provenance highlights (z 3) so those stay clickable.
        zIndex: 2,
      }}
    >
      {boxes.map((b, i) => {
        const isActive = b.ordinal === activeOrdinal;
        return (
          <div
            key={`${b.ordinal}-${i}`}
            data-search-hit={b.ordinal}
            data-search-active={isActive ? "" : undefined}
            className={`absolute rounded-[1px] ${
              isActive ? "bg-vermillion-2/45 ring-1 ring-vermillion-2" : "bg-vermillion-3/35"
            }`}
            style={{
              left: `${b.x * 100}%`,
              top: `${b.y * 100}%`,
              width: `${b.w * 100}%`,
              height: `${b.h * 100}%`,
            }}
          />
        );
      })}
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
  rotation = 0,
  children,
}: {
  pageNumber: number;
  width: number | undefined;
  scrollRoot: HTMLDivElement | null;
  /** Quarter turns swap the page's aspect, so the placeholder has to follow. */
  rotation?: Rotation;
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

  const aspect = rotation === 90 || rotation === 270 ? 1 / ESTIMATED_PAGE_ASPECT : ESTIMATED_PAGE_ASPECT;
  const placeholderHeight = width ? width * aspect : 800;

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
  rotation = 0,
}: {
  page: number;
  selection: SelectionConfig;
  theme?: HighlightTheme;
  /** Display rotation — the drag is un-rotated before it leaves this layer. */
  rotation?: Rotation;
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
        // The drag is in rotated display space; resolve-region (and every
        // stored bbox) speaks the page's native orientation.
        selection.onRegionSelected({ page, bbox: unrotateBox(marquee, rotation) });
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
        )
          // The echo comes back in page space — rotate it to match the view.
          .map((box) => rotateBox(box, rotation))
          .map((box, i) => (
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
  rotation = 0,
}: {
  highlights: BBoxHighlight[];
  activeField: string | null;
  currentPage: number;
  onFieldClick?: (field: string, page: number) => void;
  theme?: HighlightTheme;
  /**
   * Display rotation. Highlight geometry is stored against the page's native
   * orientation, so every box is rotated into display space here — otherwise a
   * rotated view leaves the highlights sitting on the wrong words.
   */
  rotation?: Rotation;
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
            .map((word) => rotateBox(word, rotation))
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
        const box = rotateBox(h.bbox, rotation);
        return (
          <HoverBox
            key={`${h.field}-${i}`}
            className={boxClass}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
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
