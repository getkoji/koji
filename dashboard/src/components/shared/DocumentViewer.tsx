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
import { FileText } from "lucide-react";
import { useState } from "react";
import type { BBoxHighlight } from "./PdfViewer";

export type DocumentRenderer = "pdf" | "image" | "unsupported";

/**
 * Decide how to render a document given its MIME type.
 *
 * Real-world wrinkle: a meaningful fraction of customer documents land in
 * the database with `application/octet-stream` because the upload client
 * (browser drag-drop, CLI, certain integrations) never set a Content-Type
 * header and storage backends preserve that as-is. Those documents are
 * overwhelmingly PDFs in practice — the rest of the pipeline assumes PDF
 * or image input — so we route octet-stream to the PDF renderer
 * optimistically. PdfViewer surfaces a visible error if the bytes aren't
 * actually a PDF, which is the worst case here. The previous behaviour
 * rendered an "unsupported" screen for octet-stream and made the review
 * queue unusable for any tenant whose upload path didn't sniff MIME.
 *
 * Real fix is to sniff MIME at upload time and stop persisting
 * `application/octet-stream` — tracked separately. This function is the
 * forgiving client-side fallback until that lands.
 */
export function pickDocumentRenderer(
  mimeType: string | null,
  url: string | null,
): DocumentRenderer {
  if (!url) return "unsupported";
  if (mimeType?.startsWith("image/")) return "image";
  if (
    mimeType === "application/pdf" ||
    mimeType === "application/x-pdf" ||
    mimeType === "application/octet-stream" ||
    mimeType === "binary/octet-stream" ||
    mimeType == null
  ) {
    return "pdf";
  }
  // Other text-ish MIMEs the PDF viewer can't handle — explicit unsupported
  // rather than guess. Customer-facing docs in Koji are overwhelmingly PDF
  // or image, so the long tail isn't worth a renderer.
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
   * PdfViewer display mode. Defaults to `"paginated"` — same as the
   * schema build page. Paginated mode gives reviewers `<` / `>` arrows
   * and shows one page at a time, which matches the canonical reviewer
   * UX in Koji. `"scroll"` stacks every page in one tall column — opt
   * into that only when the surface explicitly wants long-form scroll.
   */
  mode?: "paginated" | "scroll";
  /** Optional override for the wrapper element's className. */
  className?: string;
}

export function DocumentViewer({
  url,
  mimeType,
  filename,
  highlights,
  activeField,
  overflow = "auto",
  mode = "paginated",
  className,
}: DocumentViewerProps) {
  const [errored, setErrored] = useState(false);

  const wrapperClass =
    className ??
    "border border-border rounded-sm bg-cream-2/40 overflow-hidden h-full";

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

  const renderer = pickDocumentRenderer(mimeType, url);

  if (renderer === "image") {
    return (
      <div className={wrapperClass}>
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
      <div className={wrapperClass} data-testid="document-viewer-pdf">
        <PdfViewer
          url={url}
          highlights={highlights}
          activeField={activeField ?? null}
          overflow={overflow}
          mode={mode}
        />
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
