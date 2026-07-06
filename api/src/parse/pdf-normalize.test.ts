/**
 * normalizePdfViaService tests (oss-377) — URL/header construction for both
 * parse backends and error surfacing. The HTTP layer is a stubbed global
 * fetch; the real endpoints are exercised in the parse services' own tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { normalizePdfViaService, pdfNormalizeConfigFromEnv } from "./pdf-normalize";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PDF = Buffer.from("%PDF-1.4 fake");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizePdfViaService", () => {
  it("POSTs multipart to <dockerUrl>/normalize-pdf and decodes the result", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ pdf_base64: Buffer.from("fixed").toString("base64"), pages: 3, byte_size: 5 }),
    );

    const out = await normalizePdfViaService(PDF, "doc.pdf", {
      backend: "docker",
      dockerUrl: "http://koji-parse:9410/",
    });

    expect(out.toString()).toBe("fixed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://koji-parse:9410/normalize-pdf");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("derives the modal URL from parse-http and sends proxy-auth headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ pdf_base64: Buffer.from("fixed").toString("base64") }),
    );

    await normalizePdfViaService(PDF, "doc.pdf", {
      backend: "modal",
      modalUrl: "https://org--koji-parse-parse-http.modal.run",
      modalTokenId: "ak-id",
      modalTokenSecret: "as-secret",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://org--koji-parse-normalize-pdf.modal.run");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Modal-Key"]).toBe("ak-id");
    expect(headers["Modal-Secret"]).toBe("as-secret");
  });

  it("throws with the response body on a non-2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "normalize failed: boom" }, 422));

    await expect(
      normalizePdfViaService(PDF, "doc.pdf", { backend: "docker", dockerUrl: "http://p:1" }),
    ).rejects.toThrow(/normalize-pdf 422.*boom/);
  });

  it("throws when the service returns no pdf_base64", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pages: 3 }));

    await expect(
      normalizePdfViaService(PDF, "doc.pdf", { backend: "docker", dockerUrl: "http://p:1" }),
    ).rejects.toThrow(/no pdf_base64/);
  });

  it("throws when the modal backend has no URL configured", async () => {
    await expect(
      normalizePdfViaService(PDF, "doc.pdf", { backend: "modal" }),
    ).rejects.toThrow(/KOJI_PARSE_MODAL_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pdfNormalizeConfigFromEnv — backend inference", () => {
  const ENV_KEYS = ["KOJI_PARSE_BACKEND", "KOJI_PARSE_URL", "KOJI_PARSE_MODAL_URL"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to docker with the sidecar URL when nothing is set", () => {
    const cfg = pdfNormalizeConfigFromEnv();
    expect(cfg.backend).toBe("docker");
    expect(cfg.dockerUrl).toBe("http://koji-parse:9410");
  });

  it("infers modal from KOJI_PARSE_MODAL_URL — the hosted platform hardcodes its backend in code, not env", () => {
    process.env.KOJI_PARSE_MODAL_URL = "https://org--koji-parse-parse-http.modal.run";
    expect(pdfNormalizeConfigFromEnv().backend).toBe("modal");
  });

  it("lets an explicit KOJI_PARSE_BACKEND win over the inference", () => {
    process.env.KOJI_PARSE_MODAL_URL = "https://org--koji-parse-parse-http.modal.run";
    process.env.KOJI_PARSE_BACKEND = "docker";
    expect(pdfNormalizeConfigFromEnv().backend).toBe("docker");
  });
});
