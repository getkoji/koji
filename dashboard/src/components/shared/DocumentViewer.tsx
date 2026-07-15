"use client";

/**
 * DocumentViewer — the canonical document preview component.
 *
 * **Use this anywhere the dashboard needs to display a customer document.**
 * It picks the right renderer (PdfViewer / `<img>` / unsupported fallback)
 * based on the MIME type, and accepts the standard set of preview props the
 * rest of the app already passes (highlights, active field, layout mode).
 *
 * The `url` prop should be a document preview URL — i.e. the path returned by
 * an API endpoint that streams the file with `Content-Disposition: inline`
 * and the correct `Content-Type`. In Koji that's the `/api/jobs/:slug/
 * documents/:docId/preview` HMAC-token endpoint (see `auth/middleware.ts` and
 * `routes/jobs.ts`). Do NOT pass raw S3/R2 presigned URLs here — they can
 * vary in `Content-Disposition` depending on how the object was stored and
 * will trigger downloads instead of inline rendering for some objects.
 *
 * If you find yourself building a fresh `<iframe>`/`<img>` block to display
 * a document anywhere in the dashboard, replace it with this component.
 */

import dynamic from "next/dynamic";
import { Eye, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BBoxHighlight, SelectionConfig } from "./PdfViewer";
import { ParsedMarkdownView } from "./ParsedMarkdownView";

export type DocumentRenderer = "pdf" | "image" | "text" | "unsupported";

/**
 * Decide how to render a document given its MIME type.
 *
 * Real-world wrinkles this function compensates for:
 *
 * 1. `application/octet-stream` — many upload clients (browser drag-drop,
 *    CLIs, certain integrations) never set a Content-Type header and
 *    storage backends preserve that as-is. Those documents are
 *    overwhelmingly PDFs in practice, so octet-stream routes to the PDF
 *    renderer optimistically. PdfViewer surfaces a visible error if the
 *    bytes aren't actually a PDF.
 *
 * 2. Bare-extension MIME strings — some API clients send `Content-Type: pdf`
 *    (literally the extension) on presigned uploads. R2 stores that
 *    verbatim, ingestion persists it, and a non-MIME string ends up on the
 *    document row. The API-side fix (`normalizeMimeType` in
 *    `api/src/ingestion/process.ts`) catches this at ingestion time going
 *    forward, but existing rows still carry bad values and re-uploading
 *    every doc isn't feasible. This function tolerates bare `pdf`, `png`,
 *    `jpg`, etc. as a defence in depth.
 *
 * 3. Anything else unrecognised — fall back to the `filename`'s extension
 *    (when known) before declaring "unsupported". The filename is far more
 *    reliable than the Content-Type header for customer-uploaded files.
 *
 * Production rule: prefer to fix bad data at ingestion. This function is
 * the safety net that keeps the UI usable when bad data has already landed.
 */
const PDF_EXTENSIONS = new Set(["pdf"]);
const TEXT_EXTENSIONS = new Set(["txt", "text", "md", "markdown"]);
const TEXT_MIMETYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "svg"]);

function extensionFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const ext = filename.toLowerCase().split(".").pop();
  return ext && ext !== filename.toLowerCase() ? ext : null;
}

export function pickDocumentRenderer(
  mimeType: string | null,
  url: string | null,
  filename?: string | null,
): DocumentRenderer {
  if (!url) return "unsupported";
  if (mimeType?.startsWith("image/")) return "image";
  // Explicit text/markdown MIME wins before the octet-stream→PDF optimism
  // below — text files carry a real Content-Type once ingestion maps their
  // extension (see api/src/ingestion/mime.ts).
  if (mimeType && TEXT_MIMETYPES.has(mimeType.toLowerCase().trim())) return "text";
  if (
    mimeType === "application/pdf" ||
    mimeType === "application/x-pdf" ||
    mimeType === "application/octet-stream" ||
    mimeType === "binary/octet-stream" ||
    mimeType == null
  ) {
    return "pdf";
  }
  // Defence in depth — bare extension strings (`"pdf"`, `"png"`, …) and
  // any other unrecognised value fall through to filename-extension
  // inference. If the filename doesn't tell us either, then it's
  // genuinely unsupported.
  const normalized = mimeType.toLowerCase().trim();
  if (PDF_EXTENSIONS.has(normalized)) return "pdf";
  if (IMAGE_EXTENSIONS.has(normalized)) return "image";
  if (TEXT_EXTENSIONS.has(normalized)) return "text";

  const ext = extensionFromFilename(filename);
  if (ext) {
    if (PDF_EXTENSIONS.has(ext)) return "pdf";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (TEXT_EXTENSIONS.has(ext)) return "text";
  }
  return "unsupported";
}

const PdfViewer = dynamic(
  () => import("./PdfViewer").then((m) => m.PdfViewer),
  { ssr: false },
);

export interface DocumentViewerProps {
  /**
   * A preview URL that streams the file inline. Prefer URLs from the
   * `/api/jobs/:slug/documents/:docId/preview` endpoint (or analogous
   * endpoints that set `Content-Disposition: inline`).
   *
   * `null` renders the "preview unavailable" fallback so callers don't
   * need to conditionally mount the component.
   */
  url: string | null;
  /** Required so the component can pick PdfViewer vs `<img>` vs fallback. */
  mimeType: string | null;
  /** Optional filename for the `<img alt>` text and fallback messaging. */
  filename?: string | null;
  /** Per-field bounding-box highlights for PDFs. Ignored for images. */
  highlights?: BBoxHighlight[];
  /** Field name currently in focus — drives PDF page navigation. */
  activeField?: string | null;
  /**
   * PdfViewer overflow behaviour. Defaults to `"auto"` — same as the
   * schema build page, which is the proven-working reviewer surface.
   * `"scroll"` forces an always-visible scrollbar; `"hidden"` suppresses
   * it entirely.
   */
  overflow?: "auto" | "scroll" | "hidden";
  /**
   * PdfViewer display mode. Defaults to `"scroll"` — every page stacked
   * vertically in one tall, virtualized column, which is the canonical
   * preview UX in Koji. `"paginated"` instead gives reviewers `<` / `>`
   * arrows and shows one page at a time — opt into that only when the
   * surface explicitly wants page-at-a-time navigation.
   */
  mode?: "paginated" | "scroll";
  /**
   * Region selection for highlight-to-correct (PDFs only — ignored for
   * images and the parsed view). See `SelectionConfig` in PdfViewer.
   */
  selection?: SelectionConfig;
  /** Optional override for the wrapper element's className. */
  className?: string;
  /**
   * When true (default), the renderer (PdfViewer / `<img>`) is not
   * mounted until the wrapper scrolls into the viewport. This avoids
   * downloading/parsing PDF bytes for surfaces where the viewer starts
   * off-screen (collapsed panels, hidden tabs, virtualized lists). Once
   * the wrapper has been visible at least once, the renderer stays
   * mounted — re-mounting on every scroll would re-trigger pdf.js setup
   * and lose user scroll position.
   *
   * Pass `false` to force-mount immediately (e.g. the review queue's
   * always-on document pane, server-rendered surfaces, anywhere
   * IntersectionObserver might lie about visibility).
   */
  lazy?: boolean;

  // ── Parsed-text mode (optional) ──────────────────────────────────────
  // Provide `markdown` (or `onRequestParsed` for lazy fetch) to enable a
  // PDF ⇄ Parsed toggle. Parsed view shows the document text the parser
  // produced — the same view the schema build page exposes — with
  // provenance highlights kept in sync with the PDF.

  /** Parsed document markdown. Presence (or `onRequestParsed`) enables the toggle. */
  markdown?: string | null;
  /** Show a loading state in the Parsed view while `markdown` is being fetched. */
  markdownLoading?: boolean;
  /** Per-field provenance map (offsets into `markdown`) for parsed highlights. */
  provenance?: Record<string, unknown> | null;
  /** Called when a highlighted span is clicked in the Parsed view (toggles the field). */
  onActiveFieldChange?: (field: string | null) => void;
  /** Called the first time the user switches to Parsed — lazily fetch `markdown` here. */
  onRequestParsed?: () => void;
}

export function DocumentViewer({
  url,
  mimeType,
  filename,
  highlights,
  activeField,
  overflow = "auto",
  mode = "scroll",
  selection,
  className,
  lazy = true,
  markdown,
  markdownLoading,
  provenance,
  onActiveFieldChange,
  onRequestParsed,
}: DocumentViewerProps) {
  const [errored, setErrored] = useState(false);
  const [viewMode, setViewMode] = useState<"pdf" | "parsed">("pdf");
  const containerRef = useRef<HTMLDivElement>(null);
  // Once the renderer has been mounted, stay mounted — re-mounting on
  // each viewport intersection would force pdf.js to refetch + reparse
  // the document and lose the user's page position.
  const [hasBeenVisible, setHasBeenVisible] = useState(!lazy);

  useEffect(() => {
    if (hasBeenVisible) return;
    const el = containerRef.current;
    if (!el) return;
    // Headless test environments / older browsers without
    // IntersectionObserver — degrade to "mounted from the start".
    if (typeof IntersectionObserver === "undefined") {
      setHasBeenVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setHasBeenVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      // 200px rootMargin warms up the renderer just before it scrolls
      // into view, so the user doesn't see a flash of "Loading...".
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBeenVisible]);

  const wrapperClass =
    className ??
    "border border-border rounded-sm bg-cream-2/40 overflow-hidden h-full";

  // Parsed-text mode is enabled when the caller opts in by providing markdown
  // (eager) or onRequestParsed (lazy fetch on first toggle).
  const parsedEnabled = markdown != null || markdownLoading === true || onRequestParsed != null;

  // Render the document body (PDF / image / fallback) — the original behaviour,
  // factored out so the parsed-mode wrapper can swap it for the parsed view.
  const renderDocBody = () => {
    if (!url) {
      return (
        <Unavailable
          wrapperClass={wrapperClass}
          title="Document preview unavailable."
          detail="The source file isn't in storage yet. Previews appear once the pipeline finishes ingesting the document."
        />
      );
    }
    if (errored) {
      return (
        <Unavailable
          wrapperClass={wrapperClass}
          title="Preview failed to load."
          detail="The signed URL may have expired or the object is missing from storage."
        />
      );
    }

    const renderer = pickDocumentRenderer(mimeType, url, filename);

    // Visibility-gated mount. Until the wrapper has been visible at least
    // once, render the skeleton (which still claims the same box so layout
    // doesn't jump when the renderer mounts). After it's been visible, the
    // renderer stays mounted permanently.
    if (!hasBeenVisible) {
      return (
        <div
          ref={containerRef}
          className={`${wrapperClass} flex items-center justify-center`}
          data-testid="document-viewer-skeleton"
        >
          <span className="animate-pulse font-mono text-[11px] text-ink-4">
            Loading preview…
          </span>
        </div>
      );
    }

    if (renderer === "image") {
      return (
        <div ref={containerRef} className={wrapperClass}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={filename ?? "Document preview"}
            className="w-full h-full object-contain"
            onError={() => setErrored(true)}
          />
        </div>
      );
    }

    if (renderer === "pdf") {
      return (
        <div
          ref={containerRef}
          className={wrapperClass}
          data-testid="document-viewer-pdf"
        >
          <PdfViewer
            url={url}
            highlights={highlights}
            activeField={activeField ?? null}
            overflow={overflow}
            mode={mode}
            selection={selection}
          />
        </div>
      );
    }

    if (renderer === "text") {
      return (
        <div
          ref={containerRef}
          className={wrapperClass}
          data-testid="document-viewer-text"
        >
          <TextViewer url={url} onError={() => setErrored(true)} />
        </div>
      );
    }

    // Unknown MIME type — render the unsupported fallback. We deliberately do
    // NOT fall through to an `<iframe>` here: iframes for unknown content
    // types frequently trigger downloads instead of inline rendering, which is
    // exactly the bug DocumentViewer exists to prevent.
    return (
      <Unavailable
        wrapperClass={wrapperClass}
        title="Preview not supported for this file type."
        detail={`MIME type: ${mimeType ?? "unknown"}. Download the file from the job page to inspect.`}
      />
    );
  };

  if (!parsedEnabled) {
    return renderDocBody();
  }

  const selectParsed = () => {
    setViewMode("parsed");
    if (markdown == null && onRequestParsed) onRequestParsed();
  };

  const toggleBtn = (active: boolean) =>
    `flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono transition-colors ${
      active ? "bg-ink text-cream" : "text-ink-4 hover:text-ink hover:bg-cream-2"
    }`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1 shrink-0">
        <button type="button" onClick={() => setViewMode("pdf")} className={toggleBtn(viewMode === "pdf")}>
          <Eye className="w-3 h-3" />
          PDF
        </button>
        <button type="button" onClick={selectParsed} className={toggleBtn(viewMode === "parsed")}>
          <FileText className="w-3 h-3" />
          Parsed
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {viewMode === "pdf" ? (
          renderDocBody()
        ) : markdown != null ? (
          <ParsedMarkdownView
            markdown={markdown}
            provenance={provenance}
            activeField={activeField ?? null}
            onFieldClick={onActiveFieldChange}
            className="h-full"
          />
        ) : (
          <div className={`${wrapperClass} flex items-center justify-center`}>
            <span className="animate-pulse font-mono text-[11px] text-ink-4">
              {markdownLoading ? "Loading parsed text…" : "Parsed text unavailable."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Unavailable({
  wrapperClass,
  title,
  detail,
}: {
  wrapperClass: string;
  title: string;
  detail: string;
}) {
  return (
    <div className={`${wrapperClass} flex items-center justify-center text-ink-3 text-[13px]`}>
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <FileText className="w-6 h-6 text-ink-4" />
        <span>{title}</span>
        <span className="font-mono text-[10px] text-ink-4 max-w-[36ch]">{detail}</span>
      </div>
    </div>
  );
}

/**
 * Renders a plain-text / markdown source document. Fetches the bytes from the
 * inline, signed preview URL and shows them verbatim as monospace text — the
 * raw source, not a parsed rendering. Text files have no page geometry, so
 * there are no bbox highlights to sync (unlike the PDF/parsed views).
 */
function TextViewer({ url, onError }: { url: string; onError: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The parent passes a fresh `onError` closure each render; keep it in a ref
  // so it isn't a fetch dependency (which would refetch on every re-render).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((body) => {
        if (cancelled) return;
        setText(body);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        onErrorRef.current();
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="animate-pulse font-mono text-[11px] text-ink-4">Loading preview…</span>
      </div>
    );
  }

  return (
    <pre className="h-full overflow-auto p-4 font-mono text-[12px] leading-relaxed text-ink whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}
