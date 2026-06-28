@AGENTS.md

# Dashboard rules

## API calls: always use the shared client

**Never use raw `fetch()` for API calls.** Always use the shared API client from `@/lib/api`:

```typescript
import { api } from "@/lib/api";

// GET
const data = await api.get<ResponseType>("/api/endpoint");

// POST with JSON
const result = await api.post<ResponseType>("/api/endpoint", { body });

// POST with FormData
const result = await api.postForm<ResponseType>("/api/endpoint", formData);

// PATCH
const result = await api.patch<ResponseType>("/api/endpoint", { body });

// Streaming (SSE)
const response = await api.streamForm("/api/endpoint", formData, signal);
```

The shared client handles:
- `x-koji-tenant` header (required for all tenant-scoped endpoints)
- Auth tokens (Bearer for Clerk, cookie for local auth)
- `credentials: "include"` when using cookie auth
- Consistent error handling via `ApiError`

Raw `fetch()` will miss the tenant header and auth, causing silent 400/401 errors. This has caused bugs multiple times — do not repeat it.

## UI components: use `@koji/ui`

The shared component library lives at `koji/packages/ui/` (package name `@koji/ui`). It's built on shadcn/ui with Koji branding. **Use these components instead of raw HTML elements.**

```typescript
import { Button, Dialog, Popover, Checkbox, Select, Textarea, Tabs, Badge } from "@koji/ui";
```

Available components include: Accordion, AlertDialog, Avatar, Badge, Button, ButtonGroup, Calendar, Card, Checkbox, Collapsible, Combobox, Command, ContextMenu, Dialog, Drawer, DropdownMenu, Field, Form, HoverCard, Input, Kbd, Label, Menubar, NativeSelect, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Sheet, Sidebar, Skeleton, Slider, Spinner, Switch, Table, Tabs, Textarea, Toggle, ToggleGroup, Tooltip.

The package exports from `./src/index.ts` and also supports deep imports via `@koji/ui/components/ui/<name>`.

**Note:** Many existing pages still use raw `<button>` / `<input>` elements (legacy). New code should use `@koji/ui`. A full migration pass is tracked as oss-155.

## Displaying customer documents: use `<DocumentViewer />`

**Anywhere the dashboard needs to render a customer document (PDF, image, etc.) — use the shared `DocumentViewer`.**

```typescript
import { DocumentViewer } from "@/components/shared/DocumentViewer";

<DocumentViewer
  url={item.documentPreviewUrl}      // from the API — see "Document preview URLs" below
  mimeType={item.documentMimeType}   // required, drives the renderer choice
  filename={item.documentFilename}   // optional, used as <img alt> and fallback
  highlights={highlights}            // optional, PDF bbox highlights
  activeField={activeField}          // optional, PDF page navigation
/>
```

It picks the right renderer for you:
- `application/pdf` / `application/x-pdf` → `<PdfViewer />` (react-pdf, supports highlights + field navigation)
- `image/*` → `<img>` with `object-contain`
- `application/octet-stream` / `binary/octet-stream` / `null` MIME → `<PdfViewer />` **optimistically** — most uploads in Koji land in storage with a generic / missing Content-Type, and customer documents are overwhelmingly PDFs. PdfViewer surfaces a visible error if the bytes aren't actually a PDF. (Real fix is to sniff MIME at upload time; until then DocumentViewer compensates.)
- Anything else (text/html, text/plain, application/zip, …) → "preview unavailable" / "unsupported" fallback (never an `<iframe>`)

### Lazy loading

The viewer pipeline is lazy by default:

- **Defer-mount** — `DocumentViewer` does not mount its renderer (PdfViewer / `<img>`) until the wrapper intersects the viewport. Pass `lazy={false}` to force-mount on first render (e.g. server-side surfaces or contexts where the observer can lie about visibility). Once mounted, the renderer stays mounted — re-mounting would re-fetch and re-parse the PDF.
- **Range fetch** — the `/api/jobs/:slug/documents/:docId/preview` endpoint emits `Accept-Ranges: bytes` and honours `Range:` headers (and `HEAD`). pdf.js uses this to stream the document in chunks instead of downloading the whole PDF before rendering page 1. A 60-page scanned PDF that previously took 5–8 s to first-paint now paints page 1 in well under a second.
- **Page virtualization in scroll mode** — `PdfViewer` only mounts `<ReactPdfPage>` for pages near the viewport. Pages outside the rootMargin show a height-claimed placeholder so scroll position stays stable. Once a page has rendered it stays rendered (scrolling back is free). Page 1 is eagerly rendered to give the document something to show before the user starts scrolling.

### Scroll and pagination defaults

`DocumentViewer` defaults to `mode="scroll"` and `overflow="auto"` — every page stacked vertically in one tall, virtualized column, which is the canonical preview UX across Koji (build page, review queue, document detail). Opt into `mode="paginated"` only if the surface explicitly wants page-at-a-time `<` / `>` arrow navigation showing one page at a time.

**Tailwind gotcha**: `overflow-auto` / `overflow-scroll` / `overflow-hidden` must appear as literal strings somewhere Tailwind can see. PdfViewer maps the prop through an explicit dictionary for this reason — never write `` className={`overflow-${variable}`} `` for these (or any Tailwind utility), the JIT compiler will silently drop the class.

**Do NOT** roll your own `<iframe src={...} />` block for documents. iframes against raw signed-storage URLs trigger downloads instead of inline rendering whenever the object's key has no recognised extension (production keys are UUIDs). DocumentViewer is the only document-rendering surface we maintain.

### Document preview URLs

The `url` prop must come from an endpoint that streams the file with `Content-Disposition: inline` and the correct `Content-Type`. In Koji that means the HMAC-signed `/api/jobs/:jobSlug/documents/:documentId/preview` endpoint (see `koji/api/src/routes/jobs.ts` + `koji/api/src/auth/middleware.ts` for the token scheme).

API endpoints that return a `documentPreviewUrl` field for the dashboard to consume:
- `GET /api/jobs/:slug/documents/:docId` → `documentPreviewUrl + documentToken`
- `GET /api/review/:itemId` → `documentPreviewUrl + documentToken`

If you're adding a new API response that surfaces a document, mirror those routes — build the URL with `generatePreviewToken(basePath, masterKey)` from `auth/middleware`. Do **not** pass a raw `storage.getSignedUrl(...)` result to the dashboard for document display; the iframe download bug will come back.
