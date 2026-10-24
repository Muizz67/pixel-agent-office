interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Small in-memory fixed-window limiter for a single-process local server. */
export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private lastSweep = 0;

  hit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    if (now - this.lastSweep > 60_000) {
      this.sweep(now);
      this.lastSweep = now;
    }
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }
}
