import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../env";
import { upload } from "./upload";
import type { StorageProvider } from "../storage/provider";

// Mock withRLS to avoid real DB transaction + UUID validation
vi.mock("@koji/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    withRLS: (_db: any, _tenantId: string, fn: (tx: any) => Promise<any>) => fn(_db),
  };
});

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const SCHEMA_ID = "00000000-0000-0000-0000-000000000010";
const USER_ID = "00000000-0000-0000-0000-000000000099";

/**
 * Build a test app with the upload routes and mocked dependencies.
 */
function createUploadApp(opts: {
  storage?: Partial<StorageProvider>;
  schemaExists?: boolean;
  existingEntry?: Record<string, unknown> | null;
}) {
  const schemaExists = opts.schemaExists ?? true;
  const existingEntry = opts.existingEntry ?? null;

  const mockStorage: StorageProvider = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    getSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed-get"),
    getSignedUploadUrl: vi.fn().mockResolvedValue("https://s3.example.com/signed-put"),
    getBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from("test file content"),
      contentType: "application/pdf",
    }),
    ...opts.storage,
  };

  let insertedRow: Record<string, unknown> | null = null;

  // Track how many select() chains have been created to distinguish queries
  let selectCallCount = 0;

  const mockDb = {
    select: () => {
      const currentSelect = ++selectCallCount;
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => {
          // Each select() → from() → where() → limit() is one query.
          // Query 1 = schema lookup; Query 2 = dedup check (in complete handler)
          if (currentSelect === 1) {
            return Promise.resolve(schemaExists ? [{ id: SCHEMA_ID }] : []);
          }
          // Dedup check
          return Promise.resolve(existingEntry ? [existingEntry] : []);
        },
      };
      return chain;
    },
    insert: () => ({
      values: (row: any) => {
        insertedRow = row;
        return {
          returning: () =>
            Promise.resolve([{
              id: "ce-new",
              tenantId: TENANT_ID,
              filename: row.filename,
              storageKey: row.storageKey,
              fileSize: row.fileSize,
              mimeType: row.mimeType,
              contentHash: row.contentHash,
              source: row.source,
              tags: [],
              groundTruthJson: {},
              createdAt: new Date().toISOString(),
            }]),
        };
      },
    }),
  };

  const app = new Hono<Env>();

  // Inject context (bypass real auth)
  app.use("*", async (c, next) => {
    c.set("tenantId", TENANT_ID);
    c.set("principal", { userId: USER_ID, email: "test@koji.dev", name: "Test" } as any);
    c.set("grants", new Set(["corpus:read", "corpus:write", "schema:read"]));
    c.set("roles", ["owner"]);
    c.set("storage", mockStorage);
    c.set("db", mockDb as any);
    await next();
  });

  app.route("/api/upload", upload);
  return { app, mockStorage, getInsertedRow: () => insertedRow };
}

// ── Presign endpoint ──

describe("POST /api/upload/presign", () => {
  it("returns a presigned URL and storage key for corpus context", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        contentType: "application/pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploadUrl).toBe("https://s3.example.com/signed-put");
    expect(body.storageKey).toContain(`corpus/${TENANT_ID}/${SCHEMA_ID}/`);
    expect(body.storageKey).toMatch(/test\.pdf$/);
  });

  it("returns a presigned URL for test context without schemaSlug", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "invoice.pdf",
        contentType: "application/pdf",
        context: "test",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.storageKey).toContain(`test/${TENANT_ID}/ephemeral/`);
    expect(body.storageKey).toMatch(/invoice\.pdf$/);
  });

  it("rejects corpus context without schemaSlug", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        contentType: "application/pdf",
        context: "corpus",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("schemaSlug");
  });

  it("rejects missing filename", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contentType: "application/pdf",
        context: "test",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for nonexistent schema", async () => {
    const { app } = createUploadApp({ schemaExists: false });
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        contentType: "application/pdf",
        context: "corpus",
        schemaSlug: "nonexistent",
      }),
    });

    expect(res.status).toBe(404);
  });

  it("sanitizes filename in storage key", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "my file (1).pdf",
        contentType: "application/pdf",
        context: "test",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Spaces and parens should be replaced with underscores
    expect(body.storageKey).toMatch(/my_file__1_\.pdf$/);
  });

  it("calls storage.getSignedUploadUrl with correct args", async () => {
    const { app, mockStorage } = createUploadApp({});
    await app.request("/api/upload/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "test.pdf",
        contentType: "application/pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(mockStorage.getSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringContaining("test.pdf"),
      "application/pdf",
    );
  });
});

// ── Complete endpoint ──

describe("POST /api/upload/complete", () => {
  it("creates a corpus entry for a valid upload", async () => {
    const { app } = createUploadApp({});
    const storageKey = `corpus/${TENANT_ID}/${SCHEMA_ID}/12345-test.pdf`;
    const res = await app.request("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey,
        filename: "test.pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("ce-new");
    expect(body.filename).toBe("test.pdf");
  });

  it("returns existing entry for duplicate content hash", async () => {
    const existing = { id: "ce-existing", filename: "old.pdf", contentHash: "abc123" };
    const { app, mockStorage } = createUploadApp({ existingEntry: existing });
    const storageKey = `corpus/${TENANT_ID}/${SCHEMA_ID}/12345-test.pdf`;

    const res = await app.request("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey,
        filename: "test.pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("ce-existing");
    // Should clean up the duplicate upload
    expect(mockStorage.delete).toHaveBeenCalledWith(storageKey);
  });

  it("rejects storage key that doesn't belong to tenant", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey: "corpus/other-tenant-id/s1/12345-test.pdf",
        filename: "test.pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("returns 404 when file is not in storage", async () => {
    const { app } = createUploadApp({
      storage: { getBuffer: vi.fn().mockResolvedValue(null) },
    });
    const storageKey = `corpus/${TENANT_ID}/${SCHEMA_ID}/12345-test.pdf`;

    const res = await app.request("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey,
        filename: "test.pdf",
        context: "corpus",
        schemaSlug: "my-schema",
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found in storage");
  });

  it("rejects missing required fields", async () => {
    const { app } = createUploadApp({});
    const res = await app.request("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageKey: `corpus/${TENANT_ID}/${SCHEMA_ID}/12345-test.pdf`,
      }),
    });

    expect(res.status).toBe(400);
  });
});
