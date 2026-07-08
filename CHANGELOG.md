# Changelog

Notable, user-visible changes. Newest first.

## 0.71.0 — 2026-07-08

**`koji pipeline bench` now reports why a classify step didn't classify.** The
`/test` response has always tagged each classify step with the `method` that
produced its label — `keyword`/`llm`/`vision` when the step ran, or
`no_classifier`/`no_version`/`no_file`/`no_provider` when it never inspected the
document. The bench threw that away and scored only the terminal schema, so a
pipeline whose classifier reference didn't resolve looked exactly like a
pipeline whose classifier was simply bad: every document took the `default`
edge, routing read `0.0%`, and nothing said why.

The report now carries a `CLASSIFY` line with per-method counts, annotates each
misroute with its classify trail (`classify_carrier=unknown(no_classifier)`),
and — when any step failed to run — says outright that the routing score is
measuring a broken pipeline rather than classifier accuracy. `--json` gains a
`classify` block and a per-document `classify` array.
## 0.70.1 — 2026-07-08

**A classifier that can't reach a model provider now fails loudly instead of
routing to `default`.** When a classifier's config admits the LLM or vision
tier but the tenant's model provider couldn't be resolved, the cascade used to
swallow the error and return `unknown` — indistinguishable from "the classifier
looked and couldn't tell." In a pipeline that meant every document quietly took
the `default` edge and got extracted against the wrong schema, with no error
anywhere. Now:

- `POST /api/classify` returns **503** with the underlying reason.
- A DAG `classify` step **fails** the document instead of routing it.
- `koji pipeline test` reports the step as failed with `method: no_provider`.

A cheap keyword match still short-circuits before the LLM tier, so tenants with
no model endpoint keep classifying deterministically. And a genuine `unknown`
(the classifier ran and couldn't decide) is unchanged — it still routes to
`default`.

**A failed DAG step no longer marks the document `delivered`.** Any step that
threw aborted the walk, and the run then fell through to the tail bookkeeping,
which stamped the document `delivered` with no extraction. Such documents are
now marked `failed` with the offending step id and error.

## 0.70.0 — 2026-07-08

**Pin a referenced classifier to a specific version in a pipeline.** A DAG
`classify` step that references a classifier by slug can now also pin its
version: `classifier: doc_type` + `classifier_version: v0.0.3`. Without a pin
the step runs the classifier's current released version (unchanged); with one
it runs exactly that version, and a pin that doesn't resolve fails loud
(the step returns `unknown` with a clear reason) rather than silently falling
back to the live release — so a staged classifier rollout can't quietly change
how a pinned pipeline routes. The resolved version is reported in the step
output (and in `koji pipeline test`). Accepts a semver label (`v0.0.3` or
`0.0.3`) or a version-id prefix.

## 0.69.0 — 2026-07-08

**A pipeline DAG classify step can reference a registered classifier by slug.**
Give a `classify` step `classifier: <slug>` (instead of inline
`labels`/`method`/`question`) and it runs that registered classifier through the
**same cascade** as `koji classify run` and `POST /api/classify` — so a
pipeline routes a document exactly the way the standalone classifier classifies
it, with no second ad-hoc implementation to drift. The classifier is
single-sourced and independently versioned (`koji classify promote/release`);
the pipeline just references it. Inline `labels` still work as before. Applies
to real ingestion runs, `koji pipeline test`, and `koji pipeline run` alike;
`koji push` now uploads classifiers before pipelines. The referenced
classifier resolves to its current released version (pinning a classifier
version per-pipeline is not yet supported).

## 0.68.0 — 2026-07-08

**`koji pipeline bench` — run a corpus against a pipeline (DAG).** Where `koji
bench` scores a corpus against a single schema, `koji pipeline bench <slug>
--corpus <path>` runs every corpus document through a whole pipeline and scores
two things: did each doc **route** to the correct schema, and did it **extract**
correctly once there. It reuses `POST /api/pipelines/<slug>/test`, so nothing is
persisted — no jobs are created. No new corpus labels are needed: each
document's manifest already names the schema it belongs to (the expected route)
and its `.expected.json` is the extraction ground truth. Extraction is scored
only for correctly-routed docs — a mis-route makes field scores meaningless — and
is broken out per terminal schema, since outputs vary with the path a doc takes
through the DAG. Supports `--category`, `--limit`, and `--json`. Point it at a
mixed corpus (docs that route to different schemas) to exercise routing.

## 0.67.0 — 2026-07-08

**`koji classify run` caps large PDF scans to the first few pages.** A big
multi-page scan (e.g. a 2.9 MB PDF) previously hit the API's request-body size
limit (HTTP 413) on upload. Since classification keys on the masthead / first
page, `classify run` now sends only the first `--max-pages` pages of a
multi-page PDF (default 3), keeping the upload small. Pass `--max-pages 0` to
send the whole document. Non-PDFs and short PDFs are unchanged.

## 0.66.0 — 2026-07-08

**`koji push` now registers standalone classifiers.** A file with `kind:
classifier` is created (or versioned, on change) via `/api/classifiers`, so a
classifier can be a first-class named resource — referenced by pipelines by
name and getting the same `koji classify versions / promote / release`
lifecycle as a schema — instead of every pipeline inlining its own copy. Push
also searches a `classifiers/` subdirectory.

**`koji push` no longer silently skips unrecognized files.** A file whose
`kind` isn't `schema` / `pipeline` / `classifier` is now reported
("Skipped N file(s) with unhandled kind: …") instead of vanishing into a
"0 pushed" summary. Untagged files are still treated as schemas.

## 0.65.2 — 2026-07-08

**`/api/process` and `/api/parse` now use the tenant's configured parse
provider.** Both endpoints (used by `koji process`, and callable directly)
POSTed straight to the global default parse backend, bypassing the tenant's
BYO parse provider (Doc AI / Textract / …). On the hosted platform, where the
global backend isn't the tenant's, this returned `Parse failed` for every
document — even though `koji corpus add`, build, and pipeline test parsed the
same PDFs fine. Both endpoints now resolve the parse provider the same way the
rest of the pipeline does, and surface the underlying parse error detail
instead of an empty `{}`.

## 0.65.1 — 2026-07-08

**Pipeline test mode now resolves the schema version exactly like production.**
The pipeline dry-run (`koji pipeline test` / the dashboard Test button) resolved
each extract step's schema version by reading the schema's current live release
directly. That diverged from a real run for **pinned** pipelines (which run a
specific `activeSchemaVersionId`) and skipped project scoping. Test mode now goes
through the same `resolvePipelineSchemaVersion` path the ingestion runner uses,
so a pinned pipeline tests against its pinned version and the schema lookup is
confined to the pipeline's project.

## 0.65.0 — 2026-07-08

**Dry-run a pipeline and see how a document routes: `koji pipeline test`.**
New `koji pipeline test <pipeline> <doc>` submits a document to the pipeline's
dry-run endpoint (`POST /api/pipelines/<slug>/test` — the same path the
dashboard's Test button uses) and prints how it routes **without persisting
anything**: each `classify` step's chosen label / confidence / method, which
route matched at every branch, the full path taken, and the final extraction.
It parses via the tenant's parse provider, matching production. This is the tool
for validating a router (a pipeline whose classify steps branch to different
schemas) — `koji pipeline run` gives you the real persisted run, `pipeline test`
shows you *why* a document went where it did. `--json` emits the raw result
(`steps[]`, `path`, `edgeEvaluations`). Gated by the `pipeline:write` permission.

## 0.64.0 — 2026-07-08

**Run documents through a pipeline from the CLI.** New `koji pipeline run
<pipeline> <doc…>` submits one or more documents (a file, several files, or a
directory) to a pipeline via the same manual-run path the dashboard uses — the
document is parsed, extracted, and routed exactly as production ingestion does,
creating a real job. By default it waits for every document to finish and prints
the extraction (`--provenance` to show the source snippet per field, `--json`
for machine-readable output); pass `--no-wait` to submit and return the job
slugs so an agent can poll later. The companion `koji pipeline result <jobSlug>`
fetches a submitted job's documents + extraction (`--wait` to block until done).
Works against a local cluster or the hosted platform, like the sibling `pipeline`
commands.

## 0.63.3 — 2026-07-08

**Space-mangled text-layer recovery now covers the hosted (Modal) parse path.**
The poppler `pdftotext` recovery added in 0.63.2 lived only in the self-hosted
docker parse service. This ports it to the Modal parse service that the hosted
cloud uses, so both backends recover Type-3 / custom-encoded PDFs identically.
No behavior change for self-hosted.

## 0.63.2 — 2026-07-07

**Recover text from PDFs with space-mangled text layers.** Some PDFs (notably
those built with Type-3 / custom-encoded fonts) store inter-word spacing as
glyph positioning rather than actual space characters. The in-process pdfjs
reader and docling's default backend both reconstruct spacing from run geometry
and drop it entirely on these fonts, so whole phrases collapse into one token
(`STATEFARMFIREANDCASUALTYCOMPANY`) and extraction silently reads garbage. The
parser now detects this long-token signature and re-extracts with poppler's
`pdftotext`, which resolves spacing at the glyph level — restoring both the text
and its word-level bounding boxes. The recovery runs inside the parse service
(where `poppler-utils` already ships) and is only accepted when it actually
unmangles the output.

## 0.63.1 — 2026-07-07

**Overview page is fully scoped to the selected project.** The dashboard
overview was already project-scoped for most tiles, but the Accuracy number,
the "validate regression" attention item, and the corpus / extraction /
validate onboarding steps still read tenant-wide — they queried tables
(`schema_runs`, `corpus_entries`, `extraction_runs`) that carry no project
association, so row-level security couldn't narrow them. These reads now join
the project-scoped schema, so every number on the overview reflects only the
project you're viewing.

## 0.63.0 — 2026-07-07

**`derived_from` can assemble an array from a set of fields.** A new
`assemble_array` derivation method maps a set of focused object (or scalar)
fields into a single array field, in listed order. Null/absent sources are
skipped, an array source is flattened one level, and an already-populated
target is left untouched. This lets a schema extract in a focused, reliable
shape — one object field per section — yet still emit Koji's uniform array
output, instead of a downstream adapter reassembling it. Provenance on object
elements is preserved. See the
[`derived_from` guide](schema-guide.md#deriving-fields-derived_from).

## 0.62.2 — 2026-07-07

**`koji validate` (and every remote command) now shows *why* a schema failed to compile.** A 422 from the API carries a `details[]` array — the specific compiler errors (e.g. "Map keys must be unique at line 391") — but the CLI printed only the top-level "HTTP 422: Schema validation failed" and swallowed the array, so the real cause was invisible. The shared error renderer now surfaces each `details[]` message on its own line.

## 0.62.1 — 2026-07-07

**`forms:` grammars now find every table region, on messier headings.** Two
region-carve bugs could make a form-table grammar seed nothing even when its
rows were plainly present in the parsed text. The anchor/end were matched
against the raw markdown while rows were matched against a normalized copy, so a
heading that came through with a pipe or a double space made the anchor silently
miss and the grammar return nothing. And only the first anchor-delimited region
was scanned, so a repeated structure whose sections are separated by an `end`
token seeded only the first section — or nothing when the first anchor landed on
boilerplate immediately followed by the `end` token. The whole document is now
normalized once so `detect`/`anchor`/`end`/rows all see the same text, and every
anchor region is scanned and unioned (deduped by match offset). This restores
the deterministic row floor — in particular a `union` grammar on a
`per_section` field now surfaces its seeded rows even when the model pass
returns nothing.

## 0.62.0 — 2026-07-06

**`forms:` grammars can `union` instead of replace.** A form-table grammar with
`mode: union` now keeps the LLM rows it didn't capture (matched by
`element_key`) rather than dropping them — parser rows still win on conflict.
This makes a partial grammar safe to ship: if the parse degrades and the table
comes through incomplete, the grammar enriches the model's rows instead of
deleting the ones it missed. The default (`mode: seed_rows`) is unchanged. See
the [`forms:` guide](schema-guide.md#deterministic-form-tables-forms).

## 0.61.2 — 2026-07-06

**Prompt-echo guard now catches reformatted numbers.** The hint-leak guard
previously only nulled string values copied verbatim from a field's own
extraction hint. A numeric worked example (e.g. a `"9,486.00"` premium) echoed
back by the model as `9486` slipped through, because the reformatted number
isn't a substring of the hint. Numeric scalars — and numeric-looking strings —
are now matched against hint literals *by value*, and nulled when they have no
source in the document. Only distinctive amounts (four or more digits) are
guarded, so small round examples aren't over-nulled, and any amount genuinely
present in the document is kept (its provenance protects it).

## 0.61.1 — 2026-07-06

**Clear error when a project has no model provider.** Running extraction or
validation in a project that hasn't configured a model endpoint now fails with
an actionable message — "No model provider is configured for this project. Add
one under Settings → Model Catalog" — instead of an opaque upstream `401`. The
env-var fallback (`OPENAI_API_KEY`) is unchanged for local development and seed
data.

## 0.61.0 — 2026-07-06

**Add/remove works for every member on the project Members tab.** Members with
all-projects access (everyone except workspace owners/admins) can now be
managed from a project's roster directly: changing their role or removing them
converts their implicit all-projects access into explicit per-project grants —
the edit applies here and they keep an equivalent role in every other project.
Previously the tab could only manage members who were already
project-restricted, and deployments whose workspace membership lives in an
identity provider had no way to restrict anyone. Owners and workspace admins
remain all-access by design (`400` if you try).

## 0.60.1 — 2026-07-06

**Correct-field pencils are always visible.** The correction affordance on the
document detail page no longer waits for a hover to appear — every correctable
field shows its pencil up front.

## 0.60.0 — 2026-07-06

**Manage a project's members from the project.** Project settings gain a
**Members** tab that shows who can access the project and their role, and lets
an admin add a member (with a role), change a role, or remove access — without
hunting through the workspace member list. Workspace admins (all-project access)
are shown for reference and managed from Settings → Members as before. Backed by
`GET`/`PUT`/`DELETE /api/projects/{slug}/members`.

## 0.59.0 — 2026-07-06

**Correct fields from the document page.** The document detail page now has
highlight-to-correct: hover a field in the extraction results, hit the pencil,
and either type the fix or "point on document" — drag over where the correct
value lives and the selection snaps to the text underneath. Corrections save
through the manual-corrections endpoint, so they're audited (`reason:
"manual"` review items), carry an anchored source highlight, and fire the
`document.corrected` webhook. Available on settled documents (delivered /
review / failed) for users with review permissions.

## 0.58.0 — 2026-07-06

**Documents page + `GET /api/documents`.** Documents are now findable without
knowing which job ingested them: a new Documents page in the dashboard
(sidebar, between Jobs and Review) lists every document in the project with
filename search, status/pipeline/date filters, facet counts, and infinite
scroll — the entry point for "find this document and fix it" correction
workflows. Backed by the new `GET /api/documents` endpoint (keyset pagination,
project-scoped, `hasPendingReview` flag on rows with open review items).

## 0.57.0 — 2026-07-06

**Manual corrections + `document.corrected` webhook.** Extraction errors the
review queue never flagged can now be fixed directly:
`POST /api/jobs/{slug}/documents/{docId}/corrections` corrects one or more
fields on a document, with optional anchored provenance (the same
highlight-to-correct geometry the review queue uses). Every correction is
recorded as an already-resolved review item (`reason: "manual"`) — full audit
trail, correction analytics, and promote-to-corpus all work unchanged. Each
call fires a new **`document.corrected`** webhook carrying the previous/new
value per field plus the full corrected extraction, so systems that consumed
`document.delivered` stay in sync (subscribable in Settings → Webhooks; on by
default for new targets). The embed preview token remains read-only — external
apps call the endpoint from their backend with an API key.

## 0.56.1 — 2026-07-06

**Fix: sidebar schema list no longer lags one project behind.** Switching
projects in the sidebar picker refetched the schema list before the navigation
committed, so the request was still scoped to the previous project and the
list only caught up after a manual page refresh. The schema list now refetches
after the project switch takes effect and always shows the selected project's
schemas.

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
