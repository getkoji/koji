---
title: Parse / OCR Providers (BYO)
description: Bring your own OCR / parse engine — Mistral, Azure Document Intelligence, Google Document AI, or AWS Textract — so parse cost stays on your bill.
---

# Parse / OCR Providers

Koji parses digital PDFs in-process for free (text is already embedded). Scanned
PDFs, images, and the hard long tail — faxes, dot-matrix loss runs, handwritten
annotations — need real OCR. You bring your own OCR / parse engine the same way
you bring your own model: configure a vendor key once, and the per-page parse
cost stays on **your** bill. Koji never marks it up.

With no parse endpoint configured, Koji uses its built-in default engine — so this
is entirely opt-in.

## Where to configure

**Project settings → Parse Endpoints → Add provider.**

Credentials are encrypted at rest (envelope encryption, same as model
endpoints) and can never be retrieved — only rotated.

**Available to** decides the endpoint's reach: *This project only* (the default)
or *All projects in this workspace*. Share it when every project should parse
through the same OCR vendor — including projects created later — and add a
project-scoped endpoint when one project needs a different engine. The
project-scoped one wins for that project; everything else keeps using the shared
endpoint. Each scope keeps its own default, so promoting a project's endpoint
never disables the workspace-wide one.

| Provider | Best for | What you need |
|----------|----------|---------------|
| **Mistral OCR** | SMB / cost-sensitive — markdown-native, self-serve, cheap per page | API key |
| **Azure Document Intelligence** | Teams already on Azure — runs under your existing MSA | Resource endpoint URL + key |
| **Google Document AI** | Teams already on GCP — structured tables, handles large docs by slicing (no GCS needed) | Project ID + processor ID + region + an access credential — a short-lived OAuth token *or* keyless Workload Identity Federation (see [Authentication](#authentication-google-document-ai)) |
| **AWS Textract** | Teams already on AWS — structured tables | Region + access key ID + secret access key |

The model / processor field defaults sensibly per provider (`mistral-ocr-latest`,
`prebuilt-layout`, etc.) — override it only if you need a specific one.

## Large documents (Google Document AI)

Google Document AI's synchronous `:process` API caps at **15 pages**. Most
real-world documents — multi-hundred-page policies, large SOV/COPE schedules,
wrap-up specs — are bigger, so Koji handles them automatically; you don't pick a
mode.

**By default, Koji slices large documents and processes the slices in parallel
on the synchronous endpoint — no Google Cloud Storage required.**

| Document size | Default path |
|---------------|--------------|
| ≤ 15 pages | A single synchronous `:process` call. |
| > 15 pages | Sliced into ≤ 15-page segments, each sent to `:process` **in parallel** (bounded by a concurrency cap), then merged back into one result with page numbers and bounding boxes renumbered globally. |

Slicing at page boundaries is quality-neutral for a page-local OCR processor:
each page is processed exactly as it would be on its own, and parallel
synchronous calls are typically faster per document than the asynchronous batch
API. No bucket, no IAM grant for storage, no temporary objects to clean up.

If a segment is rejected as too large (e.g. very image-heavy pages), Koji
automatically bisects it into smaller slices and retries; a segment that still
can't be processed surfaces a clear error rather than silently dropping pages.

**Encrypted PDFs are handled automatically.** Many carrier and law-firm PDFs
ship with owner-password ("no print") encryption that also hides the page
structure from Koji's local slicer. When Koji detects this, it re-saves the
document once through its parse service (decrypting it — these files open
without a password) and slices the normalized copy as usual. If that
normalization is impossible, documents up to 30 pages still go through a
single synchronous call; larger ones fail with an error that says exactly why
and suggests batch mode.

### Tuning (optional)

| Config field | Default | Meaning |
|--------------|---------|---------|
| `slice_pages` | `15` | Pages per slice for the slice-and-merge path. Clamped to 1–30 (the synchronous endpoint can't exceed 30 pages even with imageless mode). |
| `online_concurrency` | `6` | Maximum number of slices processed in parallel. Lower it if you hit Document AI online QPS quotas. |

### Bulk imports: opt-in batch processing

For high-volume historical imports, you can opt into Document AI's asynchronous
**batch** API instead of slicing. Set `parse_mode: "batch"` (or
`use_batch: true`) in the endpoint config. Batch uploads the source to a GCS
bucket you own, runs the asynchronous batch operation, reads the structured
output back, and **deletes the temporary objects it created** — Koji never
retains your documents in your bucket.

Batch is **opt-in**, not the default. Use it for bulk back-fills; the default
slice-and-merge path is the better choice for interactive, per-document parsing.

When `parse_mode: "batch"` is set, add a **GCS bucket** to the endpoint config:

| Config field | Meaning |
|--------------|---------|
| `gcs_bucket` | Bucket Koji uses for batch input + output (it namespaces each job under `koji-docai/input/<run-id>/` and `koji-docai/output/<run-id>/`). |
| `gcs_input_uri` *(optional)* | Override the input prefix with an explicit `gs://…` location. |
| `gcs_output_uri` *(optional)* | Override the output prefix with an explicit `gs://…` location. |

Supplying `gcs_bucket` alone is enough; the explicit URIs are for teams that
want batch I/O under a specific path. With batch opted in but no bucket
configured, large documents fail with a clear error.

#### Required IAM for batch

The service account behind your endpoint's access token needs, in addition to
Document AI access:

- **`roles/documentai.apiUser`** on the processor — to run batch operations.
- **`roles/storage.objectAdmin`** on the configured bucket — to write the input,
  read the output shards, and delete both afterward. (A narrower split of
  object create / view / delete also works; `objectAdmin` is the simplest
  correct grant.)

The default slice-and-merge path needs **neither** of these storage grants —
just Document AI `:process` access.

## Authentication (Google Document AI)

Document AI authenticates with a Google Cloud OAuth2 **access token** (sent as a
`Bearer` token). When you add a Google Document AI endpoint, the form presents an
**Authentication** selector with three options:

| Method | When to use |
|--------|-------------|
| **Workload Identity Federation (keyless)** — *default, recommended* | Production and any enterprise GCP org. Keyless; no service-account key is stored. The only option when your org enforces `iam.disableServiceAccountKeyCreation`. See [Option 2](#option-2--keyless-workload-identity-federation-recommended-for-production). |
| **Access token (dev / testing)** | A quick endpoint test. Short-lived (~1h); not for production. See [Option 1](#option-1--static-access-token-quick-start). |
| **Service-account JSON (self-host fallback)** | Self-hosting where you can still download an SA key. Many enterprise org policies block SA-key creation — use WIF for those. |

The keyless WIF and access-token paths are the recommended ones; the
service-account-JSON path is a self-host fallback, deliberately demoted because
it relies on a downloadable key that enterprise policy often forbids.

### Option 1 — static access token (quick start)

Choose **Access token** in the form and paste a short-lived token. Mint one
with, e.g.:

```bash
gcloud auth print-access-token \
  --impersonate-service-account=docai@PROJECT.iam.gserviceaccount.com
```

This is the fastest way to validate an endpoint, but a Google access token lives
**~1 hour** — it is not a durable production credential, and you'll have to
rotate it by hand. Use it for a first test, not for ongoing operation.

### Option 2 — keyless Workload Identity Federation (recommended for production)

Many organizations disable service-account-key creation
(`iam.disableServiceAccountKeyCreation`), so a downloaded JSON key isn't an
option — and a pasted token isn't durable. **Workload Identity Federation (WIF)**
solves both: Koji's running workload presents its own OIDC identity, your WIF
pool trusts that identity, and Google exchanges it for a short-lived token that
impersonates your target service account. **No long-lived secret is ever stored
or downloaded.** Koji mints a fresh token at call time and caches it until it
nears expiry, refreshing automatically — you never rotate anything.

In the **Add provider** form, choose **Workload Identity Federation (keyless)**,
paste the credential config produced by
`gcloud iam workload-identity-pools create-cred-config` into **Credential config
(external_account JSON)**, and (optionally) set the **Impersonation service
account**. The form stores exactly the `config_json` shape below — no secret is
saved. You can also author it directly: put a standard Google `external_account`
credential config in the endpoint's `config_json` under a `wif` block:

```json
{
  "project_id": "my-project",
  "processor_id": "abc123",
  "location": "us",
  "wif": {
    "external_account": {
      "type": "external_account",
      "audience": "//iam.googleapis.com/projects/PROJ_NUM/locations/global/workloadIdentityPools/POOL/providers/PROVIDER",
      "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
      "token_url": "https://sts.googleapis.com/v1/token",
      "credential_source": { "file": "/var/run/secrets/oidc/token" }
    },
    "impersonate_service_account": "docai@my-project.iam.gserviceaccount.com"
  }
}
```

- `external_account` is the same config you'd otherwise point
  `GOOGLE_APPLICATION_CREDENTIALS` at. Its `credential_source` names **where the
  workload's OIDC token comes from** — a file or URL your runtime exposes
  (Cloudflare Workers OIDC, GKE/Cloud Run metadata, etc.). This is
  the only place the source identity is configured; Koji's engine hardcodes
  nothing.
- `impersonate_service_account` is the SA whose Document AI access you want to
  use. (You can instead set `service_account_impersonation_url` directly inside
  `external_account`; if present it wins.)

With WIF configured, the endpoint needs **no** stored secret — `auth_json` can be
empty.

##### Vercel (and other env-var OIDC runtimes): the `source` marker

Some runtimes — **Vercel** chief among them — don't expose the workload OIDC
token as a file or URL. They expose it as an **environment variable**
(`VERCEL_OIDC_TOKEN`) / a function call (`getVercelOidcToken()`), which a
standard `credential_source` can't read. For these, add a `source` marker to the
`wif` block and **omit `credential_source`** — Koji fetches the token
programmatically and supplies it to Google's STS exchange:

```json
{
  "project_id": "my-project",
  "processor_id": "abc123",
  "location": "us",
  "wif": {
    "source": "vercel",
    "external_account": {
      "type": "external_account",
      "audience": "//iam.googleapis.com/projects/PROJ_NUM/locations/global/workloadIdentityPools/POOL/providers/PROVIDER",
      "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
      "token_url": "https://sts.googleapis.com/v1/token"
    },
    "impersonate_service_account": "docai@my-project.iam.gserviceaccount.com"
  }
}
```

How Koji resolves the source token, **environment-aware**:

1. **On Vercel (production):** the Vercel workload OIDC token
   (`getVercelOidcToken()`, falling back to `VERCEL_OIDC_TOKEN`) is exchanged via
   STS and impersonates your target SA. No secret is stored.
2. **In local dev (no Vercel token present):** Koji falls back to
   **Application Default Credentials** — run
   `gcloud auth application-default login` and Koji mints the token via ADC,
   impersonating the same target SA (your local identity needs
   `roles/iam.serviceAccountTokenCreator` on it). This lets you exercise a
   WIF-configured endpoint locally without a Vercel identity.

Koji logs which source fired (`via Vercel workload OIDC` vs `via local ADC
fallback`) so you can confirm the path in your runtime logs. The
file/URL `credential_source` form above is unchanged — `source` is purely
additive.

**Auto-detection (when `source` is omitted).** The `source: "vercel"` marker is
optional. If a `wif` block carries an `external_account` with **no consumable
`credential_source`** (no `file`/`url`/`executable`) and **no `source`** — the
exact shape the dashboard's Parse Catalog form persists — Koji auto-detects the
dynamic path: it uses the Vercel workload OIDC token when one is present (hosted
prod) and falls back to local ADC otherwise, identical to setting
`source: "vercel"` explicitly. An `external_account` that **does** carry a
`credential_source` always uses the static file/URL path and is never
auto-overridden, so self-host configs are unaffected. Set `source` explicitly
only to be unambiguous, or to name a non-Vercel env-var OIDC runtime.

#### Step-by-step: set up keyless WIF (self-serve)

This is a one-time setup in **your** GCP project. You never download a key and
never paste a long-lived secret. Every command below uses placeholders only —
substitute your own values.

##### 1. Read your Koji trust values from the dashboard

Koji's running workload presents an OIDC token. Your WIF pool must trust the
**exact** `issuer`, `audience`, and `subject` that token carries. **Don't guess
or hardcode them** — Koji shows the live values for your deployment:

> **Project settings → Parse Endpoints → Add provider → Google Document AI →
> Authentication: Workload Identity Federation.** The **What to trust in GCP**
> panel shows the **Issuer**, **Audience**, and **Subject**, each with a copy
> button.

These are read live from the deployment (hosted Koji decodes its own workload
OIDC token; self-host can configure them — see the self-host note below), so
they are always correct for the environment you're connecting to.

Capture them as shell variables for the commands that follow:

```bash
# Your GCP project
export PROJECT_ID="my-gcp-project"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

# Names you choose for the pool + provider
export POOL_ID="koji-parse"
export PROVIDER_ID="koji-oidc"

# The Document AI service account Koji will impersonate
export SA_EMAIL="docai@${PROJECT_ID}.iam.gserviceaccount.com"

# Copied from the dashboard "What to trust in GCP" panel
export KOJI_ISSUER="<Issuer from the dashboard>"
export KOJI_AUDIENCE="<Audience from the dashboard>"
export KOJI_SUBJECT="<Subject from the dashboard>"
```

##### 2. Create the Workload Identity Pool + OIDC provider

The provider trusts Koji's issuer, accepts Koji's audience, maps the token
subject to `google.subject`, and — critically — **pins the subject in an
attribute condition** so only Koji's deployment can federate (no other workload
with a token from the same issuer can):

```bash
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" --location="global" \
  --display-name="Koji parse"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location="global" \
  --workload-identity-pool="$POOL_ID" \
  --issuer-uri="$KOJI_ISSUER" \
  --allowed-audiences="$KOJI_AUDIENCE" \
  --attribute-mapping="google.subject=assertion.sub" \
  --attribute-condition="assertion.sub == '${KOJI_SUBJECT}'"
```

The `attribute-condition` is your security boundary: federation succeeds only
for the exact subject Koji presents. Keep it pinned to the value from the
dashboard.

##### 3. Grant the federated identity permission to impersonate your SA

Let the pinned subject impersonate (mint tokens for) your Document AI service
account. The `principal://…/subject/${KOJI_SUBJECT}` member is the tightest
grant — it covers exactly that one subject:

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/${KOJI_SUBJECT}"
```

> If you prefer to grant the whole pool (the `principalSet://…/workloadIdentityPools/${POOL_ID}/*`
> member) instead of a single subject, you can — but the per-subject `principal://`
> member above is narrower and recommended, since the attribute condition has
> already pinned the subject.

##### 4. Grant the SA Document AI access

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --role="roles/documentai.apiUser" \
  --member="serviceAccount:${SA_EMAIL}"
```

(Only if you opt into **batch** for bulk imports, also grant
`roles/storage.objectAdmin` on the batch bucket — see
[Required IAM for batch](#required-iam-for-batch). The default slice-and-merge
path needs only `documentai.apiUser`.)

##### 5. Build the `external_account` config to paste into Koji

The dashboard's WIF panel includes a **copyable template** pre-filled with this
exact shape — copy it and substitute your IDs. Note there is **no
`credential_source`**: Koji's workload OIDC token is exposed by the platform
runtime (an env var / function call), not a file or URL, so the source is
**auto-detected** — you supply only the pool/provider audience and the
impersonation target:

```json
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/SA_EMAIL:generateAccessToken"
}
```

| Field | Value |
|-------|-------|
| `type` | Always `external_account`. |
| `audience` | The **WIF provider resource name** — your pool/provider, not the OIDC token's `aud`. Substitute `PROJECT_NUMBER`, `POOL_ID`, `PROVIDER_ID`. |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:jwt`. |
| `token_url` | Google STS: `https://sts.googleapis.com/v1/token`. |
| `service_account_impersonation_url` | Impersonation endpoint for your `SA_EMAIL`. Equivalent to setting **Impersonation service account** in the form. |

> **Don't confuse the two "audiences".** The `audience` field here is the GCP
> WIF provider *resource name* you just created. It is **not** the OIDC token's
> `aud` claim — that's the **Audience** trust value from step 1, which you set
> via `--allowed-audiences` on the provider.

##### 6. Configure the endpoint in the dashboard

Back in **Add provider → Google Document AI**:

1. **Authentication:** Workload Identity Federation (keyless).
2. **Credential config (external_account JSON):** paste the config from step 5.
3. **Impersonation service account:** your `SA_EMAIL` (optional if the config
   already carries `service_account_impersonation_url`).
4. **GCP project ID / Processor ID / Region:** your Document AI processor's
   project, processor, and location.

Save. The endpoint is keyless — no secret is stored. **Test** reports
"Keyless WIF configured"; Koji mints a short-lived token at parse time and
refreshes it automatically.

#### Hosted vs. self-host

- **Hosted Koji** runs on Vercel and presents the Vercel workload OIDC token.
  The dashboard's trust panel decodes that live token, so the issuer / audience /
  subject you see are exactly what Koji will present — nothing is hardcoded.
- **Self-hosting:** run Koji in an environment that exposes a workload OIDC token
  and supply the `external_account` config that names its source. Either point
  `external_account.credential_source` at the file/URL your runtime exposes
  (e.g. GKE/Cloud Run metadata, Cloudflare Workers OIDC), or — for env-var/
  function-call runtimes — omit `credential_source` and let the dynamic source
  resolve it. To make the dashboard's trust panel show the right values for your
  own issuer, set `KOJI_WIF_ISSUER`, `KOJI_WIF_AUDIENCE`, and `KOJI_WIF_SUBJECT`
  in the API environment; otherwise read the claims from a sample of your
  deployment's OIDC token. Koji's token-exchange code is generic and ships in the
  OSS engine; the source identity is entirely yours to configure.

## The default endpoint

The tenant's single **active** endpoint is the default heavy parse engine: it's
what runs when a pipeline doesn't pin one. The first endpoint you add becomes the
default automatically; adding more leaves them on standby. Use **Set as default**
on any endpoint to switch.

Standby endpoints are still usable — pin one to a specific pipeline (below) even
when it isn't the tenant default.

## Test a configured endpoint

**Test** on an endpoint card validates that the stored key decrypts with the
current master key and reports whether the runtime driver for that provider is
available in this build yet. (Drivers ship incrementally — a configured endpoint
whose driver hasn't landed shows **driver pending**; its credentials are stored
and validated, and it activates automatically once the driver is released.)

## Per-pipeline override

A pipeline can pin a specific parse endpoint instead of using the tenant default.
When creating a pipeline, set **Parse engine (optional)** — leave it on *Tenant
default (auto)* to follow the tenant default, or choose a configured endpoint to
pin it. The pinned engine shows on the pipeline detail under **Parse engine**.

This mirrors how a pipeline pins a model endpoint: the tenant default applies
unless a pipeline overrides it.

## Why BYO parse

OCR is an inference cost, like model calls — and it belongs on the customer's
bill the same way. Routing parse to your own vendor key keeps Koji a pure
platform layer and keeps you portable across parse vendors: switch engines
without re-tooling your schemas, pipelines, or review queues.
