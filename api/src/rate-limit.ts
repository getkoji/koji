/**
 * Simple in-memory rate limiter for auth endpoints.
 *
 * Keyed by IP address. Sliding window via a fixed-size array of
 * timestamps. No external dependencies — suitable for single-process
 * self-hosted deployments.
 */

interface WindowEntry {
  timestamps: number[];
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false if rate-limited. */
  check(key: string): boolean;
}

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
}): RateLimiter {
  const { windowMs, max } = opts;
  const store = new Map<string, WindowEntry>();

  // Prune stale entries every 60s to prevent memory growth
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, 60_000).unref();

  return {
    check(key: string): boolean {
      const now = Date.now();
      let entry = store.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }

      // Drop timestamps outside the window
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

      if (entry.timestamps.length >= max) {
        return false;
      }

      entry.timestamps.push(now);
      return true;
    },
  };
}
