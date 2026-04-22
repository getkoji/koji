import { describe, it, expect } from "vitest";
import { isTransientError } from "./errors";

describe("isTransientError", () => {
  describe("non-errors", () => {
    it("returns false for null/undefined/string/number", () => {
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
      expect(isTransientError("boom")).toBe(false);
      expect(isTransientError(42)).toBe(false);
    });
  });

  describe("timeouts / aborts", () => {
    it("returns true for AbortError", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      expect(isTransientError(err)).toBe(true);
    });

    it("returns true when message mentions timeout", () => {
      expect(isTransientError(new Error("request timeout after 120000ms"))).toBe(true);
      expect(isTransientError(new Error("Operation timed out"))).toBe(true);
    });

    it("returns true for AbortError nested in cause (undici fetch pattern)", () => {
      const err = new Error("fetch failed") as Error & { cause?: unknown };
      err.cause = Object.assign(new Error("aborted"), { name: "AbortError" });
      expect(isTransientError(err)).toBe(true);
    });
  });

  describe("connection errors", () => {
    it("returns true for ECONNREFUSED on code", () => {
      const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      expect(isTransientError(err)).toBe(true);
    });

    it("returns true for ECONNRESET", () => {
      const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      expect(isTransientError(err)).toBe(true);
    });

    it("returns true for EAI_AGAIN nested in cause", () => {
      const err = new Error("fetch failed") as Error & { cause?: unknown };
      err.cause = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      expect(isTransientError(err)).toBe(true);
    });

    it("returns true for bare 'fetch failed' with no status", () => {
      expect(isTransientError(new Error("fetch failed"))).toBe(true);
    });
  });

  describe("HTTP status", () => {
    it("returns true for 429 on status field", () => {
      const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
      expect(isTransientError(err)).toBe(true);
    });

    it("returns true for 5xx on status field", () => {
      expect(isTransientError(Object.assign(new Error("x"), { status: 500 }))).toBe(true);
      expect(isTransientError(Object.assign(new Error("x"), { status: 502 }))).toBe(true);
      expect(isTransientError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
      expect(isTransientError(Object.assign(new Error("x"), { status: 599 }))).toBe(true);
    });

    it("returns false for 4xx non-429 on status field", () => {
      expect(isTransientError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
      expect(isTransientError(Object.assign(new Error("x"), { status: 401 }))).toBe(false);
      expect(isTransientError(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
      expect(isTransientError(Object.assign(new Error("x"), { status: 422 }))).toBe(false);
    });

    it("parses HTTP status embedded in motor error messages", () => {
      // callParse / callExtract throw `new Error("parse <status>: ...")`
      expect(isTransientError(new Error("parse 503: bad gateway"))).toBe(true);
      expect(isTransientError(new Error("extract 502: upstream failure"))).toBe(true);
      expect(isTransientError(new Error("extract 429: rate limit exceeded"))).toBe(true);
    });

    it("returns false for 4xx in motor error messages", () => {
      expect(isTransientError(new Error("parse 400: bad request"))).toBe(false);
      expect(isTransientError(new Error("extract 422: schema invalid"))).toBe(false);
    });
  });

  describe("rate limiting / service availability phrases", () => {
    it("returns true for 'rate limit' phrases", () => {
      expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
      expect(isTransientError(new Error("rate_limit_exceeded"))).toBe(true);
      expect(isTransientError(new Error("Too Many Requests"))).toBe(true);
    });

    it("returns true for 'service unavailable' phrases", () => {
      expect(isTransientError(new Error("Service Unavailable"))).toBe(true);
      expect(isTransientError(new Error("temporarily unavailable"))).toBe(true);
      expect(isTransientError(new Error("Bad Gateway"))).toBe(true);
      expect(isTransientError(new Error("Gateway Timeout"))).toBe(true);
    });
  });

  describe("terminal errors", () => {
    it("returns false for schema YAML errors", () => {
      expect(isTransientError(new Error("Invalid schema YAML: unexpected indent"))).toBe(false);
    });

    it("returns false for 'parse returned no markdown'", () => {
      expect(isTransientError(new Error("parse returned no markdown"))).toBe(false);
    });

    it("returns false for 'File not found in storage'", () => {
      expect(isTransientError(new Error("File not found in storage"))).toBe(false);
    });

    it("returns false for generic Error with unrecognized message", () => {
      expect(isTransientError(new Error("something weird happened"))).toBe(false);
    });
  });
});
