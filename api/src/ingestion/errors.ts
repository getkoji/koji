/**
 * Error classification for the ingestion motor.
 *
 * The queue worker treats a thrown `TerminalError` as non-retryable and
 * anything else as retryable (exponential backoff with jitter, up to
 * `maxRetries`). The motor used to blanket-wrap every parse/extract failure
 * in `TerminalError`, which meant a single OpenAI 429 or an in-flight
 * connection reset from `koji-parse` would permanently fail the document —
 * forcing a manual re-ingest.
 *
 * `isTransientError` is the classifier that the motor uses to decide
 * whether to surface the error raw (retry) or wrap it as TerminalError
 * (give up). Everything we can't confidently call transient stays terminal
 * — better to fail loud than retry a malformed schema forever.
 */

interface ErrorLike {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
}

function asErrorLike(err: unknown): ErrorLike | null {
  if (err && typeof err === "object") return err as ErrorLike;
  return null;
}

function getString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function getNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Scan the error surface (message, name, code, status, cause) for signals
 * that the underlying failure is transient — i.e. a retry has a reasonable
 * chance of succeeding without any human intervention.
 *
 * Signals we treat as transient:
 *  - HTTP 5xx from an internal service (parse, extract)
 *  - HTTP 429 / rate-limit phrases from model providers
 *  - Connection errors: ECONNREFUSED, ECONNRESET, EAI_AGAIN, ETIMEDOUT,
 *    ENOTFOUND, generic "fetch failed" with no status
 *  - Timeouts: AbortError, messages containing "timeout"
 *  - Provider 503 / "service unavailable"
 *
 * Everything else (4xx other than 429, schema YAML parse errors, validation
 * failures, anything we don't recognise) is treated as terminal.
 */
export function isTransientError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  const e = asErrorLike(err);
  if (!e) return false;

  const message = getString(e.message).toLowerCase();
  const name = getString(e.name);
  const code = getString(e.code);

  // AbortError / timeout name or phrase
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (message.includes("timeout") || message.includes("timed out")) return true;

  // Network / DNS error codes (Node). May live on err.code or err.cause.code.
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ]);
  if (networkCodes.has(code)) return true;

  const cause = asErrorLike(e.cause);
  if (cause) {
    const causeCode = getString(cause.code);
    if (networkCodes.has(causeCode)) return true;
    const causeName = getString(cause.name);
    if (causeName === "AbortError" || causeName === "TimeoutError") return true;
    const causeMessage = getString(cause.message).toLowerCase();
    if (causeMessage.includes("timeout") || causeMessage.includes("timed out")) return true;
  }

  // Undici / fetch surfaces "fetch failed" on DNS / TCP errors with the real
  // cause hanging off err.cause. We already inspect the cause above, but a
  // bare "fetch failed" with no status is almost always transient (connection
  // refused / hung up mid-request).
  if (message === "fetch failed" || message.startsWith("fetch failed")) return true;

  // Rate-limit phrases from OpenAI / Anthropic SDKs and our own wrapped errors.
  if (
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("too many requests")
  ) {
    return true;
  }

  // "service unavailable" / "temporarily unavailable" phrasing.
  if (
    message.includes("service unavailable") ||
    message.includes("temporarily unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout")
  ) {
    return true;
  }

  // HTTP status — either on the error object (SDKs) or embedded in the
  // message. callParse / callExtract throw `new Error("parse <status>: …")`
  // so we need to pick the status out of the message too.
  const explicitStatus = getNumber(e.status) ?? getNumber(e.statusCode);
  if (explicitStatus !== null) {
    if (explicitStatus === 429) return true;
    if (explicitStatus >= 500 && explicitStatus <= 599) return true;
  }

  // Messages emitted by callParse / callExtract look like:
  //   "parse 503: upstream timeout"
  //   "extract 429: rate limit exceeded"
  const statusInMessage = message.match(/\b(parse|extract|fetch)\s+(\d{3})\b/);
  if (statusInMessage) {
    const status = Number(statusInMessage[2]);
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }

  return false;
}
