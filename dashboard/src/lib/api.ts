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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
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
  slug: string;
  displayName: string;
  description: string | null;
  createdAt: string;
  draftYaml?: string | null;
  currentVersionId?: string | null;
}

export interface JobRow {
  slug: string;
  status: string;
  docsTotal: number;
  docsProcessed: number;
  docsPassed: number;
  docsFailed: number;
  avgLatencyMs: number | null;
  totalCostUsd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

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
  list: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return api.get<{ data: JobRow[] }>(`/api/jobs${q ? `?${q}` : ""}`).then((r) => r.data);
  },
  get: (slug: string) => api.get<JobRow>(`/api/jobs/${slug}`),
};

export interface TenantRow {
  id: string;
  slug: string;
  displayName: string;
}

export const tenants = {
  list: () => api.get<{ data: TenantRow[] }>("/api/tenants").then((r) => r.data),
  update: (slug: string, body: { display_name?: string }) =>
    api.patch<TenantRow>(`/api/tenants/${slug}`, body),
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
};
