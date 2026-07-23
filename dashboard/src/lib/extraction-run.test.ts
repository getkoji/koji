/**
 * Header regression tests for the shared extraction runner (oss-481).
 *
 * `/api/extract/run` resolves the corpus entry under the request's project. A
 * run that omits `x-koji-project` is resolved against the tenant's DEFAULT
 * project, so every entry in any other project 404s as "Corpus entry not
 * found" — which is exactly how the build page's since-deleted private copy of
 * this fetch behaved. These tests pin the headers the runner must send.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Minimal browser globals: the runner reads location + localStorage. */
function installBrowser(pathname: string, store: Record<string, string> = {}) {
  Object.assign(globalThis, {
    window: { location: { pathname, port: "3002" } },
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
}

/** Capture the extract/run request; every other fetch (API discovery) 404s. */
function stubFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/api/extract/run")) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ extracted: { a: 1 }, confidence: 0.9 }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function run(overrides: { tenantSlug?: string } = {}) {
  const { runExtraction } = await import("./extraction-run");
  const onComplete = vi.fn();
  const onError = vi.fn();
  await runExtraction({
    corpusEntryId: "entry-1",
    schemaYaml: "name: quote\nfields: {}\n",
    tenantSlug: overrides.tenantSlug ?? "acme",
    onComplete,
    onError,
  });
  return { onComplete, onError };
}

describe("runExtraction request headers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("sends the project from the URL so a non-default project resolves its own corpus", async () => {
    installBrowser("/t/acme/projects/superkey-quote");
    const calls = stubFetch();

    const { onComplete, onError } = await run();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-koji-project"]).toBe("superkey-quote");
    expect(calls[0]!.headers["x-koji-tenant"]).toBe("acme");
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ extracted: { a: 1 }, confidence: 0.9 });
  });

  it("falls back to the persisted project selection on pages with no /projects/ segment", async () => {
    // The build page's URL is /t/<tenant>/schemas/<slug>/build — no project
    // segment at all, which is why the header has to come from the switcher's
    // persisted selection.
    installBrowser("/t/acme/schemas/quote_do/build", {
      "koji:project:acme": "superkey-quote",
    });
    const calls = stubFetch();

    await run();

    expect(calls[0]!.headers["x-koji-project"]).toBe("superkey-quote");
  });

  it("omits the project header when no project is known (server picks the default)", async () => {
    installBrowser("/t/acme/schemas/quote_do/build");
    const calls = stubFetch();

    await run();

    expect(calls[0]!.headers["x-koji-project"]).toBeUndefined();
  });

  it("reports a failed run through onError instead of onComplete", async () => {
    installBrowser("/t/acme/projects/superkey-quote");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("/api/extract/run")) {
          return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Corpus entry not found" }),
        } as unknown as Response;
      }),
    );

    const { onComplete, onError } = await run();

    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Corpus entry not found", undefined);
  });
});
