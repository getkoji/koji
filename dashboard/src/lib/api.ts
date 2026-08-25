/**
 * API client for the Koji server.
 *
 * In dev, the dashboard runs at :3002 and the API at :9401. In
 * production, they share a domain and the API is at /api/*.
 *
 * All responses are JSON. Errors throw with the Problem detail body.
 */

// Client-side: use relative URLs — Next.js rewrites /api/* to the Koji API.
// Server-side (SSR): use the env var for direct container-to-container calls.
const API_BASE = typeof window === "undefined"
  ? (process.env.KOJI_API_URL ?? "http://localhost:9401")
  : "";

/**
 * Optional auth token provider. When set, every request includes an
 * `Authorization: Bearer <token>` header instead of relying on cookies.
 *
 * The hosted platform sets this to Clerk's `getToken()` so cross-origin
 * API calls work without shared cookies. OSS (same-origin) never sets
 * it and continues using `credentials: "include"`.
 */
let authTokenProvider: (() => Promise<string | null>) | null = null;

export function setAuthTokenProvider(provider: () => Promise<string | null>) {
  authTokenProvider = provider;
}

export function getAuthTokenProvider(): (() => Promise<string | null>) | null {
  return authTokenProvider;
}

/**
 * Optional sign-out handler. When set, the sign-out button calls this
 * instead of the built-in session DELETE. The hosted platform sets this
 * to Clerk's `signOut()`.
 */
let signOutHandler: (() => Promise<void>) | null = null;

export function setSignOutHandler(handler: () => Promise<void>) {
  signOutHandler = handler;
}

export function getSignOutHandler(): (() => Promise<void>) | null {
  return signOutHandler;
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  /** The full parsed error body, for callers that need structured fields
   *  (e.g. the move endpoint's `blockers` array on a 409). */
  body: Record<string, unknown>;

  constructor(status: number, body: { error?: string | { message?: string; code?: string }; title?: string; detail?: string }) {
    const errField = body.error;
    const msg = typeof errField === "string"
      ? errField
      : errField?.message ?? body.title ?? `API error ${status}`;
    super(msg);
    this.status = status;
    this.detail = body.detail;
    this.body = body as Record<string, unknown>;
  }
}

/**
 * Extract tenant slug from the current browser URL path (/t/<slug>/...).
 * Returns undefined for non-tenant routes (login, setup, etc.).
 */
function getCurrentTenantSlug(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const match = window.location.pathname.match(/^\/t\/([^/]+)/);
  return match?.[1];
}

/** localStorage key holding the selected project slug for a tenant. */
export function projectStorageKey(tenantSlug: string): string {
  return `koji:project:${tenantSlug}`;
}

/**
 * The project slug the dashboard is currently scoped to (URL segment, else the
 * persisted selection). Every project-scoped page resolves its data under this
 * project, so it's also the project any resource on that page belongs to.
 * Returns undefined before a project is known.
 */
export function selectedProjectSlug(tenantSlug: string | undefined): string | undefined {
  return getCurrentProjectSlug(tenantSlug);
}

/**
 * Resolve which project the current request is scoped to, sent as the
 * `x-koji-project` header so the server's project RLS applies (the backend
 * boundary landed in 0.48). Priority:
 *   1. an explicit `/projects/<slug>` segment in the URL (overview + project
 *      settings pages address a project directly), then
 *   2. the persisted selection from the project switcher.
 * Returns undefined when neither is known — the server then falls back to the
 * tenant's default project, matching pre-0.48 behavior.
 */
export function getCurrentProjectSlug(tenantSlug: string | undefined): string | undefined {
  if (typeof window === "undefined") return undefined;
  const inUrl = window.location.pathname.match(/\/projects\/([^/]+)/)?.[1];
  if (inUrl) return inUrl;
  if (!tenantSlug) return undefined;
  return localStorage.getItem(projectStorageKey(tenantSlug)) ?? undefined;
}

async function request<T>(path: string, options?: RequestInit & { isFormData?: boolean }): Promise<T> {
  const url = `${API_BASE}${path}`;
  const tenantSlug = getCurrentTenantSlug();

  // For FormData bodies, let the browser set Content-Type (with the
  // multipart boundary). Setting it manually breaks multipart parsing.
  const headers: Record<string, string> = options?.isFormData
    ? { ...((options?.headers as Record<string, string>) ?? {}) }
    : {
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string>),
      };

  // If an auth token provider is set (hosted/Clerk), send a Bearer token
  // instead of relying on cross-origin cookies. The JWT carries the org
  // context, so skip the x-koji-tenant header — the API resolves tenant
  // from the JWT's orgId claim. Skip credentials: "include" to avoid
  // sending cookies that conflict with Bearer auth on the API.
  let useCredentials = true;
  if (authTokenProvider) {
    const token = await authTokenProvider();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      useCredentials = false;
    }
  } else if (tenantSlug) {
    // OSS / self-hosted: no auth token provider, use cookie auth + tenant header
    headers["x-koji-tenant"] = tenantSlug;
  }

  // Project scope. Sent on both auth paths — the JWT carries the org (tenant)
  // but never the project, so the hosted path needs the header too. Omitted
  // when unknown, so the server falls back to the tenant's default project.
  const projectSlug = getCurrentProjectSlug(tenantSlug);
  if (projectSlug) {
    headers["x-koji-project"] = projectSlug;
  }

  const res = await fetch(url, {
    ...options,
    ...(useCredentials ? { credentials: "include" as RequestCredentials } : {}),
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),

  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),

  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form, isFormData: true }),

  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),

  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),

  delete: (path: string) =>
    request<void>(path, { method: "DELETE" }),

  /**
   * POST with FormData, returning the raw Response for SSE streaming.
   * Handles auth headers and tenant context identically to other methods.
   */
  streamForm: async (path: string, form: FormData, signal?: AbortSignal): Promise<Response> => {
    const url = `${API_BASE}${path}`;
    const tenantSlug = getCurrentTenantSlug();
    const headers: Record<string, string> = {};

    let useCredentials = true;
    if (authTokenProvider) {
      const token = await authTokenProvider();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        useCredentials = false;
      }
    } else if (tenantSlug) {
      headers["x-koji-tenant"] = tenantSlug;
    }

    return fetch(url, {
      method: "POST",
      headers,
      body: form,
      signal,
      ...(useCredentials ? { credentials: "include" as RequestCredentials } : {}),
    });
  },
};

// ── Typed endpoints ──

export interface SchemaRow {
  id?: string;
  slug: string;
  displayName: string;
  description: string | null;
  createdAt: string;
  draftYaml?: string | null;
  currentVersionId?: string | null;
  latestVersion?: number | null;
  /** Semver label of the latest version (e.g. `v1.2.0` or `v1.2.0-rc.3`). */
  latestVersionLabel?: string | null;
  corpusCount?: number;
}

export interface JobRow {
  slug: string;
  status: string;
  triggerType: string;
  docsTotal: number;
  docsProcessed: number;
  docsPassed: number;
  docsFailed: number;
  docsReviewing: number;
  avgLatencyMs: number | null;
  totalCostUsd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  pipelineSlug: string | null;
  pipelineName: string | null;
  schemaName: string | null;
  schemaVersion: number | null;
  /** Semver label of the schema version (e.g. `v1.2.0`). */
  schemaVersionLabel: string | null;
}

export interface JobDetail extends JobRow {
  id: string;
  schemaSlug: string | null;
}

/** Document-fit verdict, present when the schema declares a `fit` block. */
export interface FitReport {
  ok: boolean;
  action: "warn" | "reject";
  reason: string | null;
  message: string | null;
  score: number | null;
  extraction_skipped: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: Record<string, unknown> }>;
}

export interface JobDocument {
  id: string;
  filename: string;
  status: string;
  confidence: string | null;
  durationMs: number | null;
  costUsd: string | null;
  pageCount: number | null;
  extractionJson: unknown;
  validationJson: unknown;
  fitJson: FitReport | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TraceSummary {
  id: string;
  traceExternalId: string;
  status: string;
  totalDurationMs: number | null;
  startedAt: string;
  completedAt: string | null;
}

export interface TraceStageRow {
  id: string;
  stageName: string;
  stageOrder: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  summaryJson: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface DocumentDetail {
  documentId: string;
  filename: string;
  storageKey: string | null;
  mimeType: string | null;
  status: string;
  confidence: string | null;
  durationMs: number | null;
  costUsd: string | null;
  pageCount: number | null;
  extractionJson: unknown;
  confidenceScoresJson: Record<string, number> | null;
  provenanceJson: Record<string, {
    offset?: number;
    length?: number;
    chunk?: string;
    page?: number;
    bbox?: { x: number; y: number; w: number; h: number };
    words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
    reasoning?: string;
  } | null> | null;
  validationJson: unknown;
  fitJson: FitReport | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  jobId: string;
  jobSlug: string;
  schemaSlug: string | null;
  schemaName: string | null;
  schemaVersion: number | null;
  /** Semver label of the schema version (e.g. `v1.2.0`). */
  schemaVersionLabel: string | null;
  trace: TraceSummary | null;
  stages: TraceStageRow[];
  documentPreviewUrl: string | null;
}

// ── Overview ──

export interface OverviewMetrics {
  accuracy: number | null;
  documentsProcessed: number;
  reviewPending: number;
  pipelinesActive: number;
  schemaCount: number;
}

export interface OverviewActivity {
  type:
    | "job.completed"
    | "job.failed"
    | "schema.versioned"
    | "review.resolved"
    | "pipeline.updated"
    | "corpus.added";
  timestamp: string;
  description: string;
  link: string;
  status?: "ok" | "warn" | "pending";
  meta?: string;
}

export interface OverviewAttention {
  severity: "warning" | "info";
  kind: string;
  description: string;
  link: string;
}

export interface OverviewOnboarding {
  schemaCreated: boolean;
  documentUploaded: boolean;
  extractionRun: boolean;
  corpusEntries: boolean;
  validateRun: boolean;
  pipelineConfigured: boolean;
  firstSchemaSlug: string | null;
}

export interface OverviewPayload {
  metrics: OverviewMetrics;
  recentActivity: OverviewActivity[];
  needsAttention: OverviewAttention[];
  onboarding: OverviewOnboarding;
  accentLine: string;
}

export const overviewApi = {
  get: () => api.get<OverviewPayload>("/api/overview"),
};

/**
 * Server-normalized field metadata. Mirrors `SchemaFieldMeta` in the OpenAPI
 * spec (see `packages/api-spec/openapi.yaml`). The API parses the schema YAML
 * once and returns this shape; clients never parse YAML themselves.
 */
export interface SchemaFieldMeta {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  options?: string[];
  mappings?: Record<string, string[]>;
  pattern?: string;
}

export const schemas = {
  list: () => api.get<{ data: SchemaRow[] }>("/api/schemas").then((r) => r.data),
  get: (slug: string) => api.get<SchemaRow>(`/api/schemas/${slug}`),
  fields: (slug: string) =>
    api.get<{ fields: SchemaFieldMeta[] }>(`/api/schemas/${slug}/fields`).then((r) => r.fields),
  create: (body: { slug: string; display_name: string; description?: string; initial_yaml?: string }) =>
    api.post<SchemaRow>("/api/schemas", body),
  update: (slug: string, body: { display_name?: string; description?: string; draft_yaml?: string }) =>
    api.patch<SchemaRow>(`/api/schemas/${slug}`, body),
  delete: (slug: string) => api.delete(`/api/schemas/${slug}`),
};

// ── Classifiers ──

export interface ClassifierRow {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  draftYaml: string | null;
  createdAt: string;
  /** Latest version number (list route), or null if none committed. */
  latestVersion: number | null;
  /** Semver label of the latest version (e.g. `v1.2.0` or `v1.2.0-rc.3`). */
  latestVersionLabel: string | null;
}

export interface ClassifierDetail {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  draftYaml: string | null;
  createdAt: string;
  currentVersionId: string | null;
  latestVersion: {
    versionNumber: number;
    /** Semver label (e.g. `v1.2.0` or `v1.2.0-rc.3`). */
    version: string;
    yamlSource: string;
    commitMessage: string | null;
    createdAt: string;
  } | null;
}

export interface ClassifierVersion {
  id: string;
  versionNumber: number;
  version: string;
  prerelease: string | null;
  released: boolean;
  active: boolean;
  commitMessage: string | null;
  committedByName: string | null;
  createdAt: string;
}

/** Response of POST /api/classify. */
export interface ClassifyResult {
  label: string;
  confidence: number;
  method: string;
  tier_used: number;
  evidence_page: number | null;
  scores?: Array<{ id: string; score: number; hits: number; total: number; evidence_page: number | null }>;
  /** Present on a 422 reject (on_unknown: reject). */
  error?: string;
}

/** One row of GET /api/classifiers/:slug/corpus. */
export interface ClassifierCorpusEntry {
  id: string;
  documentId: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  source: string;
  /** The APPROVED (scored) label, or null when only a draft proposal exists. */
  label: string | null;
  /** Latest ground-truth version id — the target of an approve. */
  latestGtId: string | null;
  /** Agent-proposed draft label awaiting review (oss-456), or null. */
  proposedLabel: string | null;
  reviewStatus: string | null; // "draft" | "approved" | null
  authoredViaAgent: boolean;
  createdAt: string;
}

/** One pooled document from GET /api/corpus/documents (any artifact's uploads). */
export interface CorpusPoolDoc {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  contentHash: string;
  source: string;
  createdAt: string;
}

export interface ClassifierPerClass {
  label: string;
  support: number;
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}
export interface ClassifierConfusionCell {
  expected: string;
  predicted: string;
  count: number;
}
export interface ClassifierFlip {
  corpusEntryId: string;
  expected: string | null;
  from: string | null;
  to: string | null;
  kind: "fixed" | "regressed" | "churned";
}
/** Result of a classifier backtest (oss-452/453). */
export interface ClassifierValidateResult {
  runId?: string;
  version?: string | null;
  completedAt?: string | null;
  docsTotal: number;
  docsCorrect: number;
  docsFailed: number;
  accuracy: number | null;
  byClass: ClassifierPerClass[];
  confusion: ClassifierConfusionCell[];
  tierHistogram: Record<string, number>;
  escalationRate: number | null;
  flips: { fixed: number; regressed: number; churned: number; items: ClassifierFlip[] };
  costUsd: number | null;
}
export interface ClassifierValidateRunStatus {
  runId: string;
  status: string;
  docsTotal: number;
  docsProcessed: number;
  result: ClassifierValidateResult | null;
  error: string | null;
}
export interface ClassifierBootstrapProposal {
  entryId: string;
  gtId: string;
  documentId: string;
  filename: string | null;
  proposedLabel: string;
  confidence: number | null;
  method: string;
  tierUsed: number | null;
}
export interface ClassifierBootstrapResult {
  proposed: number;
  skipped: number;
  remainingHint: string | null;
  proposals: ClassifierBootstrapProposal[];
  message?: string;
}

/** Project-level corpus pool — documents any artifact has uploaded. */
export const corpusPool = {
  list: (params?: { content_hash?: string }) => {
    const qs = params?.content_hash ? `?content_hash=${encodeURIComponent(params.content_hash)}` : "";
    return api.get<{ data: CorpusPoolDoc[] }>(`/api/corpus/documents${qs}`).then((r) => r.data);
  },
};

export const classifiers = {
  list: () => api.get<{ data: ClassifierRow[] }>("/api/classifiers").then((r) => r.data),
  get: (slug: string) => api.get<ClassifierDetail>(`/api/classifiers/${slug}`),
  create: (body: { slug: string; display_name: string; description?: string; initial_yaml?: string }) =>
    api.post<ClassifierRow>("/api/classifiers", body),
  update: (slug: string, body: { display_name?: string; description?: string; draft_yaml?: string }) =>
    api.patch<ClassifierDetail>(`/api/classifiers/${slug}`, body),
  delete: (slug: string) => api.delete(`/api/classifiers/${slug}`),
  versions: (slug: string) =>
    api.get<{ data: ClassifierVersion[] }>(`/api/classifiers/${slug}/versions`).then((r) => r.data),
  commit: (slug: string, body: { yaml_source: string; commit_message?: string }) =>
    api.post<{ id: string; version: string; released: boolean; bump: string; deduped: boolean }>(
      `/api/classifiers/${slug}/versions`,
      body,
    ),
  promote: (slug: string) => api.post<{ released: string }>(`/api/classifiers/${slug}/promote`, {}),
  release: (slug: string, body?: { yaml_source?: string }) =>
    api.post<{ released: string; versionId: string }>(`/api/classifiers/${slug}/release`, body ?? {}),
  /**
   * Classify one document against an inline config (the current editor YAML),
   * non-persisting. Mirrors the schema Build-tab "Run" but for classification.
   */
  classify: (file: File, config: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("config", config);
    return api.postForm<ClassifyResult>("/api/classify", form);
  },

  // ── Corpus (oss-450/456) ──
  corpus: (slug: string) =>
    api.get<{ data: ClassifierCorpusEntry[] }>(`/api/classifiers/${slug}/corpus`).then((r) => r.data),
  /** Attach a pooled document (already uploaded by any artifact) as a label. */
  attachCorpus: (slug: string, documentId: string, label: string) =>
    api.post<ClassifierCorpusEntry>(`/api/classifiers/${slug}/corpus`, { document_id: documentId, label }),
  /** Upload + label a new document in one call. */
  uploadCorpus: (slug: string, file: File, label: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("label", label);
    return api.postForm<ClassifierCorpusEntry>(`/api/classifiers/${slug}/corpus`, form);
  },
  removeCorpus: (slug: string, entryId: string) =>
    api.delete(`/api/classifiers/${slug}/corpus/${entryId}`),
  /** Agent-propose draft labels for unlabeled pool documents. */
  bootstrap: (slug: string, limit?: number) =>
    api.post<ClassifierBootstrapResult>(`/api/classifiers/${slug}/corpus/bootstrap`, { limit }),
  /** Approve a draft label (optionally correcting it) into the scored ground truth. */
  approve: (slug: string, entryId: string, gtId: string, label?: string) =>
    api.post<{ label: string }>(
      `/api/classifiers/${slug}/corpus/${entryId}/ground-truth/${gtId}/approve`,
      label ? { label } : {},
    ),

  // ── Validate / backtest (oss-453) ──
  /** Start a backtest. `{async:true}` returns a runId to poll. */
  validate: (slug: string, opts?: { async?: boolean; version?: string }) =>
    api.post<ClassifierValidateResult & { runId?: string; status?: string; docsTotal?: number }>(
      `/api/classifiers/${slug}/validate`,
      opts ?? {},
    ),
  validateRun: (slug: string, runId: string) =>
    api.get<ClassifierValidateRunStatus>(`/api/classifiers/${slug}/validate/runs/${runId}`),
  /** The latest completed backtest, or null if never run. */
  validateLatest: (slug: string) =>
    api.get<ClassifierValidateResult | null>(`/api/classifiers/${slug}/validate`),
};

/** One row of GET /api/documents — the tenant/project-wide document list. */
export interface DocumentListRow {
  id: string;
  filename: string;
  status: string;
  mimeType: string | null;
  pageCount: number | null;
  confidence: string | null;
  createdAt: string;
  completedAt: string | null;
  jobSlug: string;
  pipelineSlug: string | null;
  pipelineName: string | null;
  schemaName: string | null;
  /** The document has open review items (the "needs attention" facet). */
  hasPendingReview: boolean;
}

export const documents = {
  list: (params?: {
    status?: string;
    pipeline?: string;
    /** ISO timestamp — only documents created after it. */
    since?: string;
    /** Filename substring, case-insensitive. */
    search?: string;
    /** Cursor for keyset pagination — ISO timestamp of last item's createdAt. */
    cursor?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.pipeline) qs.set("pipeline", params.pipeline);
    if (params?.since) qs.set("since", params.since);
    if (params?.search) qs.set("search", params.search);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return api.get<{
      data: DocumentListRow[];
      nextCursor: string | null;
      counts: { total: number; byStatus: Record<string, number> };
    }>(`/api/documents${q ? `?${q}` : ""}`);
  },
};

export const jobs = {
  list: (params?: {
    status?: string;
    pipeline?: string;
    /** Shorthand (`today` | `7d` | `30d` | `all`) or ISO timestamp. Absent = no date filter. */
    since?: string;
    /** Free-text search — matches document filenames and job IDs. */
    search?: string;
    /** Cursor for keyset pagination — ISO timestamp of last item's createdAt. */
    cursor?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.pipeline) qs.set("pipeline", params.pipeline);
    if (params?.since) qs.set("since", params.since);
    if (params?.search) qs.set("search", params.search);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return api.get<{
      data: JobRow[];
      nextCursor: string | null;
      counts: { total: number; byStatus: Record<string, number> };
    }>(`/api/jobs${q ? `?${q}` : ""}`);
  },
  /** Search documents by filename across all jobs. */
  searchDocuments: (q: string) =>
    api.get<{ data: Array<{ documentId: string; filename: string; status: string; jobSlug: string; createdAt: string }> }>(
      `/api/jobs/documents/search?q=${encodeURIComponent(q)}`,
    ).then((r) => r.data),
  get: (slug: string) => api.get<JobDetail>(`/api/jobs/${slug}`),
  documents: (slug: string) =>
    api.get<{ data: JobDocument[] }>(`/api/jobs/${slug}/documents`).then((r) => r.data),
  document: (jobSlug: string, docId: string) =>
    api.get<DocumentDetail>(`/api/jobs/${jobSlug}/documents/${docId}`),
  documentMarkdown: (jobSlug: string, docId: string) =>
    api.get<{
      markdown: string;
      pages: number | null;
      ocrSkipped: boolean;
      cachedAt: string;
    }>(`/api/jobs/${jobSlug}/documents/${docId}/markdown`),
  documentDeliveries: (jobSlug: string, docId: string) =>
    api
      .get<{ data: DocumentDelivery[] }>(
        `/api/jobs/${jobSlug}/documents/${docId}/deliveries`,
      )
      .then((r) => r.data),
  /**
   * Re-queue a document. By default reuses the cached parse and only re-runs
   * extraction; pass `{ reparse: true }` to force a fresh parse first (bypasses
   * and refreshes the parse cache) — needed when the parse itself was wrong.
   */
  rerunDocument: (jobSlug: string, docId: string, opts?: { reparse?: boolean }) =>
    api.post<{ ok: true }>(`/api/jobs/${jobSlug}/documents/${docId}/rerun`, {
      skip_cache: opts?.reparse === true,
    }),
  /** Resolve a normalized page region to the document text underneath it
   *  (highlight-to-correct). `text: null` = nothing there — fall back to
   *  typed input. */
  resolveRegion: (
    jobSlug: string,
    docId: string,
    body: { page: number; bbox: { x: number; y: number; w: number; h: number } },
  ) =>
    api.post<{
      text: string | null;
      words: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
      bbox: { x: number; y: number; w: number; h: number } | null;
    }>(`/api/jobs/${jobSlug}/documents/${docId}/resolve-region`, body),
  failDocument: (jobSlug: string, docId: string, reason?: string) =>
    api.post<{ ok: true }>(`/api/jobs/${jobSlug}/documents/${docId}/fail`, { reason }),
  /** Manually correct extracted values outside the review queue. Each entry
   *  becomes an audited `reason: "manual"` review item; a `document.corrected`
   *  webhook fires with the previous/new values. */
  correctDocument: (
    jobSlug: string,
    docId: string,
    body: {
      corrections: Array<{
        field: string;
        value: unknown;
        provenance?: {
          page: number;
          bbox: { x: number; y: number; w: number; h: number };
          words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
          chunk?: string;
        };
      }>;
      note?: string;
    },
  ) =>
    api.post<{ ok: true; reviewItemIds: string[]; extraction: Record<string, unknown> }>(
      `/api/jobs/${jobSlug}/documents/${docId}/corrections`,
      body,
    ),
};

export interface DocumentDelivery {
  id: string;
  eventType: string;
  status: string;
  httpStatus: number | null;
  responseBody: string | null;
  attemptCount: number;
  deliveredAt: string | null;
  createdAt: string;
  targetId: string;
  targetUrl: string | null;
  targetDisplayName: string | null;
}

// ── Review queue ──

export interface ReviewQueueStats {
  pending: number;
  urgent: number;
  completed: number;
  reviewedToday: number;
}

export interface ReviewRow {
  id: string;
  fieldName: string;
  reason: string;
  proposedValue: unknown;
  confidence: string | null;
  validationRule: string | null;
  status: string;
  resolution: string | null;
  /**
   * Whether the reviewer corrected the value rather than accepting it.
   * `resolution` is "approved" for both — see oss-494.
   */
  edited: boolean;
  finalValue: unknown;
  note: string | null;
  assignedTo: string | null;
  createdAt: string;
  resolvedAt: string | null;
  documentId: string | null;
  documentFilename: string | null;
  jobSlug: string | null;
  pipelineSlug: string | null;
  pipelineName: string | null;
  schemaSlug: string | null;
  schemaName: string | null;
}

export interface ReviewDetail extends ReviewRow {
  documentStorageKey: string | null;
  documentMimeType: string | null;
  documentExtractionJson: unknown;
  documentConfidenceScoresJson: Record<string, number> | null;
  documentPageCount: number | null;
  documentPreviewUrl: string | null;
  schemaVersion: number | null;
  /** Semver label of the schema version (e.g. `v1.2.0`). */
  schemaVersionLabel: string | null;
}

export const review = {
  list: (params?: { status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    const q = qs.toString();
    return api.get<{ data: ReviewRow[] }>(`/api/review${q ? `?${q}` : ""}`).then((r) => r.data);
  },
  stats: (params?: { urgentBelow?: number }) => {
    const qs = new URLSearchParams();
    if (params?.urgentBelow != null) qs.set("urgent_below", String(params.urgentBelow));
    const q = qs.toString();
    return api.get<ReviewQueueStats>(`/api/review/__queue/stats${q ? `?${q}` : ""}`);
  },
  get: (id: string) => api.get<ReviewDetail>(`/api/review/${id}`),
  queueIds: (status = "pending") =>
    api.get<{ data: string[] }>(`/api/review/__queue/ids?status=${status}`).then((r) => r.data),
  accept: (id: string, body?: { note?: string; fieldOverrides?: Record<string, unknown> }) =>
    api.post<ReviewRow>(`/api/review/${id}/accept`, body ?? {}),
  override: (
    id: string,
    body: {
      value: unknown;
      note?: string;
      fieldOverrides?: Record<string, unknown>;
      /** Anchored provenance (highlight-to-correct): where on the document
       *  the reviewer pointed for the corrected value. */
      provenance?: {
        page: number;
        bbox: { x: number; y: number; w: number; h: number };
        words?: Array<{ text: string; page: number; x: number; y: number; w: number; h: number }>;
        chunk?: string;
      };
    },
  ) => api.post<ReviewRow>(`/api/review/${id}/override`, body),
  reject: (id: string, body: { reason: string }) =>
    api.post<ReviewRow>(`/api/review/${id}/reject`, body),
  skip: (id: string) => api.post<void>(`/api/review/${id}/skip`),
  promote: (id: string, body?: { to?: string; provisional?: boolean }) =>
    api.post<{
      corpusEntryId: string;
      groundTruthId: string;
      reviewStatus: "draft" | "approved";
      provisional: boolean;
      deduped: boolean;
      filename: string;
      fieldCount: number;
    }>(`/api/review/${id}/promote`, body ?? {}),
};

// ── Pipelines ──

export interface PipelineRow {
  id: string;
  slug: string;
  displayName: string;
  schemaId: string | null;
  activeSchemaVersionId: string | null;
  modelProviderId: string | null;
  reviewThreshold: string;
  status: string;
  triggerType: string;
  lastRunAt: string | null;
  createdAt: string;
  schemaSlug: string | null;
  schemaName: string | null;
  deployedVersion: number | null;
  /** Semver label of the deployed version (e.g. `v1.2.0`). */
  deployedVersionLabel: string | null;
  modelProviderName: string | null;
  modelProviderModel: string | null;
  pipelineType?: string;
  docsTotal: number;
  docsPassed: number;
  docsFailed: number;
}

export interface PipelineDeployedVersion {
  id: string;
  number: number;
  version: string;
  commitMessage: string | null;
  deployedAt: string;
}

export interface PipelineConnectedSource {
  id: string;
  slug: string;
  displayName: string;
  sourceType: string;
  status: string;
  lastIngestedAt: string | null;
}

export interface PipelineRecentJob {
  id: string;
  slug: string;
  status: string;
  docsTotal: number;
  docsProcessed: number;
  docsPassed: number;
  docsFailed: number;
  avgLatencyMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  retryTransient: boolean;
}

/**
 * Defaults applied when a pipeline's retry policy is null. Mirror of the
 * server-side `DEFAULT_RETRY_POLICY` in `@koji/types/db` — kept in sync by
 * hand since the dashboard does not consume `@koji/types` directly.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 12,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  retryTransient: true,
};

export interface PipelineDetail {
  id: string;
  slug: string;
  displayName: string;
  schemaId: string | null;
  versionMode: "auto" | "pinned";
  activeSchemaVersionId: string | null;
  modelProviderId: string | null;
  parseProviderId: string | null;
  configJson: Record<string, unknown> | null;
  retryPolicy: RetryPolicy | null;
  reviewThreshold: string;
  yamlSource: string;
  triggerType: string;
  triggerConfigJson: Record<string, unknown> | null;
  status: string;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  schemaSlug: string | null;
  schemaName: string | null;
  modelProviderName: string | null;
  modelProviderModel: string | null;
  parseProviderName: string | null;
  parseProviderType: string | null;
  creatorEmail: string | null;
  creatorName: string | null;
  deployedVersion: PipelineDeployedVersion | null;
  connectedSources: PipelineConnectedSource[];
  recentJobs: PipelineRecentJob[];
  stats: { docsTotal: number; docsPassed: number; docsFailed: number; jobCount: number };
}

export interface SchemaVersion {
  id: string;
  versionNumber: number;
  /** Semver label (e.g. `v1.2.0` or `v1.2.0-rc.3`). */
  version: string;
  prerelease: string | null;
  released: boolean;
  /** True when this is the schema's live release (`currentVersionId`). */
  active: boolean;
  commitMessage: string | null;
  committedByName: string | null;
  createdAt: string;
}

export const pipelines = {
  list: () => api.get<{ data: PipelineRow[] }>("/api/pipelines").then((r) => r.data),
  get: (idOrSlug: string) => api.get<PipelineDetail>(`/api/pipelines/${idOrSlug}`),
  /**
   * Update pipeline configuration. Omit a field to leave it unchanged.
   * `parse_provider_id: null` clears the pin (revert to tenant default).
   * Changing `schema_id` resets the pipeline to `auto` version mode server-side.
   */
  update: (
    idOrSlug: string,
    body: {
      schema_id?: string;
      model_provider_id?: string;
      parse_provider_id?: string | null;
      review_threshold?: number;
    },
  ) => api.patch<PipelineDetail>(`/api/pipelines/${idOrSlug}`, body),
  schemaVersions: (schemaSlug: string) =>
    api
      .get<{ data: SchemaVersion[] }>(`/api/schemas/${schemaSlug}/versions`)
      .then((r) => r.data),
  pause: (idOrSlug: string) =>
    api.post<{ ok: true }>(`/api/pipelines/${idOrSlug}/pause`, {}),
  resume: (idOrSlug: string) =>
    api.post<{ ok: true }>(`/api/pipelines/${idOrSlug}/resume`, {}),
  deploy: (idOrSlug: string, schemaVersionId: string) =>
    api.post(`/api/pipelines/${idOrSlug}/deploy`, { schema_version_id: schemaVersionId }),
  /** Unpin: set the pipeline back to `auto` so it follows the schema's live release. */
  setAutoVersion: (idOrSlug: string) =>
    api.post(`/api/pipelines/${idOrSlug}/deploy`, { mode: "auto" }),
  delete: (idOrSlug: string) => api.delete(`/api/pipelines/${idOrSlug}`),
  /** Update the retry policy. Pass `null` to clear the override. */
  setRetryPolicy: (idOrSlug: string, policy: RetryPolicy | null) =>
    api.patch<{ retryPolicy: RetryPolicy | null }>(
      `/api/pipelines/${idOrSlug}/retry-policy`,
      policy,
    ),
  /** Manual run: upload one file via presigned URL, get back the new job slug. */
  run: async (idOrSlug: string, file: File) => {
    const upload = await import("./upload");
    const { storageKey } = await upload.uploadFile({ file, context: "test" });
    const form = new FormData();
    form.append("storageKey", storageKey);
    return api.postForm<{ jobId: string; jobSlug: string; documentId: string }>(
      `/api/pipelines/${idOrSlug}/run`,
      form,
    );
  },
  /** Add a document to an existing job via presigned URL (batch upload). */
  addDoc: async (idOrSlug: string, jobId: string, file: File) => {
    const upload = await import("./upload");
    const { storageKey } = await upload.uploadFile({ file, context: "test" });
    const form = new FormData();
    form.append("storageKey", storageKey);
    return api.postForm<{ documentId: string }>(
      `/api/pipelines/${idOrSlug}/jobs/${jobId}/docs`,
      form,
    );
  },
};

// ── Sources ──

export interface SourceRow {
  id: string;
  slug: string;
  displayName: string;
  sourceType: string;
  status: string;
  lastIngestedAt: string | null;
  createdAt: string;
  targetPipelineId: string | null;
}

export const sources = {
  list: () => api.get<{ data: SourceRow[] }>("/api/sources").then((r) => r.data),
  /** Set target pipeline. Pass `null` to disconnect. */
  setTargetPipeline: (sourceId: string, targetPipelineId: string | null) =>
    api.patch<SourceRow>(`/api/sources/${sourceId}`, {
      target_pipeline_id: targetPipelineId,
    }),
};

export interface ProjectRow {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  createdAt: string;
}

export const projectsApi = {
  list: () => api.get<{ data: ProjectRow[] }>("/api/projects").then((r) => r.data),
  get: (slug: string) => api.get<ProjectRow>(`/api/projects/${slug}`),
  create: (body: { slug: string; display_name: string; description?: string }) =>
    api.post<ProjectRow>("/api/projects", body),
};

export interface UserProfile {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  authProvider: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export const me = {
  get: () => api.get<UserProfile>("/api/me"),
  update: (body: { name?: string; email?: string }) =>
    api.patch<UserProfile>("/api/me", body),
  updatePassword: (body: { current_password: string; new_password: string }) =>
    api.post<{ ok: boolean }>("/api/me/password", body),
  canDelete: () => api.get<{ canDelete: boolean; reason?: string }>("/api/me/can-delete"),
  delete: () => api.delete("/api/me"),
};

// ── Notifications ────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  dataJson: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export const notificationsApi = {
  list: (opts?: { limit?: number; unreadOnly?: boolean }) =>
    api.get<{ data: NotificationRow[] }>(
      `/api/notifications?limit=${opts?.limit ?? 20}${opts?.unreadOnly ? "&unread_only=true" : ""}`,
    ).then((r) => r.data),
  count: () =>
    api.get<{ unread: number }>("/api/notifications/count").then((r) => r.unread),
  markRead: (id: string) =>
    api.patch<{ ok: boolean }>(`/api/notifications/${id}/read`, {}),
  markAllRead: () =>
    api.post<{ ok: boolean }>("/api/notifications/read-all"),
};
