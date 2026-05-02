/**
 * API client for the Koji server.
 *
 * In dev, the dashboard runs at :3002 and the API at :9401. In
 * production, they share a domain and the API is at /api/*.
 *
 * All responses are JSON. Errors throw with the Problem detail body.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

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

  constructor(status: number, body: { error?: string; title?: string; detail?: string }) {
    super(body.error ?? body.title ?? `API error ${status}`);
    this.status = status;
    this.detail = body.detail;
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
}

export interface JobDetail extends JobRow {
  id: string;
  schemaSlug: string | null;
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
  validationJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  jobId: string;
  jobSlug: string;
  schemaSlug: string | null;
  schemaName: string | null;
  schemaVersion: number | null;
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

export const schemas = {
  list: () => api.get<{ data: SchemaRow[] }>("/api/schemas").then((r) => r.data),
  get: (slug: string) => api.get<SchemaRow>(`/api/schemas/${slug}`),
  create: (body: { slug: string; display_name: string; description?: string; initial_yaml?: string }) =>
    api.post<SchemaRow>("/api/schemas", body),
  update: (slug: string, body: { display_name?: string; description?: string; draft_yaml?: string }) =>
    api.patch<SchemaRow>(`/api/schemas/${slug}`, body),
  delete: (slug: string) => api.delete(`/api/schemas/${slug}`),
};

export const jobs = {
  list: (params?: {
    status?: string;
    pipeline?: string;
    /** Shorthand (`today` | `7d` | `30d` | `all`) or ISO timestamp. Absent = no date filter. */
    since?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.pipeline) qs.set("pipeline", params.pipeline);
    if (params?.since) qs.set("since", params.since);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return api.get<{ data: JobRow[] }>(`/api/jobs${q ? `?${q}` : ""}`).then((r) => r.data);
  },
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
  rerunDocument: (jobSlug: string, docId: string) =>
    api.post<{ ok: true }>(`/api/jobs/${jobSlug}/documents/${docId}/rerun`, {}),
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

export interface ReviewRow {
  id: string;
  fieldName: string;
  reason: string;
  proposedValue: unknown;
  confidence: string | null;
  validationRule: string | null;
  status: string;
  resolution: string | null;
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
  documentPageCount: number | null;
  documentPreviewUrl: string | null;
  schemaVersion: number | null;
}

export const review = {
  list: (params?: { status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    const q = qs.toString();
    return api.get<{ data: ReviewRow[] }>(`/api/review${q ? `?${q}` : ""}`).then((r) => r.data);
  },
  get: (id: string) => api.get<ReviewDetail>(`/api/review/${id}`),
  queueIds: (status = "pending") =>
    api.get<{ data: string[] }>(`/api/review/__queue/ids?status=${status}`).then((r) => r.data),
  accept: (id: string, body?: { note?: string }) =>
    api.post<ReviewRow>(`/api/review/${id}/accept`, body ?? {}),
  override: (id: string, body: { value: unknown; note?: string }) =>
    api.post<ReviewRow>(`/api/review/${id}/override`, body),
  reject: (id: string, body: { reason: string }) =>
    api.post<ReviewRow>(`/api/review/${id}/reject`, body),
  skip: (id: string) => api.post<void>(`/api/review/${id}/skip`),
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
  activeSchemaVersionId: string | null;
  modelProviderId: string | null;
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
  commitMessage: string | null;
  committedByName: string | null;
  createdAt: string;
}

export const pipelines = {
  list: () => api.get<{ data: PipelineRow[] }>("/api/pipelines").then((r) => r.data),
  get: (idOrSlug: string) => api.get<PipelineDetail>(`/api/pipelines/${idOrSlug}`),
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
  delete: (idOrSlug: string) => api.delete(`/api/pipelines/${idOrSlug}`),
  /** Update the retry policy. Pass `null` to clear the override. */
  setRetryPolicy: (idOrSlug: string, policy: RetryPolicy | null) =>
    api.patch<{ retryPolicy: RetryPolicy | null }>(
      `/api/pipelines/${idOrSlug}/retry-policy`,
      policy,
    ),
  /** Manual run: upload one file, get back the new job slug. */
  run: (idOrSlug: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm<{ jobId: string; jobSlug: string; documentId: string }>(
      `/api/pipelines/${idOrSlug}/run`,
      form,
    );
  },
  /** Add a document to an existing job (batch upload). */
  addDoc: (idOrSlug: string, jobId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
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
