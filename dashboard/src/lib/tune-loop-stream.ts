/**
 * Client for the corpus-optimizing tune loop SSE endpoint
 * (`POST /api/schemas/:slug/tune/corpus-loop`). SSE can't go through the Next
 * proxy, so this discovers the direct API URL and parses the event stream,
 * delivering `round` and `complete` events via callbacks.
 * (Shares the shape of lib/extraction-run.ts; converging is tracked as a
 * follow-up.)
 */

import { getAuthTokenProvider } from "@/lib/api";

export interface LoopRound {
  n: number;
  accuracy: number;
  docsPassed: number;
  docsTotal: number;
  accepted: boolean;
  focusDoc: string;
  fixing: string[];
  regressions: string[];
  explanation: string;
}

export interface LoopResult {
  rounds: LoopRound[];
  finalYaml: string;
  finalAccuracy: number;
  baselineAccuracy: number;
  stopReason: "passed" | "no_improvement" | "max_iterations" | "propose_failed";
}

export interface RunLoopArgs {
  schemaSlug: string;
  tenantSlug: string;
  yaml: string;
  model?: string;
  maxIterations?: number;
  onRound: (r: LoopRound) => void;
  onComplete: (result: LoopResult) => void;
  onError: (error: string) => void;
}

async function discoverApiBase(): Promise<string> {
  let apiBase = "";
  try {
    const disco = await fetch("/_koji/api-url");
    if (disco.ok) {
      const { url } = await disco.json();
      if (url && !url.includes("koji-")) apiBase = url;
    }
  } catch {
    // fall through
  }
  if (!apiBase) {
    const dashPort = parseInt(window.location.port, 10);
    if (dashPort) apiBase = `http://localhost:${dashPort + 1}`;
  }
  return apiBase;
}

export async function runCorpusTuneLoopStream(args: RunLoopArgs): Promise<void> {
  const apiBase = await discoverApiBase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-koji-tenant": args.tenantSlug,
  };
  const tokenProvider = getAuthTokenProvider();
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const resp = await fetch(`${apiBase}/api/schemas/${args.schemaSlug}/tune/corpus-loop`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      yaml: args.yaml,
      ...(args.model ? { model: args.model } : {}),
      ...(args.maxIterations ? { max_iterations: args.maxIterations } : {}),
    }),
    ...(tokenProvider ? {} : { credentials: "include" as RequestCredentials }),
  });

  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string; detail?: string };
    args.onError(err.error ?? `HTTP ${resp.status}`);
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
        let data: unknown;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (currentEvent === "round") args.onRound(data as LoopRound);
        else if (currentEvent === "complete") args.onComplete(data as LoopResult);
        else if (currentEvent === "error") args.onError((data as { error?: string }).error ?? "Tuning loop failed");
        currentEvent = "message";
      }
    }
  }
}
