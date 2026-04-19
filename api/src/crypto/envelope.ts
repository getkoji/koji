/**
 * Envelope encryption for model provider credentials.
 *
 * AES-256-GCM with per-tenant key derivation via HKDF.
 * The master key comes from KOJI_MASTER_KEY env var.
 *
 * Blob format: iv (12 bytes) + authTag (16 bytes) + ciphertext
 * Concatenated and base64-encoded as a single string.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HKDF_INFO = "koji-envelope";

/**
 * Derive a per-tenant encryption key from the master key.
 * Uses HKDF with SHA-256, salt = tenantId, info = "koji-envelope".
 */
function deriveKey(masterKey: Buffer, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, tenantId, HKDF_INFO, KEY_LENGTH),
  );
}

/**
 * Encrypt plaintext using AES-256-GCM with a per-tenant derived key.
 *
 * @returns base64-encoded blob: iv (12) + authTag (16) + ciphertext
 */
export function encrypt(plaintext: string, masterKey: string, tenantId: string): string {
  const keyBuf = Buffer.from(masterKey, "hex");
  if (keyBuf.length !== KEY_LENGTH) {
    throw new Error(`KOJI_MASTER_KEY must be 64 hex characters (32 bytes), got ${keyBuf.length} bytes`);
  }

  const derivedKey = deriveKey(keyBuf, tenantId);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv + authTag + ciphertext
  const blob = Buffer.concat([iv, authTag, encrypted]);
  return blob.toString("base64");
}

/**
 * Decrypt a base64-encoded blob using AES-256-GCM with a per-tenant derived key.
 *
 * @returns decrypted plaintext string
 * @throws if decryption fails (wrong key, wrong tenant, tampered data)
 */
export function decrypt(blob: string, masterKey: string, tenantId: string): string {
  const keyBuf = Buffer.from(masterKey, "hex");
  if (keyBuf.length !== KEY_LENGTH) {
    throw new Error(`KOJI_MASTER_KEY must be 64 hex characters (32 bytes), got ${keyBuf.length} bytes`);
  }

  const data = Buffer.from(blob, "base64");
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted blob: too short");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const derivedKey = deriveKey(keyBuf, tenantId);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Get the master key from the environment.
 * Returns null if not set (caller decides how to handle).
 */
export function getMasterKey(): string | null {
  return process.env.KOJI_MASTER_KEY ?? null;
}

/**
 * Extract the last 4 characters of a key for display hint.
 */
export function keyHint(key: string): string {
  return key.slice(-4);
}
