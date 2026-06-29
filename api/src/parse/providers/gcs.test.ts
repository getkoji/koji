/**
 * GCS JSON-API client tests.
 *
 * The Google Cloud Storage REST surface is mocked end-to-end (upload / list /
 * download / delete) so the client's request shapes, pagination, and idempotent
 * delete are verified without a live bucket. Used by the Document AI batch path.
 * Live-bucket validation is pending (needs a real SA token + bucket perms).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GcsClient, parseGcsUri, toGcsUri, joinGcsPath } from "./gcs";

const TOKEN = "ya29.fake-access-token";
const BUCKET = "my-tenant-bucket";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gs:// URI helpers", () => {
  it("parses a gs:// URI into bucket + object", () => {
    expect(parseGcsUri("gs://b/path/to/obj.json")).toEqual({
      bucket: "b",
      object: "path/to/obj.json",
    });
  });

  it("parses a bucket-root gs:// URI", () => {
    expect(parseGcsUri("gs://b")).toEqual({ bucket: "b", object: "" });
    expect(parseGcsUri("gs://b/")).toEqual({ bucket: "b", object: "" });
  });

  it("throws on a non-gs:// URI", () => {
    expect(() => parseGcsUri("https://example.com/x")).toThrow(/not a gs:\/\/ URI/);
  });

  it("round-trips via toGcsUri", () => {
    expect(toGcsUri("b", "a/b/c")).toBe("gs://b/a/b/c");
  });

  it("joins path segments with single slashes, trimming stray slashes", () => {
    expect(joinGcsPath("a/", "/b/", "c")).toBe("a/b/c");
    expect(joinGcsPath("", "x")).toBe("x");
  });
});

describe("GcsClient", () => {
  it("requires an access token", () => {
    expect(() => new GcsClient({ accessToken: "" })).toThrow(/accessToken is required/);
  });

  it("uploads bytes via a media upload with the Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    const gcs = new GcsClient({ accessToken: TOKEN });
    await gcs.upload(BUCKET, "in/run/doc.pdf", Buffer.from("PDFDATA"), "application/pdf");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/upload/storage/v1/b/${BUCKET}/o`);
    expect(url).toContain("uploadType=media");
    expect(url).toContain("name=in%2Frun%2Fdoc.pdf");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/pdf");
  });

  it("throws with the GCS error body on a failed upload", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const gcs = new GcsClient({ accessToken: TOKEN });
    await expect(
      gcs.upload(BUCKET, "o", Buffer.from("x"), "application/pdf"),
    ).rejects.toThrow(/gcs upload 403.*forbidden/);
  });

  it("lists objects under a prefix, following pagination", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ name: "out/run/0/doc-0.json" }], nextPageToken: "tok" }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ name: "out/run/0/doc-1.json" }] }));

    const gcs = new GcsClient({ accessToken: TOKEN });
    const names = await gcs.list(BUCKET, "out/run/");

    expect(names).toEqual(["out/run/0/doc-0.json", "out/run/0/doc-1.json"]);
    // Second call carries the page token.
    const [firstUrl] = fetchMock.mock.calls[0]!;
    const [secondUrl] = fetchMock.mock.calls[1]!;
    expect(firstUrl).toContain("prefix=out%2Frun%2F");
    expect(secondUrl).toContain("pageToken=tok");
  });

  it("downloads + JSON-parses an object", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ hello: "world" }));
    const gcs = new GcsClient({ accessToken: TOKEN });
    const obj = await gcs.downloadJson<{ hello: string }>(BUCKET, "out/run/0/doc-0.json");

    expect(obj).toEqual({ hello: "world" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/storage/v1/b/${BUCKET}/o/out%2Frun%2F0%2Fdoc-0.json`);
    expect(url).toContain("alt=media");
    expect(init.method).toBe("GET");
  });

  it("deletes an object", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const gcs = new GcsClient({ accessToken: TOKEN });
    await gcs.delete(BUCKET, "in/run/doc.pdf");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(`/storage/v1/b/${BUCKET}/o/in%2Frun%2Fdoc.pdf`);
    expect(init.method).toBe("DELETE");
  });

  it("treats a 404 delete as success (idempotent cleanup)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    const gcs = new GcsClient({ accessToken: TOKEN });
    await expect(gcs.delete(BUCKET, "gone")).resolves.toBeUndefined();
  });

  it("throws on a non-404 delete failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const gcs = new GcsClient({ accessToken: TOKEN });
    await expect(gcs.delete(BUCKET, "x")).rejects.toThrow(/gcs delete 403/);
  });
});
