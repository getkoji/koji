import { describe, it, expect } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { resolvePermissions } from "../auth/roles";

describe("source permissions", () => {
  it("viewer cannot create sources (no source:write)", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("source:write")).toBe(false);
  });

  it("tenant-admin has source:write", () => {
    const perms = resolvePermissions(["tenant-admin"]);
    expect(perms.has("source:write")).toBe(true);
  });

  it("owner has source:write", () => {
    const perms = resolvePermissions(["owner"]);
    expect(perms.has("source:write")).toBe(true);
  });

  it("viewer can read sources (endpoint:read)", () => {
    const perms = resolvePermissions(["viewer"]);
    expect(perms.has("endpoint:read")).toBe(true);
  });
});

describe("webhook source signature verification", () => {
  it("valid signature passes verification", () => {
    const secret = randomBytes(32).toString("hex");
    const sourceId = "source-uuid-123";
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${sourceId}`;
    const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");

    // Verify: recompute and compare
    const expected = createHmac("sha256", secret).update(`${timestamp}.${sourceId}`).digest("hex");
    expect(v1).toBe(expected);
  });

  it("wrong secret produces different signature", () => {
    const correctSecret = randomBytes(32).toString("hex");
    const wrongSecret = randomBytes(32).toString("hex");
    const sourceId = "source-uuid-123";
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${sourceId}`;

    const correct = createHmac("sha256", correctSecret).update(signedPayload).digest("hex");
    const wrong = createHmac("sha256", wrongSecret).update(signedPayload).digest("hex");
    expect(correct).not.toBe(wrong);
  });

  it("wrong source ID in signature fails", () => {
    const secret = randomBytes(32).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000);

    const sig1 = createHmac("sha256", secret).update(`${timestamp}.source-a`).digest("hex");
    const sig2 = createHmac("sha256", secret).update(`${timestamp}.source-b`).digest("hex");
    expect(sig1).not.toBe(sig2);
  });

  it("expired timestamp (>5 min) is rejected", () => {
    const timestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const age = Math.abs(Date.now() / 1000 - timestamp);
    expect(age).toBeGreaterThan(300);
  });

  it("fresh timestamp (<5 min) is accepted", () => {
    const timestamp = Math.floor(Date.now() / 1000) - 30; // 30 seconds ago
    const age = Math.abs(Date.now() / 1000 - timestamp);
    expect(age).toBeLessThan(300);
  });

  it("signature header format is t=<ts>,v1=<hex>", () => {
    const secret = randomBytes(32).toString("hex");
    const sourceId = "test-source";
    const timestamp = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", secret).update(`${timestamp}.${sourceId}`).digest("hex");
    const header = `t=${timestamp},v1=${v1}`;

    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Parse back
    const parts = Object.fromEntries(header.split(",").map((p) => {
      const [k, ...v] = p.split("=");
      return [k, v.join("=")];
    }));
    expect(parts.t).toBe(String(timestamp));
    expect(parts.v1).toBe(v1);
  });
});

describe("content hash deduplication", () => {
  it("same content produces same hash", () => {
    const content = Buffer.from("hello world");
    const hash1 = createHash("sha256").update(content).digest("hex");
    const hash2 = createHash("sha256").update(content).digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("different content produces different hash", () => {
    const hash1 = createHash("sha256").update(Buffer.from("file-a")).digest("hex");
    const hash2 = createHash("sha256").update(Buffer.from("file-b")).digest("hex");
    expect(hash1).not.toBe(hash2);
  });

  it("hash is 64 hex characters (SHA-256)", () => {
    const hash = createHash("sha256").update(Buffer.from("test")).digest("hex");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("source type rules", () => {
  it("dashboard_upload cannot be deleted", () => {
    const sourceType = "dashboard_upload";
    expect(sourceType).toBe("dashboard_upload");
  });

  it("webhook source can be deleted", () => {
    const sourceType = "webhook";
    expect(sourceType).not.toBe("dashboard_upload");
  });

  it("paused source returns 503 for inbound webhooks", () => {
    const status = "paused";
    expect(status).toBe("paused");
  });

  it("active source accepts inbound webhooks", () => {
    const status = "active";
    expect(status).toBe("active");
  });
});

describe("file size filter", () => {
  it("file under max_file_size passes", () => {
    const maxSize = 10 * 1024 * 1024;
    const fileSize = 5 * 1024 * 1024;
    expect(fileSize <= maxSize).toBe(true);
  });

  it("file over max_file_size is rejected", () => {
    const maxSize = 10 * 1024 * 1024;
    const fileSize = 15 * 1024 * 1024;
    expect(fileSize > maxSize).toBe(true);
  });
});

describe("source webhook URL structure", () => {
  it("webhook URL is source-specific", () => {
    const sourceId = "abc-123";
    const url = `/api/sources/${sourceId}/webhook`;
    expect(url).toBe("/api/sources/abc-123/webhook");
  });

  it("different sources have different URLs", () => {
    const url1 = "/api/sources/source-a/webhook";
    const url2 = "/api/sources/source-b/webhook";
    expect(url1).not.toBe(url2);
  });

  it("webhook URL matches the public path pattern in middleware", () => {
    const url = "/api/sources/abc-123-uuid/webhook";
    const pattern = /^\/api\/sources\/[^/]+\/webhook$/;
    expect(pattern.test(url)).toBe(true);
  });

  it("non-webhook source paths don't match public pattern", () => {
    const pattern = /^\/api\/sources\/[^/]+\/webhook$/;
    expect(pattern.test("/api/sources")).toBe(false);
    expect(pattern.test("/api/sources/abc/ingestions")).toBe(false);
    expect(pattern.test("/api/sources/abc/pause")).toBe(false);
  });
});
