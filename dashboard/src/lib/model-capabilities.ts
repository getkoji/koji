/**
 * Client-side heuristic for inferring a model's capabilities from its id.
 *
 * Stopgap until `/api/model-registry` (platform-side) returns explicit
 * `capabilities: ("chat"|"vision"|"ocr")[]` per model — see platform-129.
 * When the registry surfaces capabilities directly, drop this file and
 * read them off the RegistryModel.
 *
 * The bar is "good enough so the user doesn't have to pick a capability
 * for the common case"; misses fall through to chat-only and the user
 * can still add vision/ocr rows manually via the inline dropdown on the
 * credential card.
 */

export type ModelCapability = "chat" | "vision" | "ocr";

const KNOWN_VISION_PREFIXES = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-haiku-4",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-opus",
  "gemini-1.5",
  "gemini-2",
  "llava",
  "pixtral",
];

const KNOWN_OCR_KEYWORDS = ["mistral-ocr", "unlimited-ocr", "-ocr"];

export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase().trim();
  if (!id) return ["chat"];

  // OCR engines aren't chat models — they take a PDF and return text,
  // not a conversation. Don't double-tag them.
  if (KNOWN_OCR_KEYWORDS.some((k) => id.includes(k))) {
    return ["ocr"];
  }

  const caps: ModelCapability[] = ["chat"];
  if (
    id.includes("vision") ||
    KNOWN_VISION_PREFIXES.some((p) => id.startsWith(p))
  ) {
    caps.push("vision");
  }
  return caps;
}
