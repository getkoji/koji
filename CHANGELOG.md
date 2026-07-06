# Changelog

Notable, user-visible changes. Newest first.

## 0.56.0 — 2026-07-06

**Highlight-to-correct in the review queue.** When an extraction is wrong,
point at the document instead of retyping: hit "point on document" (or `P`)
next to the override input, drag over where the correct value lives, and the
selection snaps to the text underneath and prefills the override — confirm or
edit, then approve. The correction is saved **with its location**: the field's
provenance gets a human-anchored source highlight (`resolution: "anchored"`),
so the corrected value shows an exact highlight on the trace page, in the
embed viewer, and in corpus ground truth promoted from the review. API:
`POST /api/review/{id}/override` accepts an optional `provenance` object.

## 0.55.1 — 2026-07-06

**Fix: hosted PDF normalization used the wrong Modal credentials.** The
`/normalize-pdf` fallback shipped in 0.54.3 authenticated to the Modal parse
service with the account API token instead of the proxy-auth token, so on the
hosted platform every normalization attempt failed with a 401 and encrypted
large PDFs still couldn't be parsed. The client now uses the same credential
order as the rest of the platform (`MODAL_PROXY_KEY`/`MODAL_PROXY_SECRET`
first). Self-hosted (docker) deployments were unaffected.

## 0.55.0 — 2026-07-06

**Embed viewer: region selection tool (`?tools=select`).** Embedded hosts can
now let reviewers point at where a value lives instead of retyping it. Off by
default; enable with `?tools=select` on the embed URL. Arm it from your app
(`koji:setSelectionMode`) or via the built-in crosshair toolbar toggle; the
user drags a rectangle, the selection snaps to the words underneath, and the
viewer emits `koji:regionSelected` with the resolved text, word boxes, and
snapped bbox. In Document mode resolution uses the embed's existing HMAC token
(`resolve-region`) — no extra auth or PDF handling in the host app. See the
integration guide's "Region selection" section.

## 0.54.3 — 2026-07-06

**Fix: encrypted PDFs no longer break large-document parsing.** PDFs with the
common owner-password / print-restriction encryption (empty user password)
that also store their page tree in compressed object streams could not be
page-counted or sliced locally. With a Google Document AI parse endpoint this
sent the whole document to a single synchronous `:process` call, which Google
rejects above 30 pages (`PAGE_LIMIT_EXCEEDED`); with the default engine, large
documents of this shape silently lost chunked parsing. Koji now detects the
case, re-saves the document once through the parse service's new
`/normalize-pdf` endpoint (decrypting it), and slices the normalized copy as
usual. If normalization is impossible the error now says why and what to do,
instead of surfacing Google's bare page-limit error.

## 0.54.2 — 2026-07-06

**`koji push` now actually pushes DAG pipelines.** Pipeline files with a
`steps:` list previously had their YAML silently dropped on both create and
update — the pipeline landed as type `simple` with an empty definition, and
running it later failed with "no deployed schema version". Pushed DAG files
now carry their full YAML (sent verbatim, with the compiler's required
`pipeline:` name added when missing), so classify routing and multi-step
definitions survive the push. The simple `schema: <name>` shorthand is
unchanged. Also fixed: running or ingesting into a DAG pipeline that has no
nominal schema no longer 500s — per-step schemas resolve from the pipeline
YAML at run time.

## 0.54.1 — 2026-07-06

**DAG pipelines now execute the routing they validated with.** The pipeline
runner previously re-parsed the raw YAML with its own edge extraction, which
didn't understand the documented `on:` / `then:` routing sugar — a classify
router with `on:` labels found zero edges and silently fell back to running
every step linearly (each routed extract ran, and the last one won regardless
of the classify label). The runner now executes the same compiled DAG that
`POST /api/pipelines/validate` reports, so conditional routing, default edges,
and `settings.max_steps` behave exactly as validated. Pipelines that can't
produce a runnable plan (e.g. a classify step with no routes in
pre-compiler-format YAML) now fail the document with a clear error instead of
running a wrong interpretation.

## 0.54.0 — 2026-07-06

**Document viewer region selection (groundwork).** The dashboard's PDF viewer
can now arm a selection mode: crosshair cursor, drag a rectangle on the page,
and the host snaps the selection to the words underneath (via
`resolve-region`). Not yet exposed anywhere in the UI — the embed viewer tool
and the review queue's highlight-to-correct flow build on this next.

## 0.53.0 — 2026-07-06

**Region → text resolution.** New endpoint
`POST /api/jobs/{slug}/documents/{docId}/resolve-region`: give it a page
number and a normalized rectangle, get back the document text underneath —
snapped to exact word boxes, in reading order. Accepts the same HMAC preview
token as `/preview`/`/embed-data`, so embedded viewers can call it without a
session. This is the foundation for highlight-to-correct: reviewers will point
at where the correct value lives instead of retyping it (selection UI ships
next).

## 0.52.1 — 2026-07-06

**Semver version labels everywhere in the dashboard.** Surfaces that still
showed the legacy incremental `v{N}` label — pipelines (list, detail, version
picker), jobs, document detail, review, schema build/validate/performance,
classifiers, and project settings — now show the version's semver label
(`v1.2.0`, `v1.2.0-rc.3`), matching the Validate tab and `koji schema
versions`. The pipeline version picker and Build's version history also badge
release candidates (`rc`) and the live release. API responses that carried
only a bare version number now also carry the label (additive:
`latestVersionLabel`, `schemaVersionLabel`, `deployedVersionLabel`, or a
`version` field on version objects); numeric fields are unchanged. Newly
created schemas and classifiers commit their initial version as `v0.0.1`
(previously the components defaulted to `0.0.0`).

## 0.52.0 — 2026-07-06

**Default-deny project access + per-project roles.** For PII/need-to-know:
newly-invited members no longer see every project by default — they start with
no project access until an admin grants it (owners/tenant-admins still see all).
And a member's capability is now set **per project**: an admin grants a member
`project-viewer` / `project-member` / `project-editor` / `project-admin` in each
project, so someone can edit one client's project and only view another's.
Org-level powers (inviting members, billing, deleting the workspace) always come
from the workspace role and are never granted per-project.

Non-breaking: existing members keep access to their existing projects
(grandfathered); only members/projects created after this ships get default-deny.
API: `GET`/`PUT /api/members/{id}/project-access` now carry per-project roles.

## 0.51.0 — 2026-07-05

**Per-project access control.** Projects are now a permission boundary, not
just data scoping. By default every workspace member can access every project
(unchanged). An admin can now restrict a member to specific projects from
Settings → Members → "project access": that member then only sees and can act
in their granted projects, and requests to any other project are refused
(`403`). A member's workspace role still applies wherever they have access.
API: `GET`/`PUT /api/members/{id}/project-access`.

## 0.50.0 — 2026-07-05

**Move a resource between projects.** Schemas, pipelines, sources, classifiers,
model/parse endpoints, webhooks, and API keys can now be reassigned to another
project via `POST /api/projects/{slug}/move` (and a "Move" action on the
pipeline page). A pipeline's jobs and review items move with it. Because
resources resolve within their project, a move that would strand a
cross-project reference (a pipeline whose schema stays behind) is rejected
with the list of what to move first — preview it with `dry_run: true`.

## 0.49.0 — 2026-07-05

**Project isolation, second wave.** The in-app notification bell and the
schema-agent chat sessions are now project-scoped, completing the isolation
that landed in 0.48 for the remaining user-facing surfaces.

- The notification bell now shows the selected project's notifications plus
  tenant-level ones (queue failures, billing alerts) — the latter stay
  visible in every project. Existing notifications are backfilled to the
  project of the job/document/pipeline they reference.
- Schema-agent (schema builder) chat sessions belong to their schema's
  project and are only visible there.

## 0.48.0 — 2026-07-03

**Projects are now a real isolation boundary.** Previously a project was an
overview page; every resource actually lived at the workspace level.

- Schemas, pipelines, jobs, sources, classifiers, review items, model
  endpoints, parse endpoints, webhooks, and API keys now belong to exactly
  one project, enforced with row-level security. Existing resources are
  migrated into each workspace's default project (the one whose slug matches
  the workspace slug) automatically.
- New `x-koji-project` request header selects the project; without it,
  requests resolve to the API key's project or the workspace default. See
  the [API reference](docs/api-reference.md#tenant--project-scoping).
- **API keys are project-bound.** A key can only operate inside the project
  it was created in, is rejected for other workspaces, and stops working if
  its project is deleted.
- Resource slugs are now unique per project (previously per workspace): two
  projects can each have a pipeline named `invoices`.
- Webhook fan-out is confined to the project the event originated in.
- Plan quantity limits (max schemas, pipelines, sources, webhooks) remain
  per-workspace.
- Deleting a workspace's last project is rejected.
- CLI: a profile's `--project` (or `KOJI_PROJECT`) is now sent as
  `x-koji-project` and must match the key's project. If you had a stale
  value stored from an earlier version, re-run `koji login`.
