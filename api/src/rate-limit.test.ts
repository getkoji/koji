import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests under the limit", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
  });

  it("blocks requests at the limit", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false); // 4th request blocked
    expect(limiter.check("ip-1")).toBe(false); // still blocked
  });

  it("tracks different keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false); // ip-1 blocked

    expect(limiter.check("ip-2")).toBe(true); // ip-2 still allowed
    expect(limiter.check("ip-2")).toBe(true);
    expect(limiter.check("ip-2")).toBe(false); // ip-2 now blocked
  });

  it("allows requests again after window expires", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(61_000);

    expect(limiter.check("ip-1")).toBe(true); // allowed again
  });

  it("sliding window drops old timestamps", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    expect(limiter.check("ip-1")).toBe(true); // t=0
    vi.advanceTimersByTime(30_000);
    expect(limiter.check("ip-1")).toBe(true); // t=30s
    expect(limiter.check("ip-1")).toBe(false); // t=30s, at limit

    vi.advanceTimersByTime(31_000); // t=61s — first request dropped from window
    expect(limiter.check("ip-1")).toBe(true); // allowed (only t=30s request in window)
  });

  it("handles max=1 (one request per window)", () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });

    expect(limiter.check("ip-1")).toBe(true);
    expect(limiter.check("ip-1")).toBe(false);

    vi.advanceTimersByTime(10_001);
    expect(limiter.check("ip-1")).toBe(true);
  });
});
