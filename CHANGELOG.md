# Changelog

Notable, user-visible changes. Newest first.

## 0.112.1 — 2026-08-24

- **Validate regressions now need a real decline, measured against what's
  live.** A field was flagged `regressed` on any decline at all, however small,
  against whatever validate run happened to go last — which could be another
  candidate, a different model, or a half-finished experiment. Accuracy moves on
  its own between identical runs, so the detector fired on **192 of 298
  production runs (64.4%)**, 396 flags in total, and since promotion is blocked
  on a non-zero regression count the gate stopped carrying information. Two
  changes: a decline must exceed the 1.5-point replicate-noise floor, and the
  baseline is the schema's **released** version rather than the previous run. A
  decline under the floor is still reported as `failing` with its delta —
  nothing is hidden, it just no longer blocks a promotion. A schema with nothing
  released has no baseline and cannot be flagged.

## 0.112.0 — 2026-08-24

**Review items now record whether a human corrected the value or accepted it.**
Accepting an extraction and correcting one both resolved as `approved`, so the
two were indistinguishable in the data — the only way to tell them apart was
diffing the final value against the proposed one in JSON, which is unreliable
for lists and objects and impossible to aggregate. That made "how often does
Koji's output need fixing?" unanswerable, which is the single most useful thing
a review queue can tell you.

Review items carry a new `edited` field, set by the endpoint that knows the
answer, and returned by the review list and detail APIs. Existing resolved
items are backfilled from the value comparison, which reconstructs the
distinction exactly for them. The review queue now shows *corrected* rather
than *approved* for those items.

`resolution` deliberately still reads `approved` for both. Promotion to corpus
gates on it, so splitting it would have quietly stopped corrected items — the
most valuable ground truth there is — from ever reaching the corpus.

## 0.111.3 — 2026-08-24

**Stuck validate runs are now cleaned up — and the stuck-job sweeper actually
runs.** A validate run whose fan-out died sat in `running` forever: nothing
watched `schema_runs`. That left the run showing as never-finishing in
`koji validate` and the Validate UI, and — because an unchanged schema reuses
its persisted run rather than starting a new one — could make a schema look
permanently un-validatable. Runs that pass a generous ceiling (one hour) are
now failed with a reason, keeping any error the run had already recorded.
Queued runs that were never picked up are swept the same way.

While adding it we found the existing stuck-job sweeper had never worked:
every sweep threw before touching a row, because its timestamps were bound in
a form the database driver rejects. Its tests replaced the database with a
stub, so nothing caught it. Both sweepers now run against a real database in
the test suite.

## 0.111.2 — 2026-08-24

**API keys now record when they were last used.** The keys list and the
dashboard have always shown a "used <time ago>" column, but nothing ever wrote
the underlying timestamp — so it read empty for every key ever issued,
including keys driving tens of thousands of documents a month. That made
rotation and offboarding guesswork: a key still in daily use looked exactly
like one abandoned months ago. A key's timestamp is now stamped when it
authenticates, throttled to at most one write every five minutes so a
high-volume key doesn't pay for it on every request.

## 0.111.1 — 2026-08-24

**Job document counts now describe the present, not everything that ever
happened.** A job's processed / passed / failed / in-review counts were bumped
by one at every terminal transition and never adjusted afterwards, so a
document that failed on bad input and later succeeded stayed counted as failed
forever, and a document reprocessed three times was counted three times. The
totals drifted above the number of documents that actually existed, and because
these are the numbers `koji pipeline ls` and the dashboard show, every failure
rate read off them was overstated.

The counts are now derived from the documents themselves whenever a document
settles, so each document lands in exactly one bucket — the one matching where
it stands now. Reruns move a document between buckets instead of adding to the
totals, and any job whose counts had already drifted repairs itself on its next
write.

## 0.111.0 — 2026-08-24

- **Validate reports array quality at the element level.** A document passes a
  validate run only if every field matched exactly, so a ten-row four-column
  table extracted at 99% per-cell accuracy was recorded as a flat failure and
  `docs passed / total` saturated precisely where array work happens — an
  87%→56% band on that measure is consistent with a large per-cell improvement
  and with none. Runs now report element counts, run-wide and per field:
  `exact`, `changed` (row found, a sub-field differs), `missing` (row never
  found — the recall loss) and `extra` (row invented — the precision loss).
  Shown on the `koji validate` output and the Validate page, and available as
  `elements` / `fields[].elements` under `--json`. Document pass/fail is
  unchanged: it still means "zero errors anywhere in the document".

## 0.110.7 — 2026-08-24

**Retrying a document on a DAG pipeline now works.** A retry re-walks the
pipeline from its entry step, but each step's result was written with a plain
insert into a table that is unique on (document, step) — so the first step the
previous attempt had already recorded failed the write, and with it the whole
retry. Every subsequent attempt failed the same way until the retry budget was
gone, leaving the document stuck mid-run and its job never marked failed. The
practical effect was that *no* transient error on a DAG pipeline was ever
recoverable: a momentary model timeout or parse-provider blip stranded the
document permanently. Step results are now upserted, so a retry overwrites the
previous attempt rather than colliding with it, and a step that failed once and
succeeds on retry no longer keeps the stale error text beside its new result.

## 0.110.6 — 2026-08-24

- **A validate run that couldn't have measured anything now fails instead of
  publishing a number.** Finalization treated "the runner didn't throw" as
  success, with no check on the result itself. That recorded runs scoring
  exactly 0.0000 over a 50-document corpus as the schema's accuracy, and — more
  quietly — recorded runs that scored *nothing at all* as 100%, since nothing
  is failing when no comparison is made. Both now finalize as `failed` with the
  reason attached, and the result is still stored so the failure stays
  diagnosable. Duration is deliberately not gated: a slow run is not a wrong
  one.

## 0.110.5 — 2026-08-24

**A pipeline's reported cost now matches its estimate.** Step prices lived in
three separate tables — the shared one the estimate is built from, and a private
copy inside each of the two runners — and they had drifted apart. The DAG runner's
copy was missing seven step types (`redact`, `enrich`, `validate`, `summarize`,
`compare`, `merge_documents`, `resolve_references`) and the test endpoint's was
missing one. A pipeline containing any of them was quoted one price on the editor
and reported another on the run: `resolve_references` was estimated at $0.02 and
reported $0 by both the test panel and production.

There is now one table. Both runners read it through a shared lookup, and it is
typed so that declaring a step type without pricing it fails the build — the
drift can't recur silently.

This changes the cost **shown** on the document trace page, job listings, and the
pipeline test panel. It does not change what anyone is charged: invoicing runs off
billable events, not these figures.

## 0.110.4 — 2026-08-24

**Testing a pipeline now actually resolves cross-document references.** The
`resolve_references` step ran four things in production — scan the document for
reference phrases, index every sibling document in the group, resolve each
reference by section title then by filename, and compare extracted values across
the group for contradictions. Clicking **Test** ran only the first. Every
reference came back `resolved: false` with the method `detected_in_test`, the
`contradictions` key production always returns was missing entirely, and the note
said the references "would be resolved" in production. So the one step whose
whole purpose is to look at the rest of the group was the one step Test never
showed you anything about — however the group was configured, the answer was
always nothing.

Test mode now runs the same resolution, against the same group, with the same
model — because both callers now share one implementation instead of carrying
two. The only remaining difference is the documented one: production stores the
result on the document row and Test does not.

Two smaller consequences of the shared path:

- **A test run needs a group to resolve against**, the same way a real run does.
  Pass it as the `group` form field or the `X-Koji-Group` header — the same two
  sources the run endpoint already accepted. Without one, the step says so and
  tells you what to pass, rather than reporting zero references as though it had
  looked.
- **A section with a blank title no longer swallows every reference.** Matching
  tested `reference.includes(title)`, which is always true for an empty title, so
  a single untitled section in a sibling document could claim every reference in
  the document and report them all resolved to it.

## 0.110.3 — 2026-08-24

- **Array confidence no longer credits a validation that never ran.** Every
  extracted field is scored `0.70·provenance + 0.30·validation`, but for an
  array the validation term was the literal value `true` — arrays skip the
  per-field type validation scalars go through, so a list collected the full
  0.30 unconditionally. The remaining 0.70 is a substring provenance hit on the
  field as a whole, which lands almost always over short numeric strings
  (limits, dates, form codes), so an array of rows that violated every type the
  schema declared could still score near 1.00 and auto-deliver. The term is now
  the share of the elements' declared, present sub-fields that actually satisfy
  their declared types. Absent sub-fields are not failures, and an array whose
  schema declares no element shape is unchanged — as is any array whose
  elements all validate.

## 0.110.2 — 2026-08-24

**A fifth place in the engine knew what documents are called.** 0.110.0 said the
engine no longer contains domain logic; the `resolve_references` pipeline step
still did. When a cross-document reference ("see the Bylaws", "refer to the Bill
of Lading") didn't match a section title, the fallback matched it against a
hardcoded list of ten document-type words — `bylaws`, `ccr`, `cc&r`, `rules`,
`regulation`, `budget`, `policy`, `agreement`, `amendment`, `addendum`. A
reference to any word outside that list resolved as `unresolved`, so the step
worked for community-association and insurance paperwork and quietly did nothing
for a lab report, a bill of lading, a permit, or a datasheet.

The fallback now matches the words the reference *itself* uses against the words
in each sibling document's filename — singular/plural tolerant, camelCase-aware
(`MasterLease-signed.docx`), and punctuation-insensitive so `CC&Rs` still finds
`CCRs.pdf`. Every reference the old list resolved still resolves; references it
had no word for now resolve too. Which words name a document is a property of
your corpus, not of the engine.

**Repo hygiene.** A one-off debugging script (`api/parity-probe.mts`) had been
committed with an absolute path into a private working tree; it is deleted.
Named companies used as filler in test fixtures and code comments were replaced
with neutral ones — no test behavior changed.

## 0.110.1 — 2026-08-24

**Dashboard placeholder copy is no longer insurance-branded.** The example text
in the form-mapping, project, pipeline, and classify-label inputs named ACORD
25, "Insurance Claim", "Claims Intake", and `certificate_of_insurance`. Koji
processes any document, and the first thing a new user reads should not imply
otherwise. The engine itself was cleared of domain logic in 0.110.0; this is the
same change to what the product says out loud.

## 0.110.0 — 2026-08-23

**The engine no longer contains insurance domain logic.** Koji is a generic
document platform: what a document *is* belongs in your schemas and
classifiers, not in the engine. Four places had drifted from that, and each of
them made the product quietly worse at every industry except one.

- **The schema builder proposed a canned vertical template.** A hardcoded regex
  classified the uploaded document as one of eight built-in types and seeded the
  editor with a matching template — so a lease, a lab result, a bill of lading,
  or a permit got an empty skeleton, while any document that mentioned "policy
  number" was offered insurance fields (carrier, named insured, premium). The
  first draft is now built from the document's own labels, with field types
  inferred from the shape of each value, and the document type (when shown) comes
  from the model rather than a regex. The eight built-in templates are gone.
- **Key-value extraction recognised insurance labels specifically.** The test for
  "is this a label" carried the words `policy`, `insured`, `carrier`, and
  `premium`, so a lowercase label was kept for one industry and dropped for every
  other. It is now structural — capitalisation, or a short data-shaped pair — and
  `specimen id`, `container no`, and `monthly rent` are kept exactly as
  `policy number` was. The "has names" summary likewise tests for the shape of a
  proper noun instead of a list of insurance roles.
- **Form fingerprints were boosted only for insurance forms.** High-signal terms
  came from a fixed list (`ACORD 25`, `certificate of liability insurance`,
  `declarations page`); every other form had to be matched on frequent-word
  overlap alone. Fingerprints now take the form's own title line and its printed
  form code, so a CMS-1500, a W-9, a bill of lading, or a building permit each
  get the same quality of identifier an ACORD 25 always had. Existing stored
  fingerprints are matched against raw incoming text and are unaffected; only
  newly activated mappings fingerprint differently.
- Insurance illustrations in engine comments and doc examples were replaced with
  neutral ones. Test fixtures keep their domain data — that's test data.

## 0.108.5 — 2026-08-22

**Fix: `koji validate --no-push` validates the version that is actually live.**
It took the schema's highest version number, which is an unreleased candidate
the moment anyone has run `koji validate` once — that run snapshots an rc, and
the rc outranks the release. So the mode documented as validating "the version
already live on the server" quietly scored a candidate. Comparing a local file
against `--no-push` was then comparing two different schemas, which can differ
in which fields they even declare. It now resolves the released version, falling
back to the newest and then the draft for a schema that has never been released.

**A ground-truth field the scored schema doesn't declare is reported `not in
schema`, not as a 0% failure.** The scorer reports every field ground truth
carries, including fields the schema being validated has no field for — nothing
is extracted for them, so they scored 0% and, against a version that did declare
them, showed up as a large regression. They are still reported and still
counted, since a field an edit *removed* is a real change; they're just no
longer labelled as extraction failures or counted among regressions.

**A validate run says what it scored.** Every run was labelled "candidate · not
live", including `--no-push` runs, which score the live release.

## 0.108.4 — 2026-08-22

**Fix: `koji pull` reads the project you selected.** It built its own request
headers and never sent `x-koji-project`, so it always read whatever project the
API key itself is bound to — regardless of the profile's project or
`KOJI_PROJECT`. Against a key bound elsewhere it wrote a different project's
schemas into your working directory and reported success. `push` and `pull` now
share the one resolver every other remote command uses.

**Every command says which project it is targeting, and every API response says
which project answered.** Scope resolves from three places at once — a
`KOJI_PROJECT` env var, the profile's `project`, or the API key's own binding
when neither names one — and nothing printed which of them won. Commands now
announce the scope they resolved (`project: acme-policy (from profile
'acme-policy')`, or `project: unset … — the API key's own project decides`), and
authenticated responses carry an `x-koji-project-resolved` header naming the
project the server actually used. `push` and `pull` report it when it differs
from what was asked for, or when nothing was asked for at all — the case where
a write lands somewhere you weren't looking.

## 0.108.3 — 2026-08-22

**Fix: `koji classify run` no longer truncates a PDF to 3 pages by default.**
The command sliced every multi-page PDF to its first 3 pages before upload, a
measure meant only to stay under the API's request-body limit. It bought
nothing on a normal file — the server reads only the pages a classifier's
`window`/`scan` select, however long the document is — and it silently defeated
any classifier whose window reached past page 3: the keyword tier never saw the
pages carrying its signals, so `classify run` reported `unknown` while the
pipeline, which gets the whole document, labelled it correctly. Documents are
now uploaded whole; only one that exceeds the upload limit is sliced, and then
to the window's own depth rather than an arbitrary prefix. A `head_and_tail`
window is never sliced from the front. `--max-pages N` still forces a slice and
now warns when N is below the window; `--max-pages 0` sends everything.

The help text also no longer calls the command "a faithful proxy for how the
pipeline will route the document" without qualification — a pipeline classifies
the document its parse step produced, and a sliced upload can score differently
from the whole one. Both caveats are now stated where they're read.

## 0.108.2 — 2026-08-22

**Fix: configuring a BYO parse endpoint no longer silently disables the
classifier's vision tier (and page analysis, PDF slicing, and provenance
bboxes).** A tenant's own parse provider replaces *text extraction*; it was
also replacing the platform's PDF utilities. No BYO driver (Google Document AI,
Azure Document Intelligence, Textract, Mistral OCR) implements the optional
`pageImages` / `analyzePages` / `slicePdf` / `extractCoordinates` methods, and
the composed provider bound those capabilities from the tenant's provider
alone — so they became `undefined`, with no error. The most visible symptom:
a scanned PDF with no text layer returned `unknown` from a `classify` step in
tens of milliseconds, because tier 4 (vision) needs a renderer and there wasn't
one. The same document classified correctly through `POST /api/classify`, which
used the global default provider. The backend-derived provider is now the
capability fallback, so a BYO endpoint changes how text is extracted and
nothing else.

**A classifier that returns `unknown` now says why.** The outcome carries a
`reason` naming the tiers that couldn't run and what was missing ("no
extractable text layer…", "vision tier skipped: the parse provider cannot
render page images", "vision tier not allowed by maxTier=3"). It appears as
`reason` on `POST /api/classify` and as `reasoning` on a pipeline's classify
step output. "The classifier looked and couldn't tell" and "the classifier
never got to look" were previously indistinguishable — both routed the document
down the `default` edge.

**Fix: `/page-images` on the self-hosted parse service actually renders pages.**
It rasterized with PyMuPDF (`fitz`), a dependency declared in neither parse
image, inside an `except (ImportError, Exception): return []` — so every request
answered `{"images": [], "pages": 0}` with HTTP 200 and the vision tier had
nothing to look at. Pages now render through pypdfium2, which the image already
carries, and a render failure is a 422 with the reason instead of an empty
document. (Modal-backed deployments were unaffected; they render elsewhere.)

**All three classify surfaces now resolve the parse provider the same way.**
The ingestion DAG's classify step reached past the provider its own parse had
resolved to the process-wide default; the standalone route used the global
default; the pipeline dry-run used the resolved one. They now share one
resolution path, so a dry-run and a real run can't disagree about which
provider looked at the document.

## 0.108.1 — 2026-08-06

**Fix: documents whose page tree pdf-lib undercounts no longer fail to parse.**
Some real PDFs — hybrid-reference files that carry both a classic xref table and
an `/XRefStm`, as produced by Word — resolve some object numbers to the wrong
objects under pdf-lib. It walks part of the page tree, skips what it can't
interpret, and returns a short page count **with no error**. A 76-page policy
counted as 11 pages, which routed it to a single Google Document AI online call
that Doc AI rejected (`PAGE_LIMIT_EXCEEDED`), failing the document with the
misleading message "the document produced no extractable text". Page counting
now cross-checks pdf-lib's traversal against the page tree's declared `/Count`
and against pdfjs, and any document pdf-lib cannot walk in full is normalized
through the parse service before slicing. This was also a silent-corruption
risk, not only a failure: pdf-lib's view of that document held 19,875 of its
179,112 characters, so slicing it would have produced a confident extraction
missing 86% of the document.

**Fix: an oversize rejection from Document AI is now recoverable.** When Doc AI
rejects a request for exceeding its page limit it reports the page count it
actually saw. That number is now used to re-route the document through the
slicing path — at a slice size small enough to be genuinely smaller than the
rejected request — instead of failing the document.

**Fix: a usable parse is no longer discarded when the fallback parser fails.**
When pdfjs output looked fragmented, the parser fell back to the heavy provider
and let any failure there propagate, throwing away text it already had. The
document then reported as empty. The pdfjs result is now kept when the fallback
fails.

**Fix: parse failures name their cause.** A document whose parse threw reported
only "the document produced no extractable text (parse returned empty)" — a
symptom that hid the real error in the server logs. The underlying parse error
is now carried into the failed step, so the trace page shows it.

## 0.108.0 — 2026-08-06

**Feature: zoom, search, rotate, download, print and fullscreen in the
embeddable PDF viewer.** The embed previously offered page navigation, the
highlight toggle, the field picker and region selection; everything else a
reader reaches for was missing. Six new tools join `select` behind the same
`?tools=` opt-in, so each embed shows only the controls its host asked for and
nothing changes for existing embeds:

- **`zoom`** — − / % / + controls, Ctrl/Cmd + wheel, and trackpad pinch. 100%
  is fit-to-width; the range is 25–400%.
- **`search`** — find-in-document across *every* page, not just the rendered
  ones. The browser's own Cmd/Ctrl+F can only see pages currently in the DOM,
  which in a long document is nearly none of it; with the tool on, Cmd/Ctrl+F
  opens this search instead. Hits are highlighted in place with prev/next.
- **`rotate`** — 90° per click, for sideways scans. Highlights rotate with the
  page, and a region selection made on a rotated view is still reported in the
  document's native orientation.
- **`download`** / **`print`** — act on the original PDF, so a print is the
  real document rather than the pages that happen to be on screen.
- **`fullscreen`** — needs `allow="fullscreen"` on the host iframe; the button
  hides itself when the host withholds it.

`?tools=all` enables everything. Unknown tool names are ignored rather than
rejected, so an embed URL naming a newer tool keeps working on an older Koji.

New messages, each gated on its tool: inbound `koji:setZoom`,
`koji:setRotation`, `koji:search`, `koji:searchNext`, `koji:searchPrev`;
outbound `koji:zoomChanged`, `koji:rotationChanged`, `koji:searchResults`. The
echoes fire for host-driven changes too, so a parent mirroring the controls in
its own chrome stays in sync. See [Viewer tools](docs/integration.md).

The self-serve region-selection crosshair moved from beside the field picker
into the toolbar's tool group, alongside the new buttons.

## 0.107.3 — 2026-08-05

**Fix: the overview "Processed" tile counted 0 for router pipelines.** The metric
joined documents to schemas on `schema_id`, which is null for every document a
router/DAG pipeline produces — the join scoped the count to the project and, by
being an inner join, silently discarded the entire router corpus. A project with
thousands of processed documents read `0 docs`. The count now scopes through
`jobs` instead, and counts only documents in a terminal, extracted state
(`delivered` or `review`) rather than every row including in-flight ones.

**Fix: router-extracted documents record the schema they were extracted with.**
A router pipeline resolves its schema per document at extract time, but the
resolved schema and version were never written back to the document row — they
were known only to the review item it filed. Finished documents now record both,
so anything joining documents to schemas sees them. Existing documents keep
their null `schema_id`; this applies going forward.

## 0.107.2 — 2026-08-04

**Fix: DAG pipelines record billable events.** Documents finishing under a DAG
pipeline reached `delivered` or `review` without recording a billable event —
only the simple single-schema path did. On metered deployments that made every
DAG-processed document invisible to usage reporting while still incurring full
parse and extract cost. Both entrypoints now record through one shared helper.
Split parents remain unbilled, since their child documents bill individually.

## 0.107.1 — 2026-07-24

**Fix: object-valued fields are scored structurally in `koji test`/`bench`.** The
comparator's fallback for object-valued fields used a brittle
`str(expected) == str(actual)`, which failed on differing key order or an inline
`__source_text` provenance key even when the data was identical. It now compares
via the same normalization used for arrays — order-insensitive and
provenance-stripped — so object fields score correctly.

## 0.107.0 — 2026-07-24

**Classifier Corpus + Validate tabs in the dashboard.** The classifier detail
page gains the schema tab idiom — Config → Corpus → Validate. The Corpus tab
labels documents by picking a class from a dropdown (upload, attach from the
shared project pool, or auto-label unlabeled documents via bootstrap, then
approve drafts). The Validate tab runs a backtest and renders the confusion
matrix, per-class precision/recall/F1, the tier histogram + escalation rate,
cost, and flips vs. the previous run.

## 0.106.0 — 2026-07-24

**Agent-assisted classifier corpus labeling.** `koji classify corpus bootstrap`
(and `POST /api/classifiers/{slug}/corpus/bootstrap`) runs the classifier at
`max_tier: 4` over unlabeled pool documents and writes each result as a **draft**
label — labeling becomes reviewing a list instead of filling one in.
`koji classify corpus approve` accepts a draft (with `--label` to correct it
first), promoting it into the scored ground truth. A draft is never scored by a
backtest until approved, so the classifier is never graded against its own
guesses; draft rows are marked `authored_via_agent` for audit. The classifier
corpus list now surfaces `proposedLabel` / `reviewStatus` / `authoredViaAgent`.

## 0.105.0 — 2026-07-24

**Gate a classifier promotion on no regressions.** `POST /api/classifiers/{slug}/promote`
(and `koji classify promote`) now accept a regression gate that refuses to
promote a candidate whose latest backtest regresses a class vs. the live
release — so tuning that lifts one class can't quietly cost another.
`--require-no-regressions` blocks any class dropping; `--must-not-regress <class>`
guards named classes; `--min-recall`/`--min-precision` (`class=0.9`) set absolute
floors. A blocked promotion lists each offending class with its before → after
numbers. The candidate is compared against the live release's most recent
backtest; a gate with no backtest to evaluate is refused rather than passed
blindly. `koji classify release` remains the explicit un-gated bypass.

## 0.104.0 — 2026-07-24

**`koji classify validate` — backtest a classifier from the CLI.** Mirrors
`koji validate`: it classifies every labelled corpus document through the same
cascade production uses and renders accuracy, per-class precision/recall/F1, the
confusion matrix, the tier histogram + escalation rate, and flips vs. the
previous run in the terminal. `--version` pins a version; `--check` exits
non-zero if any class regressed (for CI loops). Adds `koji classify corpus
ls/add/rm` to manage the classifier's label-based backtest corpus — `add`
uploads and labels a document in one step, reusing the shared project pool.

## 0.103.0 — 2026-07-23

**Backtest a classifier against its corpus.** `POST /api/classifiers/{slug}/validate`
classifies every labelled corpus document through the same cascade production
uses and scores predicted vs. ground truth — the classifier sibling of schema
validate. The result carries accuracy, per-class precision/recall/F1, the
expected→predicted confusion matrix, the tier histogram + escalation rate (the
share of documents that needed the paid LLM/vision tail), and flips vs. the
previous run. Backtests the released version by default, or a pinned one via
`{ "version": … }`. For large corpora, `{ "async": true }` fans the work out one
document per job and returns a `runId` to poll at
`GET /api/classifiers/{slug}/validate/runs/{runId}`;
`GET /api/classifiers/{slug}/validate` returns the latest completed run.

## 0.102.2 — 2026-07-23

**Fixes "API key not found" when editing a key from workspace settings.** The
workspace API Keys page lists every key in the workspace, but editing and
revoking still filtered by whichever project the session happened to have
selected — so a key bound to a *different* project was listed, and saving it
answered `API key not found`.

Management now follows reach rather than the selected project: an unrestricted
member manages any key in the workspace, and a member confined to a subset of
projects may manage a key only when every project that key reaches is inside
that subset. That also closes a hole in the old rule, where a project-restricted
member could revoke an all-access key other projects depended on, because such a
key is "visible from" every project.

## 0.102.1 — 2026-07-23

**Fixes API Keys being unreachable in the hosted console.** 0.102.0 moved API
key management to workspace settings, but put the nav link inside the block
that a host suppresses with `hideDefaultNav` — which the hosted console sets,
because Clerk's OrganizationProfile replaces General/Members there. The page,
its route, and its re-export all existed; nothing linked to it. The link now
renders regardless of that flag, since API keys are a Koji resource with no
Clerk equivalent, and a test pins it outside the block.

## 0.102.0 — 2026-07-23

**API keys are managed at the workspace level, and their project access is
editable.** A key can span projects — an all-access key belongs to no project at
all — so managing them from inside a project was the wrong shape: a
multi-project key appeared once per project it touched, and there was no single
place to see every key in the workspace.

- **API Keys moved to Organization → Settings → API Keys.** The old
  per-project path redirects, so existing links keep working. The list is now
  workspace-wide and every key shows its project access, not just the
  non-default ones.
- **`PATCH /api/api-keys/{id}`** changes a key's name and/or `project_scope`
  using the same block create takes. Scope used to be fixed at creation, so
  widening a key meant revoking and reissuing it — forcing every consumer to
  rotate a secret that didn't need to change. The secret is never touched;
  only the key's reach. Granting *all projects* requires a caller who can
  already reach every project.
- **A too-narrow key now says so.** Naming a project outside a key's scope
  returned `404 Project not found` — indistinguishable from a typo, and the
  usual cause is your own key being narrower than you remember. It now returns
  `403` naming the actual problem. A slug that doesn't exist in the tenant
  still returns `404`, so no key can enumerate another tenant's projects.

Worth knowing, because it is the trap this release exists to fix: **"specific
projects" is a fixed list, not a standing rule.** A key scoped to a chosen set
does *not* pick up a project created later — only *all projects* does. The
scope editor now says this in the dialog, and you can move a key between the
two modes without reissuing it.

## 0.101.2 — 2026-07-23

**Build mode works in every project, not just the default one.** Clicking **Run**
on a schema's Build page failed with *Corpus entry not found* for every document
in the schema — but only in projects other than the workspace's default one. The
Build page sent its extraction request without the project header, so the server
resolved the document under the default project, where it doesn't exist. The
document list, validate runs, and the corpus labeling queue were unaffected,
which made the failure look like missing data rather than a mis-scoped request.

The page now runs extractions through the same shared runner the corpus labeling
queue uses, so there is one place that assembles these headers. A test keeps
tenant-scoped pages from hand-rolling their own API calls again.


## 0.101.1 — 2026-07-23

**An existing credential's scope can be changed in place.** 0.101.0 let you
*create* a credential shared across projects, but gave no way to share one you
already had — and since a stored key can never be read back, "delete it and
re-add it as shared" would have meant re-typing a secret you may not have. Both
settings pages now offer **share with all** / **unshare** on each credential,
backed by `scope` on `PATCH /api/model-providers/:id` and
`PATCH /api/parse-providers/:id`. The key is never touched; only its reach
changes. Sharing still requires a member who can reach every project, and a name
collision in the target scope is reported as a conflict rather than a constraint
violation.

## 0.101.0 — 2026-07-23

**Model and parse credentials can be shared across every project.** Until now a
credential belonged to exactly one project, so a new project started with no way
to reach a model and no parse engine — every key had to be re-entered per
project, and a project created for a new workstream silently fell back to the
built-in parse engine while its siblings used a configured OCR vendor.

- **Add credential** and **Add parse endpoint** now take an **Available to**
  choice: *This project only* (the default) or *All projects in this workspace*.
  A shared credential has no owning project and is usable from every project,
  including ones created later.
- **A project-scoped credential overrides a shared one for that project**, and
  only for that project. Resolution prefers a credential belonging to the
  current project and falls back to the shared one; deleting the override falls
  back to shared again. The same rule applies to parse endpoints.
- The settings pages badge shared credentials with **all projects**, so it's
  clear which ones reach beyond the project you're looking at.
- Changing or deleting a shared credential requires a member who can reach every
  project — a member confined to a subset of projects gets a 403 rather than
  silently pulling a credential out from under the others.
- Making a parse endpoint the default now demotes only the others **in the same
  scope**. Promoting a project's endpoint no longer disables the workspace-wide
  default that other projects resolve through, and a project's first endpoint is
  no longer created disabled just because a shared one is already active.

Under the hood, `model_endpoints`, `parse_endpoints`, and `provider_credentials`
move to the null-aware project RLS policy already used by `api_keys` and
`notifications`: `project_id IS NULL` means workspace-wide. Cross-project and
cross-tenant isolation is unchanged and covered by new round-trip RLS tests —
a credential scoped to one project is still invisible from every other.

## 0.100.1 — 2026-07-23

**A deleted credential could still be the one extraction used.** Deleting a
model or parse credential stamps `deleted_at` and leaves `status` at `active`,
but resolution filtered only on `status` — so every credential a project had
ever deleted stayed in the candidate set, and which one won was left to the
query planner. A project that had added and removed a credential or two could
resolve a dead one (or one that never had a key) while its settings page, which
does filter deleted rows, showed the working credential the whole time.

- Model and parse resolution now exclude soft-deleted rows, on both the
  "first active credential" path and the pipeline-pinned path, and order
  candidates by `created_at` so the pick is deterministic. A pipeline pinned to
  a credential you deleted no longer keeps using that key.
- Deleting a credential now soft-deletes **every** model attached to it. A
  credential added with both chat and vision capabilities left its vision row
  alive, pointing at a deleted credential.
- `POST /api/model-providers` rejects an `openai`, `anthropic`, or
  `azure-openai` credential with no `api_key` (`custom` and `ollama` are
  unchanged — they can legitimately have none). Previously it stored one that
  listed like any other and failed at call time with an upstream 401.
- A credential whose name collides with an existing one in the project returns
  409 with a readable message instead of a 500 with a SQL dump in it.
- `GET /api/credentials` returns `hasKey` and `credentialStatus`, and the Model
  Endpoints page badges a credential that holds no key (or one that no longer
  decrypts) instead of drawing it identically to a working one.

## 0.100.0 — 2026-07-23

**Classifiers can hold a corpus and be backtested — the schema-sibling of schema
ground truth.** New endpoints label documents with the class they *should* be
assigned, so a classifier config can be tuned against known-correct answers
instead of guessing:

- `GET/POST/DELETE /api/classifiers/{slug}/corpus` — list, label, and remove
  labelled documents. A label must be one of the classifier's released class
  ids, or `unknown` ("this document should fall through"). `POST` takes either a
  multipart `file` upload or a JSON `{ document_id, label }` referencing a
  document already in the pool.
- `GET /api/corpus/documents` — the project's shared document pool. Corpus
  documents (schema and classifier alike) now live in one project-level pool, so
  a file uploaded once can be labelled for a schema *and* a classifier without
  re-uploading. Attach it by `document_id`.

This is the API layer of the classifier backtest surface; the validate run that
scores a config against these labels (with a per-class confusion matrix) follows.

## 0.99.3 — 2026-07-22

**Scalar array fields now return scalars.** A field declared as an array of
plain values (`type: array` with `items: { type: string }`, or with no `items`
block at all — e.g. a list of names) was being returned as an array of
single-key objects like `[{"medication": "Celebrex"}]` instead of
`["Celebrex"]`. The cause was an extraction-prompt instruction that asked for
per-item `__source_text` provenance on *every* array, which told the model that
array elements were always objects — so it wrapped even bare values, and the
declared scalar shape was impossible to satisfy. Per-item provenance is now
emitted only for arrays whose items are objects; scalar arrays keep the
top-level source-text mapping the prompt already produces. Measured effect on a
medical-records schema with two scalar-list fields: field accuracy on those
fields rose from 17% to 75%, and overall from 63.9% to 83.3% (+19.4pp), with no
change to object-array behaviour.

## 0.99.2 — 2026-07-22

**Prompts are now budgeted against the model's real context window instead of a
hardcoded 128k.** `promptFits` / `promptCharBudget` accepted a context size but
every call site took the default, so an 8k model was handed prompts sized for a
128k one. Every provider now reports a `contextTokens` window and the extraction
budgeter splits against that number. Declare a non-default window on a model
endpoint with `context_tokens` in its config (see
[Configuration](docs/configuration.md#model-endpoint-context-window)).

**Ollama no longer silently discards most of the prompt.** The Ollama request
omitted `num_ctx`, so the server fell back to its own small default and dropped
everything past it — no error, no warning. A 90,125-token prompt came back with
`prompt_eval_count: 8192`: 91% of the document read as if it weren't there, and
the missing fields looked like the model finding nothing. Koji now sends
`num_ctx` and defaults an Ollama endpoint to an 8,192-token window; raise it
with `context_tokens` if your local model supports more. Expect a local model to
split a large document into more calls than before — that is the fix.

The completion reserve is now derived from the window rather than being a flat
16,384: providers send exactly the number the budgeter subtracts, and a
small-window model reserves proportionally less instead of producing a negative
prompt budget.

**A dropped connection no longer looks like an empty extraction.** Providers
issued one `fetch`, checked the status, then read the body — and a socket abort
*during the body read* threw a plain network error that matched neither the
systemic-error nor the context-length classifier. Group extraction caught it and
returned `{}`, so a transient blip was indistinguishable from "the model found
nothing": fields landed in review as genuine nulls, and array fields
under-reported their rows.

Provider calls now retry the whole round trip — request *and* body read —
through bounded exponential backoff, covering network errors, timeouts, `429`,
and `5xx`. When the retries are exhausted the call raises a
`ProviderTransportError`, and group extraction, gap-fill, and row enumeration
surface it instead of swallowing it. A failed document now reports a failure.
Genuine `4xx` responses and the context-length re-split path are unchanged.

## 0.99.1 — 2026-07-22

**Releasing content that matches an existing candidate no longer 500s when that
version number is already released.** `releaseDirect` graduates a hash-matched
candidate by clearing its prerelease, which makes it a *release* at that
`x.y.z`. If a release already occupied that slot, the partial unique index
rejected the update and nothing caught it, so the caller got a bare `500`.
`graduateCandidate` had always checked for the clash; `releaseDirect` never did.
It now refuses with the same `409` ("a release already occupies that version")
instead of failing opaquely.

Reproduced from a real schema that carried both a released `v1.0.2` and a
`v1.0.2-rc.1` candidate holding the content being pushed — the exact shape that
produced an unexplained `500` during a bulk `koji push`.

## 0.99.0 — 2026-07-22

**`POST /release` no longer silently releases the stored draft when it cannot
read your request.** The release routes did `body.yaml ?? storedDraft` over a
body parsed with a `.catch(() => ({}))`, so three different situations collapsed
into "use the draft": no body (intended), a body whose YAML arrived under a key
the route doesn't read, and a body that wasn't valid JSON. The last two released
**draft content the caller never sent**.

This bit in production: a 52 KB schema posted under the wrong field name
released a 3.8 KB stored draft, and the 0.95.3 rollback guard then reported a
content match against that draft — advice that, if followed with
`allow_reactivate: true`, would have activated the stub. A safety rail
recommending a destructive action.

Now: the stored draft is released **only when no body is sent at all**. An
unrecognized field, malformed JSON, a non-object body, or a null/empty `yaml`
are each a `400` naming the problem. `yaml_source` is accepted on the schema
route (and `yaml` on the classifier route) so the two siblings stop diverging on
field names.

**`409 requires_reactivate` now reports what was actually hashed** —
`hashed_bytes` and `hashed_sha256_prefix`. If those don't describe the payload
you sent, your content never reached the matcher, which is otherwise invisible
from the response.

**Content-hash matching is now deterministic.** The lookup used `.limit(1)` on
an unordered scan, and nothing constrains `yamlHash` unique; if several versions
shared content, an arbitrary row was picked — which could report a spurious
"reactivate" when the live release carried that same content. It now prefers the
live release, else the earliest version.

## 0.98.1 — 2026-07-22

**Docs: classifying a large document never required skipping it or slicing it.**
Three capabilities already existed but were not connected in the reference, so
an integration hit the 4.5 MB request-body cap and started skipping documents
over it. Now documented together on `POST /api/classify`:

- The `config` field accepts a **YAML string** as well as an object, on **both**
  the multipart and the JSON form — the reference previously said "YAML or JSON
  string" for multipart but "config object" for JSON, implying the JSON form
  needed a parsed object.
- A document already in storage is referenced by `storage_key`, obtained via the
  presigned upload flow, which is not subject to the request-body cap.
- The cascade only reads the pages `window`/`scan` select, so client-side page
  slicing buys nothing — `window: 1` reads one page regardless of document
  length. No PDF library needed in the consumer.

No engine change; this is a documentation fix.

## 0.98.0 — 2026-07-22

**Version endpoints accept the identifiers they hand out.**
`GET /api/classifiers/{slug}/versions/{v}` (and the schema equivalent) parsed
`{v}` with `parseInt`, so a **semver label** — exactly what the sibling
`/versions` list returns in its `version` field — became `NaN` and the request
errored. One endpoint gave you `v0.0.1`; the other could not accept it. Both now
take a version number, a semver label with or without the leading `v`, a
candidate label (`v1.2.0-rc.7`), or a version-id prefix — the same forms a
pipeline's `classifier_version:` pin accepts. A segment that identifies nothing
is a `400`; a well-formed identifier matching no version is a `404`. This also
makes `parsedJson` reachable: it is only carried by the single-version endpoint,
which was previously unaddressable by the label callers had.

**`GET /api/classifiers/{slug}` now reports what is actually live.** It returned
only `latestVersion` — the *highest committed* version, which may be a candidate
sitting on top of the live release, so the reported version could differ from
the one routing runs. The response now also carries `activeVersion`
(`{ versionId, versionNumber, version }`) and `activeVersionLabel` for the
released version `currentVersionId` points at, plus `latestVersionLabel` to
match the list endpoint. Checking "what is live" is one call again.

## 0.97.0 — 2026-07-22

**`koji push` can be scoped and previewed, and no longer publishes updates live
by default.** `push` takes every YAML file it finds, so adding one classifier
could also re-release an unrelated extraction schema — live, immediately.

- **Scope it.** `--only <slug>` (repeatable) and `--kind schema|pipeline|classifier`
  limit what is pushed; `--dry-run` prints what would change and writes nothing.
- **Updates stage a candidate.** Pushing a change to an artifact that already
  exists commits a candidate, which is not live until promoted; pass `--release`
  to publish. Creating a **new** artifact still releases `v0.0.1` — there is no
  live version to displace, so a first push still leaves a usable project.
- **The subdirectory decides an untagged file's kind.** A classifier in
  `classifiers/` with no `kind:` field was previously created as a *schema*.
  Root-level untagged files are still schemas.

**`koji push` output now says what actually happened.** It read a `versionNumber`
field neither endpoint returns, so every update printed `updated to v?` — and
"updated" covered a real new version, a no-op, and a live-pointer move alike.
Each line now reports `unchanged`, `candidate vX.Y.Z-rc.N (not live)`, or the
released version, and a refused rollback (0.95.3) is rendered with both versions
and what to do instead.

## 0.96.0 — 2026-07-22

**`POST /api/classify` can now run a registered classifier by slug.** Pass
`{ "classifier": "<slug>" }` instead of the full config, optionally with
`classifier_version` to pin one; without a pin it runs the classifier's
**released** version, resolved through the same path the ingestion DAG's
`classifier:` step uses — so a standalone classify and a pipeline route agree on
the config *and* the version. Previously every consumer had to
`GET /api/classifiers/{slug}` for `yamlSource` and post it back: two round trips
per document, and each caller reimplementing fetch, cache, and invalidation.
Re-tuning a classifier is now a `koji classify release` with no consumer
redeploy. The response echoes `classifier` and `classifier_version` so callers
can see which version ran. An unknown slug — or a pin matching no version — is a
`404`; a bad pin never silently falls back to the live release. Inline `config`
keeps working, but supplying both is a `400` rather than a silent precedence
rule.

## 0.95.3 — 2026-07-22

**Publishing a schema or classifier can no longer silently roll the live release
backward.** Versions are deduplicated by content hash, and until now publishing
content that matched an *existing* version would repoint the live release at
that version — so re-publishing the YAML of an older version silently made the
older version live again, and the API reported it exactly like an ordinary new
release. A bulk `koji push` could therefore swap the live extraction schema for
an earlier one and print a success line. Publishing content that matches a
different existing release is now refused with `409 requires_reactivate`, naming
both versions and whether the move would be a rollback; pass
`allow_reactivate: true` (or use `promote`) to move the pointer deliberately.

**Release responses now say what actually happened.** `POST` to a schema or
classifier `versions`/`release` endpoint returns `action` (`created`,
`unchanged`, `graduated`, `activated`, `reactivated`) plus `displaced` — the
release the live pointer moved off. Re-publishing the version that is already
live now reports `unchanged` and writes nothing at all, instead of looking like
a successful update.

## 0.95.2 — 2026-07-16

**Encrypted PDFs now extract instead of silently returning nothing.** Many
carrier and law-firm PDFs ship with owner-password ("no-print") encryption and
an empty user password — readable, but restricted. When such a PDF's page tree
was stored in plain objects (not compressed object streams), the Document AI
parse path loaded it, sliced it locally, and unknowingly copied the still-
encrypted content streams into the slices it sent for OCR — so every page came
back blank and the document produced an empty parse. These PDFs are now
decrypted once (via the parse service's re-save) before slicing, so their text
survives end to end.

**Extraction now fails loudly when a document has no text.** Previously, if the
parse step produced no extractable text (an encrypted or image-only PDF the
parser couldn't read), a pipeline's extract step silently skipped extraction and
delivered the document with an empty result. It now marks the document `failed`
with an actionable reason ("the document produced no extractable text") instead
of stamping it delivered with nothing — no more blank deliveries that look
successful.

## 0.95.1 — 2026-07-16

**Search fixes on the Jobs and Documents lists.** Two annoyances are gone:
multi-word queries now work — the text is split on spaces and every word must
match (AND), so `park walk` finds `walk-in-the-park.pdf` instead of returning
nothing (previously the whole phrase had to appear contiguously). And the
search term is now mirrored into the URL (`?q=…`), so navigating into a job or
document and pressing **Back** restores your search instead of dropping you on
an empty box. The same tokenized matching now powers the command-palette
document search.

## 0.95.0 — 2026-07-15

**Upload plain-text and markdown files in the dashboard.** `.txt`, `.md`, and
`.markdown` files can now be dropped into every document-upload surface (schema
build, corpus, compare, and pipeline runs) alongside PDFs and images. Text and
markdown need no OCR or layout parsing — their bytes are already the markdown
extraction reads — so the parse service returns them verbatim instead of routing
them through the PDF engine. The document viewer renders their source inline as a
new text preview. (The CLI already accepted these files; this brings the
dashboard to parity.)

## 0.94.0 — 2026-07-14

**Auto-tune now fans scoring out per document — no more silent "Starting…", no
corpus-size ceiling.** A durable tuning run has to score the whole corpus to set
a baseline and to check each proposed edit. Previously each of those scorings ran
in a single background job, which (a) showed nothing while it worked, so a
multi-minute baseline pass looked hung, and (b) could exceed the 300s function
cap on a large corpus, killing the job and stranding the run. Scoring now fans
out **one job per document**; a finalizer aggregates the pass when the last
document lands. Two consequences: the panel shows live "Scoring the baseline
across the corpus — 12/40 documents" progress, and a run of any corpus size stays
comfortably under the time cap (documents also score in parallel, so runs are
faster). Rejected-proposal memory and resume-on-reopen are unchanged.

**Fixed: every dashboard page now has its own browser tab / history title.**
Previously every page shared one static title, so browser tabs and history
entries all read the same thing with no indication of which page you were on.
Each page now sets a descriptive title — "Documents", "Review", a specific
job/pipeline/schema name on detail pages — rendered as "&lt;Page&gt; · Koji".
Titles update on client-side navigation and Back/Forward too, so browser
history is finally readable.

## 0.93.0 — 2026-07-13

**Added: Auto-tune runs are now durable and resumable — they actually finish.**
Auto-tune previously ran the whole loop inside one request, so on a real corpus
it hit the 5-minute function cap and died mid-run (and vanished on a tab close).
It now runs as a persisted background job, one round at a time (each round well
under the cap), so it completes regardless of corpus size, survives disconnects,
and you can close the tab and come back to it. Every round is saved — the model's
reasoning, what it changed, whether it was kept, and any regressions — and
rejected proposals are fed back into later rounds (and future runs) so it stops
retreading edits that already failed. The panel starts a run and polls it,
resuming an in-flight run automatically. New: `tune_runs`/`tune_run_rounds`
tables and `POST/GET /api/schemas/{slug}/tune/runs`.

## 0.92.0 — 2026-07-13

**Improved: Auto-tune streams the model's actual reasoning as it works.** Beyond
the phase narration, each proposal now shows the model *thinking out loud* —
streamed token-by-token — about which failing field it's tackling, what the
document shows, why it's failing (routing vs. wording), and the change it's about
to make. The extraction model providers (OpenAI, Anthropic) gained a streaming
generate path, and the tuner asks the model to reason in a `<thinking>` block
that's relayed live to the panel. It reads like watching an engineer work the
schema, not a spinner.

## 0.91.0 — 2026-07-13

**Improved: Auto-tune now narrates what it\'s doing instead of just spinning.**
The corpus tuning loop streams fine-grained progress between rounds — "Scoring
across the corpus — 8/12 documents", "Baseline: 83%", "Round 1: focusing on
meridian_invoice — currency (routing miss)", "Asking the model for a fix…",
"Re-checking across the corpus…" — so the (multi-minute) run reads like the
agent thinking out loud rather than an opaque spinner. The structured per-round
result cards remain as the history. Delivered as a new `status` SSE event on the
corpus-loop endpoint.

## 0.90.1 — 2026-07-13

**Fixed: Auto-tune (and build extraction) failed with "Schema not found" on
projects other than the default.** The SSE clients for the tuning loop and
extraction post directly to the API (bypassing the shared client) and did not
send the `x-koji-project` header. On a tenant with multiple projects the API
falls back to the default project, so a schema living in another project was
filtered out by project RLS. Both SSE clients now attach the active project
header like every other request.

## 0.90.0 — 2026-07-13

**Changed: Auto-tune now lives in the Agent tab and optimizes the whole corpus.**
The schema-building Agent tab gained a **Chat / Auto-tune** toggle; Auto-tune runs
the corpus-optimizing loop (drive the schema across every labeled document,
keeping only changes that raise overall accuracy without regressing others),
streaming each round live — accuracy, which document guided it, what it fixed,
any regressions — then apply the improved schema and validate + promote (promote
stays server-gated on no regressions). The separate single-document Tune tab is
removed; tuning now optimizes for the corpus, using a failing document only to
guide the edit. This consolidates the iterative schema-tuning loop into one
place, drivable end-to-end without the CLI.

## 0.89.0 — 2026-07-13

**Added: a corpus-optimizing tune loop (`POST /api/schemas/{slug}/tune/corpus-loop`).**
The autonomous loop now optimizes for **whole-corpus accuracy** instead of a single
document. Each round scores the schema across every labeled corpus doc, focuses on a
failing one to guide the edit, then re-scores the whole corpus — keeping the change only
if overall accuracy improved and nothing regressed, and shifting focus to whatever fails
next (regressions included). This is the by-hand workflow: use a broken document to guide
the schema while maximizing for the corpus. Verified live over a 2-document corpus taking
83% → 92% → 100%, with focus shifting to the second document once the first was fixed.
Streams SSE `round` events or returns a JSON aggregate. The earlier single-doc
`tune/loop` remains for quick per-document fixes.

## 0.88.0 — 2026-07-13

**Added: an Auto-tune tab in the schema build workbench.** Select a labeled
corpus document and the schema improves itself: the panel runs the autonomous
tuning loop live — showing each round's accuracy climbing, which fields still
fail, and the model's reasoning — until it passes or stalls. On convergence you
**Apply** the improved schema to the editor, then the two safety gates: validate
the applied schema across the WHOLE corpus (so a fix on one document can't
silently regress others), and **Promote to live**, which the server blocks if
the candidate introduced any regression. This makes the iterative schema-tuning
loop drivable end-to-end without the CLI — increment 3, completing the loop.

## 0.87.0 — 2026-07-13

**Added: autonomous schema-tuning loop (`POST /api/schemas/{slug}/tune/loop`).**
Drives the single tuning step in a loop against one labeled exemplar — extract →
score → propose → apply → re-run — until the schema passes or the loop stalls,
returning the best-scoring schema found plus the full per-iteration trace. It
self-corrects: if a proposal doesn't help, it proposes again rather than giving
up (verified end-to-end taking a real invoice 83% → 100% over three iterations,
recovering after the first proposal fell short). Streams SSE progress by default
(an `iteration` event per round + a final `complete`), or returns a single JSON
aggregate with `Accept: application/json`. Stops early on pass, on no-proposal,
or after two non-improving rounds; each applied proposal is recorded to
`agent_proposed_edits` for audit. Applies nothing durable — snapshotting a
candidate and whole-corpus validation/promote remains a separate human-gated
step. This is increment 2 of the iterative tuning loop.

## 0.86.2 — 2026-07-13

**Fixed: schema-tuner proposals are now honored and validated.** Two issues,
both found running the tune loop live: (1) `POST /api/schemas/{slug}/tune`
checked the schema compiler with try/catch, but `compileSchema` *returns* errors
rather than throwing — so an invalid proposal was passed through instead of
retried. It now inspects the compiler result and retries once with the exact
errors, and never returns an uncompilable schema. (2) A field's freeform
extractor hint could be written as either `extraction_guidance` (used by the
pipeline/ingestion path and the built-in templates) or `extraction_hint` (used
by the build/validate/tune extraction path) — the two paths read different keys,
so a tuner (or template) hint written as one was silently ignored by the other.
Both keys are now treated as synonyms everywhere, including the hint-leak guard.
End result: a tuner proposal that adds `extraction_guidance` to a failing field
now actually improves extraction (verified: a real invoice went 83% → 100% after
applying one proposal).

## 0.86.1 — 2026-07-13

**Fixed: the schema-tuner (and build agent) now applies proposals wrapped in
```yaml fences, not just `<yaml>` tags.** Models — gpt-4o-mini in particular,
and reliably on the larger tuning prompt — return their proposed schema in a
```yaml code fence instead of the requested `<yaml>` block. The parser only
matched the tag, so `POST /api/schemas/{slug}/tune` diagnosed failures correctly
but silently returned no proposal (`proposedYaml: null`) every time. The
response parser now accepts a `<yaml>` tag, a ```yaml/```yml fence, or a bare
``` fence that looks like a schema. Found by running the tune endpoint against a
live document.

## 0.86.0 — 2026-07-13

**Added: schema tuning — a score-aware "propose a fix" step (`POST /api/schemas/{slug}/tune`).** The build agent proposes schema edits blind (from a chat message + a raw excerpt). This closes the loop: given a schema and one *labeled* corpus entry, it runs the schema, measures where it fails against ground truth, diagnoses each failing field — including whether the model even *saw* the answer (a routing miss you fix with `look_in`/`hints`) versus saw it and chose wrong (a description/prompt fix) — and asks the model for a minimal edit grounded in that evidence. It returns the before-scores and the proposed YAML without applying anything. This is the foundation for the iterative tuning loop; a follow-up drives it autonomously (extract → score → propose → re-run) with human checkpoints. API only in this release — no dashboard surface yet.

## 0.85.1 — 2026-07-13

**Fixed: the corpus "Pipeline" source filter now means something concrete.** It
was defined as "not an upload," and entries promoted from the review queue were
stored with source `review` — so the tab was really "not-upload" and its label
didn't match any real value. Entries promoted from a pipeline job now carry
source `pipeline`, and the Upload/Pipeline filters match their sources
explicitly. Legacy `review`-sourced entries are aliased to the Pipeline filter,
so nothing already in a corpus disappears.

## 0.85.0 — 2026-07-13

**Added: choose re-extract vs reparse when rerunning a document.** The Rerun
button on the document trace page is now a dropdown with two options: *Re-extract
only* (reuse the cached parse — fast, the previous default) and *Reparse &
extract* (parse the document again from source, then extract). Reparse is what
you want when the parsed text itself looks wrong — e.g. after a parser fix — so
you can pick up the corrected parse without re-uploading. The processing banner
now says "Reparsing" or "Re-extracting" to match.

## 0.84.0 — 2026-07-13

**Added: a corpus labeling queue — a focused stepper for building ground truth
across many documents.** The corpus page now has a **Label** button that opens a
full-screen, keyboard-driven editor and steps through entries one at a time
(unlabeled first, then drafts, then approved). Each entry shows the document in
the shared viewer on the left and the confirm-vs-correct funnel on the right, so
**draw-a-box-to-correct** works here too — the same editor as the build page, but
in a queue. It seeds each entry from any existing ground truth, offers an
optional "Propose with AI" (runs extraction to pre-fill), shows every schema
field (so you can fill in ones the model missed), and advances to the next entry
on save. `j`/`k` step, `s` skips, `Esc` exits; the header tracks "N / M · N to
go". The corpus list now also carries each entry's review status (unlabeled /
draft / approved) to drive the queue.

## 0.83.1 — 2026-07-13

**Fixed: localized text-layer corruption on one page of a large document no
longer poisons extraction.** Some digital PDFs carry a text layer whose
inter-word spacing lives in glyph geometry; the fast (pdfjs) parser drops it and
emits scrambled fragments (`"The No rt hg at e I n su ra nc e C o m pa ny"`).
The corruption check that reroutes such documents to the higher-fidelity parser
was document-level, so a single mangled page inside an otherwise-clean multi-page
policy averaged out below the detection threshold and slipped through — yielding
wrong values (e.g. a website read as `exampleco.com` instead of `examplec.com`) with
low confidence and no located source. Detection now also slides a window across
the document and reroutes when any span shows the fragment signature, so a few
bad pages can't hide behind the whole-document average. Tuned against 1,114
documents for zero false positives (uppercase table markers like ACORD insurer
rows and decorative bullet glyphs are explicitly excluded).

## 0.83.0 — 2026-07-13

**Changed: the ground-truth builder now lives in its own "Ground truth" tab in
the build workbench** instead of hanging off the bottom of the Results tab. The
confirm-vs-correct funnel (confidence badges, inline edit, draw-a-box-to-correct)
is unchanged — it's just its own surface now, alongside Agent / Schema / Results.
The tab is enabled once an extraction has run.

## 0.82.0 — 2026-07-13

**Added: ground-truth builder in the schema build workbench.** The build page's
"Save as ground truth" step is now a confirm-vs-correct funnel instead of a
blind save. After extraction proposes values for a corpus document, each field
shows a source-confidence badge — *exact source*, *best guess*, or *no source
located*, derived from how confidently its provenance was placed — with the
uncertain fields sorted first so attention lands where the model is shaky. For
each field the human can confirm the proposed value as-is, correct it by typing,
or **correct it by drawing a box on the document**: the drag resolves to the
text underneath and snaps both the value and its geometry into the label.
Ground truth is now saved *with* per-field provenance (page, bbox, source span),
so labels stay auditable and region-anchored. Value-only labels still work
unchanged.

New endpoints: `POST /api/schemas/{slug}/corpus/{entryId}/resolve-region`
(region→text lookup for the draw-to-correct flow) and an optional `provenance`
field on `POST /api/schemas/{slug}/corpus/{entryId}/ground-truth`. Promoting a
reviewed document into the corpus now carries its anchored corrections' geometry
along too, gated identically to the values (an agent-authored draft never leaks
geometry into the scored ground truth).

## 0.81.0 — 2026-07-13

**Improved: the faithfulness gate now checks each array-row value against its
OWN cited source text, not the whole row.** v0.80.0 verified a row's numbers
against a single verbatim string covering the entire row, which left a hole: a
fabricated number could survive by matching a *different* field's value printed
in the same row (e.g. an invented `deductible: 0` borrowing a genuine `$0`
printed for that row's building-value line). The extraction prompt now asks the
model to cite source text per field within each array item
(`__field_source_text`), and the gate verifies each value against its own
field's text. When a row provides only the older row-level text, the gate
falls back to the v0.80.0 row-granularity behavior, so nothing regresses. No
change to output shape or provenance highlights; the per-field citations are
internal and stripped before output.

## 0.80.1 — 2026-07-13

**Fixed: an optional list field that legitimately extracts as empty (`[]`) no
longer floods the review queue.** An empty array was scored `0.30` by the
engine's provenance formula (no provenance for zero items, but validation
"passed"), which trips the default review threshold — so a document with a
legitimately-empty optional list (e.g. no endorsements, no line items) routed to
review. Meanwhile an optional *null scalar* in the identical "no value" state was
already re-credited to `1.0` and auto-delivered. That asymmetry is fixed: at the
routing/scoring layer an empty array is now treated exactly like a null — an
optional empty list scores `1.0` (auto-delivers), a required empty list scores
`0.0` (routes to review, symmetric with a required null). Non-empty arrays are
unchanged (still scored per-element). The engine's provenance formula is
untouched; only the review-routing resolver changed, so the confidence shown in
the UI matches the routing decision.

## 0.80.0 — 2026-07-12

**Added: faithfulness gate — extracted numbers the model invented are now
nulled instead of surfacing as fabricated values.** Models are told to leave an
unprinted numeric field null, but they frequently placeholder-fill `0` (or an
estimate) instead — a not-stated deductible surfacing as a real-looking `$0` is
worse than an honest `null`. After extraction, every numeric value is checked
against the verbatim source text the model cited for it; a number that does not
appear there (compared numerically, so `9` still matches `"$9.00"` and `50000`
matches `"$50,000"`, while a fabricated `0` does not match `"$50,000"`) is set
to `null` and its confidence drops, routing it to review rather than shipping a
wrong value. The check runs per value and recurses into nested array items
(e.g. each row of a coverage's limit schedule), and is deliberately
conservative: only numeric fields are gated, and a value is kept when the model
cited no source text for it (cannot verify). Non-numeric fields, strings, and
enums are untouched.

_Known limitation:_ the check is row-granular — a fabricated number that happens
to equal another field's value printed in the same row is kept. Closing that
needs per-field source text within rows (tracked as follow-up).

## 0.79.5 — 2026-07-12

**Fixed: provenance highlight boxes on digital (text-layer) PDFs no longer sit
one line below the text.** The digital-PDF parser stored each text run's glyph
*baseline* as the top of its bounding box and then extended the box downward by
a full glyph height. Since glyphs sit *above* their baseline, every highlight
rendered roughly one line-height below the words it was meant to mark. The box
now extends upward from the baseline, so highlights land on the text. Line
grouping and reading order are unchanged (the baseline is still the line-group
anchor); only the emitted box geometry moved. Affects the text_map and the
positional-chunk bboxes used by the document, build, and review viewers.

## 0.79.4 — 2026-07-11

**Fixed: Google Document AI parses no longer scramble two-column form headers.**
The linearizer ordered page elements by a plain top-to-bottom, then
left-to-right sort. Because two cells in the same visual row almost never share
an exact vertical position, the sort never reached the left-to-right tie-break
and the two columns interleaved — tearing every label away from its value on the
declaration/summary headers that use a two-column label/value grid (so a field's
value could land next to an unrelated label). Element ordering now clusters
groups into rows by vertical overlap, then orders left-to-right within each row,
keeping each label adjacent to its value. Reading order is unchanged for
single-column and tabular content.

## 0.79.3 — 2026-07-11

**Fixed: the document "Parsed" view no longer shows a stale parse after a
re-parse.** The parsed-markdown endpoint cached its response in the browser for
an hour as if a parse were immutable per file. It isn't — re-running a document
(or a parse-provider switch, or a corruption fallback that swaps engines) writes
a new parse result, so the view could keep showing the old markdown for up to an
hour, including right after a fix that changed how the document parses. The
endpoint now tags each response with the parse result's identity and requires
revalidation: an unchanged parse is served from cache cheaply, but a re-parse
shows up immediately.

## 0.79.2 — 2026-07-11

**Fixed: digital PDFs with an undecodable text layer now fall back to the heavy
parse provider instead of extracting garbage.** Digital PDFs are parsed on a
fast pdfjs path, and a corruption check falls back to the heavy provider (OCR)
when that output looks unusable. A PDF with a broken/absent ToUnicode CMap
(PScript5/Distiller custom-encoded fonts) makes pdfjs emit the font's raw glyph
ids — control bytes and `0xFF` fill — in place of characters; the page renders
fine but the text is garbage. That form slipped between the existing checks
(fragmentation and space-mangle), so the garbage was trusted, cached, and
extracted (near-empty results, review status). The corruption check now also
flags a high fraction of non-printable/control bytes, routing these documents to
the OCR-based heavy provider. Companion to 0.79.1, which handled the same
corruption on the docling parse path.

**Fixed: large documents with an undecodable text layer no longer fail
extraction.** Some PDFs (notably PScript5/Distiller output with custom-encoded
fonts) carry a text layer whose fonts have a broken or absent ToUnicode CMap:
the page renders perfectly, but every text extractor emits high-entropy garbage
(glyph-index escapes like `/14 /i255`) instead of characters. That garbage
tokenizes ~3× denser than prose, so a long document could build an extraction
prompt far larger than it looked and the model would reject it with
`context_length_exceeded` — failing the whole document. Two fixes: (1) the parse
service now detects an undecodable text layer and recovers it with full-page
OCR, which reads the rendered glyphs directly; and (2) the extraction engine
estimates prompt size by character class (digits and non-ASCII/control bytes
count as denser than prose) and, as a backstop, splits-and-retries when a model
reports a prompt exceeded its context window rather than failing outright.

## 0.79.0 — 2026-07-10

**Added: multi-project and all-access API keys.** An API key was previously
bound to exactly one project. A key can now be scoped to a single project (the
default, unchanged), a specific set of projects, or all projects in the
workspace (tenant-wide). A multi/all-access key resolves its active project
from the `x-koji-project` header on each request (falling back to a default
project), and can only reach projects within its scope — a header naming a
project outside the scope still answers `404`, and keys never cross tenants. A
key's scope limits which projects it can reach, not its capability within them.
The scope is chosen when creating a key (Settings → API keys). Multi-project and
all-access keys are an organization/enterprise feature. Existing keys keep their
single-project behavior with no change.

## 0.78.1 — 2026-07-10

**Fixed: scalar scoring no longer fails on formatting-only differences.** String
comparison in `koji validate` / `koji bench` (and extraction reconciliation) was
case- and whitespace-tolerant but treated punctuation as significant, so a
correct extraction that differed from ground truth only in comma placement
(`CHARLOTTE, NC` vs `CHARLOTTE NC`) or separators (`704-376-9896` vs
`704.376.9896`) scored as a full miss. Comparison now collapses runs of
non-alphanumeric characters to a single space before matching. It forgives
punctuation/whitespace only — the alphanumerics must still match in order, so a
content difference (a dropped unit, a different PO box, a missing entity suffix)
still fails. Both scorers (TypeScript `value-compare`, Python `test_runner`) were
updated in lockstep so `validate` and `bench` continue to agree.

## 0.78.0 — 2026-07-10

**Improved: the document mapper splits chunks at page/section rules, not just
headings.** Parsers sometimes pack two logically distinct sections under one
heading with only a horizontal rule (`---`) between them — e.g. a notice page
immediately followed by a declarations page. Previously the whole block was
classified on its head text, so the second section inherited the wrong category
and a field scoped with `look_in` would never see it. The mapper now also splits
at CommonMark thematic breaks and classifies each part on its own text, while
coalescing adjacent same-category (and small/unclassified) fragments so a
homogeneous section stays a single chunk. This lifts extraction of fields that
live on a page the parser merged into an unrelated section (measured: large
recovery of declarations-header fields on multi-page package documents) with no
change to well-structured documents that have a heading per section.

## 0.77.1 — 2026-07-10

**Fixed: total duration now shows the real run time on pipeline (DAG) jobs.**
The trace/document detail page reported `0.0s` for every pipeline-processed
document even though the individual stages showed their real durations. Two
causes: the DAG runner computed the document's total from a `startedAt` field it
never loaded (always yielding `0`), and the trace page treated a stored `0` as a
valid total instead of falling back to the sum of stage durations. New runs now
persist the wall-clock duration, and the page sums the visible stages when no
positive total is stored (so already-processed documents display correctly too).

## 0.77.0 — 2026-07-10

**Added: edit a pipeline's schema and review threshold from the dashboard.** The
pipeline detail page's Edit configuration dialog now covers all four editable
settings — schema, model endpoint, parse engine, and review threshold — not just
the model/parse pair. This also fills a gap: a pipeline with no schema attached
("not set") could previously only get one at creation time, leaving it stuck;
you can now attach a schema from the detail page.

**Fixed: review threshold is now validated to `[0, 1]`** on both create and
update. Previously an out-of-range or non-numeric value was stored verbatim and
silently disabled review routing entirely (documents never routed to review).

**Fixed: changing a pipeline's schema resets version tracking to `auto`.**
Previously a schema change left the pinned version pointing at the old schema, so
the Deployment section showed a stale/mismatched "deployed version." The pin is
now cleared when the schema actually changes.

## 0.76.0 — 2026-07-10

**Added: edit a pipeline's model endpoint and parse engine from the dashboard.**
The pipeline detail page's Configuration section now has an **Edit** button
(for members with `pipeline:write`) that opens a dialog to change the model
endpoint used for extraction and the parse/OCR engine — the same two settings
you pick when creating a pipeline. Previously these could only be set at
creation time or via `PATCH /api/pipelines/{idOrSlug}`. Clearing the parse
engine reverts the pipeline to the tenant parse default.

## 0.75.1 — 2026-07-09

**Fixed: `koji push` ignored the profile's project and wrote to the API key's
bound project.** `push` sent only an `Authorization` header — never
`x-koji-project` — so a profile scoped to project A silently pushed to whatever
project the key was bound to (B), with no error. It now sends the profile's
project scope (and `KOJI_PROJECT` in env mode), so push targets the project you
selected and **404s loudly on an unreachable scope** instead of falling back to
the wrong project. If you ran `koji push` against a multi-project setup on
0.75.0, check that your artifacts landed where you intended.

**Fixed: `koji project use` could strand a profile.** It validated the target
project using the profile's *current* pin, so once a profile was pinned to an
unreachable project you couldn't switch back — the reset request carried the
broken pin and 404'd. `use` now probes the *target's* scope, so switching away
from a bad pin always works. It also distinguishes "no such project" from "your
key is bound to a different project" (API keys are project-scoped), and
`project list` no longer sends a project scope, so it works even when the
profile is pinned to an unreachable project.

**`koji project create --use` no longer strands you.** Because an API key is
bound to a single project, the key that creates a project usually can't operate
in it. `--use` now switches only if the new project is actually reachable by the
key, and otherwise tells you to mint a key for it — rather than pinning the
profile to a project every subsequent command will 404 on.

## 0.75.0 — 2026-07-09

**New: `koji project` — manage projects from the CLI.** Projects (the
intra-tenant boundary scoping schemas, pipelines, classifiers, and jobs) could
only be created in the dashboard; the CLI could merely select one via
`koji login --project`. Now:

- `koji project list` — projects your key can access (● marks the active one)
- `koji project create <slug> [--name] [--description] [--use]` — create a
  project (`tenant:admin`); `--use` switches the active profile to it in one step
- `koji project use <slug>` — scope the active profile to an existing project
- `koji project delete <slug>` — delete a project (`tenant:admin`; `--yes` skips
  the prompt)

`use` and `create --use` persist the project on the active profile (the same
`x-koji-project` default `koji login --project` sets), so scripted setup of a new
project no longer needs the dashboard.

## 0.74.0 — 2026-07-09

**Fixed: releasing a new classifier version could wedge with a bare 500.** A new
version's target semver was computed by bumping the **active** release, not the
highest existing version. After a churned history where `currentVersionId` points
at an older release than the newest one (e.g. active `v0.0.1` while a `v0.0.2`
release also exists), a patch change targeted the already-occupied `v0.0.2`,
violated the released-semver unique index, aborted the transaction, and failed
the whole request — while the identical config under a new slug released fine. New
versions are now bumped from the highest existing version, so they stay strictly
monotonic and can't collide. A wedged classifier accepts new versions again with
no manual repair.

**500s now return a JSON body with the cause.** The API's uncaught-error handler
returned a bare `text/plain` "Internal Server Error", which JSON clients (the CLI
included) saw as an empty, unparseable body — turning a diagnosable failure into a
blank 500. It now returns `{ error, message }`.

**New: `koji classify delete <slug>`.** Deletes a classifier and all its versions
(confirmation prompt; `--yes` to skip). Use it to clean up a test classifier or
recreate one from scratch. Pipelines that reference the slug will fail to resolve
it until it's recreated.

## 0.73.0 — 2026-07-09

**Classifiers can declare disqualifying signals.** A class now accepts
`exclude_keywords` and `exclude_patterns`: if any appears in the window text,
that class is ruled out — it can't win the keyword tier and is dropped from the
LLM and vision candidate lists, so no tier can pick it. Where `keywords` say
"this might be class X," these say "if the document has this, it is definitely
not X."

This routes classes that share vocabulary with a class they must not be confused
for. A standalone umbrella and a package policy both mention "schedule of
underlying insurance," so no positive keyword separates them — but a package
carries its own coverage-part declarations, which an umbrella never does.
Excluding the umbrella class when those appear routes it deterministically
instead of relying on an inconsistent LLM guess. The engine only matches the
strings; which strings rule out which class is entirely user config, so nothing
document-type-specific enters the engine. Disqualification needs textual
evidence — a scanned page with no text layer excludes nothing.

## 0.72.1 — 2026-07-09

**Mapping/enum alias matching is now whitespace-tolerant at extraction time,
matching the scorer.** The extraction-time resolver lowercased alias candidates
but didn't trim or collapse internal whitespace, so a model emitting
`" each occurrence"` or `"Each  Occurrence"` could slip past canonicalization
while `koji validate`/`bench` (which trim) resolved it — the two disagreed on
format drift. Both the extraction resolver (`api` pipeline) and the scorer
(`_resolve_mapping`) now fold candidates identically: lowercase, trim, collapse
internal whitespace. A value that equals a declared canonical code is still kept
verbatim (a code wins over being another code's alias), and any verbatim-label
sibling (e.g. `applies_to_raw`) is untouched.

Note: this does **not** rewrite a value that is itself a valid canonical code.
If a mapping declares both a `building` code and a `blanket_building` code whose
aliases include `"Building"`, a model output of `"building"` stays `building` —
that alias is unreachable by design. Author mappings so a code's name never
collides with another code's alias.

## 0.72.0 — 2026-07-09

**`koji pipeline bench` scores array fields element-wise (F1), matching
`validate`.** Array fields (a document's `coverages`, `line_items`, …) were
scored all-or-nothing: a `coverages` array with four of five elements right
counted as a full miss, so the extraction number was dominated by whichever
docs happened to have a perfect array. Array fields now earn partial credit —
the F1 of element-wise precision and recall, the same semantics the server-side
`validate` scorer uses — so that doc scores ~0.8 on the field instead of 0.

The `EXTRACTION` line now reports F1-weighted accuracy with the exact-match
count alongside (`96.0% F1 over 5 fields (4 exact)`), each mismatched array
shows its element F1 in the failure detail, and `--json` gains `field_credit`
per run and per schema plus a `score` on each failure. Scalar fields are
unchanged (1.0/0.0), and `koji bench`'s pass/fail counting is unaffected.


## 0.71.2 — 2026-07-09

**`koji classify run` now runs the RELEASED classifier version — the same one the
pipeline runs.** It resolved the highest version *number* instead, so once an
unreleased candidate existed, `classify run` silently ran that draft while the
ingestion pipeline ran the release. The standalone primitive and the pipeline
disagreed on the same document with no indication why — which made it useless as
a routing-tuning proxy. It now resolves the released version (the classifier's
`currentVersionId`), matching the pipeline exactly.

- `classify run` prints which config it used (`released v0.0.2`, `draft`, or
  `local file <path>`) — source selection is no longer silent.
- New `--draft` flag runs the latest unreleased candidate, for iterating before
  release. A local `<slug>.yaml` still takes precedence for offline iteration.

## 0.71.1 — 2026-07-09

**A referenced classifier can now read non-PDF documents.** The classify cascade's
cheap text tier read page text with pdfjs. Handed a `.md`, `.txt`, `.csv`, or
`.docx`, pdfjs rejected the bytes, the cascade saw no text, and both the keyword
and LLM tiers — which are gated on having text — were skipped. The step returned
`unknown` with no error and the pipeline took its `default` edge. A DAG
`classify` step using `classifier: <slug>` therefore mis-routed **every**
non-PDF document, while the same pipeline with inline `labels` worked (that path
reads the already-parsed text and never touches the cascade).

The cascade now reads a text-like document's bytes directly (by MIME type, or by
extension when the upload arrives as `application/octet-stream`), and falls back
to the caller's already-parsed text when the reader can't open the bytes at all
— which covers `.docx`, `.xlsx`, and anything else the parse stage handles.

Scanned PDFs are unchanged: pdfjs opens them and reports a page count, so they
still escalate to the vision tier rather than short-circuiting on OCR text.

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
