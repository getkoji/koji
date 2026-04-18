import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encrypt, decrypt, getMasterKey, keyHint } from "./envelope";
import { randomBytes } from "node:crypto";

const VALID_MASTER_KEY = randomBytes(32).toString("hex"); // 64 hex chars
const TENANT_A = "tenant-a-uuid-1234";
const TENANT_B = "tenant-b-uuid-5678";

describe("encrypt / decrypt roundtrip", () => {
  it("decrypt returns the original plaintext", () => {
    const plaintext = "sk-abc123secretkey";
    const blob = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    const result = decrypt(blob, VALID_MASTER_KEY, TENANT_A);
    expect(result).toBe(plaintext);
  });

  it("handles empty string", () => {
    const blob = encrypt("", VALID_MASTER_KEY, TENANT_A);
    expect(decrypt(blob, VALID_MASTER_KEY, TENANT_A)).toBe("");
  });

  it("handles long plaintext", () => {
    const plaintext = "x".repeat(10000);
    const blob = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    expect(decrypt(blob, VALID_MASTER_KEY, TENANT_A)).toBe(plaintext);
  });

  it("handles JSON credentials object", () => {
    const creds = JSON.stringify({
      api_key: "sk-longkey123",
      deployment: "my-gpt4",
      endpoint: "https://myorg.openai.azure.com",
    });
    const blob = encrypt(creds, VALID_MASTER_KEY, TENANT_A);
    const result = JSON.parse(decrypt(blob, VALID_MASTER_KEY, TENANT_A));
    expect(result.api_key).toBe("sk-longkey123");
    expect(result.deployment).toBe("my-gpt4");
  });

  it("handles unicode characters", () => {
    const plaintext = "key-with-émojis-🔐-and-日本語";
    const blob = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    expect(decrypt(blob, VALID_MASTER_KEY, TENANT_A)).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const plaintext = "same-key-every-time";
    const blob1 = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    const blob2 = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    expect(blob1).not.toBe(blob2);
    // But both decrypt to the same value
    expect(decrypt(blob1, VALID_MASTER_KEY, TENANT_A)).toBe(plaintext);
    expect(decrypt(blob2, VALID_MASTER_KEY, TENANT_A)).toBe(plaintext);
  });
});

describe("tenant isolation", () => {
  it("decrypt with wrong tenantId fails", () => {
    const blob = encrypt("sk-secret", VALID_MASTER_KEY, TENANT_A);
    expect(() => decrypt(blob, VALID_MASTER_KEY, TENANT_B)).toThrow();
  });

  it("each tenant gets a different derived key", () => {
    const plaintext = "same-key";
    const blobA = encrypt(plaintext, VALID_MASTER_KEY, TENANT_A);
    const blobB = encrypt(plaintext, VALID_MASTER_KEY, TENANT_B);
    // Can decrypt with correct tenant
    expect(decrypt(blobA, VALID_MASTER_KEY, TENANT_A)).toBe(plaintext);
    expect(decrypt(blobB, VALID_MASTER_KEY, TENANT_B)).toBe(plaintext);
    // Cannot cross-decrypt
    expect(() => decrypt(blobA, VALID_MASTER_KEY, TENANT_B)).toThrow();
    expect(() => decrypt(blobB, VALID_MASTER_KEY, TENANT_A)).toThrow();
  });
});

describe("master key validation", () => {
  it("decrypt with wrong masterKey fails", () => {
    const otherKey = randomBytes(32).toString("hex");
    const blob = encrypt("sk-secret", VALID_MASTER_KEY, TENANT_A);
    expect(() => decrypt(blob, otherKey, TENANT_A)).toThrow();
  });

  it("rejects master key that is too short", () => {
    expect(() => encrypt("test", "abcd", TENANT_A)).toThrow(/32 bytes/);
  });

  it("rejects master key that is too long", () => {
    const longKey = randomBytes(48).toString("hex"); // 96 hex chars = 48 bytes
    expect(() => encrypt("test", longKey, TENANT_A)).toThrow(/32 bytes/);
  });
});

describe("blob format", () => {
  it("produces a valid base64 string", () => {
    const blob = encrypt("test", VALID_MASTER_KEY, TENANT_A);
    expect(() => Buffer.from(blob, "base64")).not.toThrow();
    // Re-encoding should match (valid base64 roundtrip)
    const buf = Buffer.from(blob, "base64");
    expect(buf.toString("base64")).toBe(blob);
  });

  it("blob is at least IV + tag length", () => {
    const blob = encrypt("x", VALID_MASTER_KEY, TENANT_A);
    const buf = Buffer.from(blob, "base64");
    expect(buf.length).toBeGreaterThanOrEqual(12 + 16); // IV + auth tag
  });

  it("rejects truncated blob", () => {
    expect(() => decrypt("dG9vc2hvcnQ=", VALID_MASTER_KEY, TENANT_A)).toThrow(/too short/);
  });

  it("rejects tampered ciphertext", () => {
    const blob = encrypt("sk-secret", VALID_MASTER_KEY, TENANT_A);
    const buf = Buffer.from(blob, "base64");
    // Flip a byte in the ciphertext
    buf[buf.length - 1]! ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, VALID_MASTER_KEY, TENANT_A)).toThrow();
  });

  it("rejects tampered auth tag", () => {
    const blob = encrypt("sk-secret", VALID_MASTER_KEY, TENANT_A);
    const buf = Buffer.from(blob, "base64");
    // Flip a byte in the auth tag (bytes 12-27)
    buf[14]! ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, VALID_MASTER_KEY, TENANT_A)).toThrow();
  });
});

describe("keyHint", () => {
  it("returns last 4 characters", () => {
    expect(keyHint("sk-abc123xyz")).toBe("3xyz");
    expect(keyHint("short")).toBe("hort");
  });

  it("handles keys shorter than 4 chars", () => {
    expect(keyHint("abc")).toBe("abc");
    expect(keyHint("x")).toBe("x");
  });
});

describe("getMasterKey", () => {
  const original = process.env.KOJI_MASTER_KEY;

  afterEach(() => {
    if (original !== undefined) {
      process.env.KOJI_MASTER_KEY = original;
    } else {
      delete process.env.KOJI_MASTER_KEY;
    }
  });

  it("returns env var when set", () => {
    process.env.KOJI_MASTER_KEY = "abc123";
    expect(getMasterKey()).toBe("abc123");
  });

  it("returns null when not set", () => {
    delete process.env.KOJI_MASTER_KEY;
    expect(getMasterKey()).toBeNull();
  });
});
