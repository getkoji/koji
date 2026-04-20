/**
 * API client for the Koji server.
 *
 * In dev, the dashboard runs at :3002 and the API at :9401. In
 * production, they share a domain and the API is at /api/*.
 *
 * All responses are JSON. Errors throw with the Problem detail body.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";

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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const tenantSlug = getCurrentTenantSlug();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };

  // Add tenant header for tenant-scoped API calls
  if (tenantSlug) {
    headers["x-koji-tenant"] = tenantSlug;
  }

  const res = await fetch(url, {
    ...options,
    credentials: "include",
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

  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),

  delete: (path: string) =>
    request<void>(path, { method: "DELETE" }),
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
  list: (params?: { status?: string; pipeline?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.pipeline) qs.set("pipeline", params.pipeline);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return api.get<{ data: JobRow[] }>(`/api/jobs${q ? `?${q}` : ""}`).then((r) => r.data);
  },
  get: (slug: string) => api.get<JobDetail>(`/api/jobs/${slug}`),
  documents: (slug: string) =>
    api.get<{ data: JobDocument[] }>(`/api/jobs/${slug}/documents`).then((r) => r.data),
};

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
