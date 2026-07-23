/**
 * Shared extraction runner for the build workbench and the corpus labeling
 * queue — the "agent proposes values" step.
 *
 * `/api/extract/run` streams progress + the final result over SSE, which can't
 * go through the Next.js middleware proxy (long connections hang up), so this
 * discovers the direct API URL at runtime and parses the event stream itself.
 * It falls back to a plain JSON response when the server didn't stream. All
 * output is delivered through callbacks so callers own their own state; nothing
 * here touches React.
 *
 * Every caller goes through here. The build page used to keep its own copy of
 * this fetch and forgot the `x-koji-project` header, so a Run in any project
 * other than the tenant default resolved the corpus entry under the default
 * project and 404'd (oss-481). One runner, one place to get the headers right.
 */

import { getAuthTokenProvider, getCurrentProjectSlug } from "@/lib/api";

export interface ExtractionProgress {
  pages: number;
  scanned: boolean;
  ocr_skipped: boolean;
  estimated_seconds: number;
  percent: number;
  estimated_remaining_seconds: number;
  phase: "detecting" | "parsing" | "extracting" | "done";
}

/** The extraction result payload (the SSE `complete` event / JSON body). */
export interface ExtractionResult {
  extracted: Record<string, unknown>;
  confidence: number;
  confidence_scores?: Record<string, number>;
  provenance?: Record<string, unknown> | null;
  markdown?: string;
  model?: string;
  engine?: string;
  elapsed_ms?: number;
  error?: string;
  detail?: string;
  [k: string]: unknown;
}

/**
 * `R` lets a caller narrow the result it receives — the build workbench types
 * `provenance` down to the span shape its bbox highlighting needs. The runner
 * itself never inspects the payload beyond `error`, so the narrowing is the
 * caller's claim about its own endpoint response, not a runtime guarantee.
 */
export interface RunExtractionArgs<R extends ExtractionResult = ExtractionResult> {
  corpusEntryId: string;
  schemaYaml: string;
  tenantSlug: string;
  model?: string;
  skipCache?: boolean;
  onProgress?: (patch: Partial<ExtractionProgress>) => void;
  onComplete: (result: R) => void;
  onError: (error: string, detail?: string) => void;
}

/** Resolve the browser-reachable API base for SSE (proxy can't stream). */
async function discoverApiBase(): Promise<string> {
  let apiBase = "";
  try {
    const disco = await fetch("/_koji/api-url");
    if (disco.ok) {
      const { url } = await disco.json();
      // Only use the direct URL if it's not an in-container hostname.
      if (url && !url.includes("koji-")) apiBase = url;
    }
  } catch {
    // fall through to the port-guess below
  }
  if (!apiBase) {
    // In Docker the internal URL isn't reachable from the browser; the API is
    // conventionally on the dashboard port + 1.
    const dashPort = parseInt(window.location.port, 10);
    if (dashPort) apiBase = `http://localhost:${dashPort + 1}`;
  }
  return apiBase;
}

/**
 * Run an extraction and stream results to the callbacks. Resolves when the
 * stream (or JSON response) is fully consumed.
 */
export async function runExtraction<R extends ExtractionResult = ExtractionResult>(
  args: RunExtractionArgs<R>,
): Promise<void> {
  const { corpusEntryId, schemaYaml, tenantSlug, model, skipCache, onProgress, onComplete, onError } = args;
  const apiBase = await discoverApiBase();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-koji-tenant": tenantSlug,
  };
  // Direct SSE fetch bypasses the shared client — attach the active project so
  // project-scoped RLS resolves the schema/corpus (else 404 on project tenants).
  const projectSlug = getCurrentProjectSlug(tenantSlug);
  if (projectSlug) headers["x-koji-project"] = projectSlug;
  const tokenProvider = getAuthTokenProvider();
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const resp = await fetch(`${apiBase}/api/extract/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      corpus_entry_id: corpusEntryId,
      schema_yaml: schemaYaml,
      ...(model ? { model } : {}),
      ...(skipCache ? { skip_cache: true } : {}),
    }),
    ...(tokenProvider ? {} : { credentials: "include" as RequestCredentials }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
    onError(err.error ?? `HTTP ${resp.status}`, err.detail);
    return;
  }

  const contentType = resp.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const result = (await resp.json()) as R;
    if (result.error) onError(result.error, result.detail);
    else onComplete(result);
    return;
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "message";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        let data: any;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (currentEvent === "parse_started") {
          onProgress?.({
            pages: data.pages,
            scanned: data.scanned,
            ocr_skipped: data.ocr_skipped,
            estimated_seconds: data.estimated_seconds,
            phase: "parsing",
          });
        } else if (currentEvent === "parse_progress") {
          onProgress?.({
            percent: data.percent,
            estimated_remaining_seconds: data.estimated_remaining_seconds,
            phase: "parsing",
          });
        } else if (currentEvent === "parse_complete") {
          onProgress?.({ percent: 100, phase: "extracting" });
        } else if (currentEvent === "extracting") {
          onProgress?.({ phase: "extracting" });
        } else if (currentEvent === "complete") {
          onProgress?.({ phase: "done" });
          onComplete(data as R);
        } else if (currentEvent === "error") {
          onError(data.error ?? "Unknown error");
        }
        currentEvent = "message";
      }
    }
  }
}
