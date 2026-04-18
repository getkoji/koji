/**
 * Password hashing using Node's built-in crypto.scrypt.
 * No external dependencies needed.
 *
 * Format: scrypt:salt:hash (all hex-encoded)
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = parts[1]!;
  const storedHash = Buffer.from(parts[2]!, "hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  return timingSafeEqual(storedHash, derived);
}
