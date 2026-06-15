/**
 * Tiny in-memory TTL cache.
 *
 * Deliberately dependency-free per the plan's "don't over-engineer the cache
 * layer early" guidance. Good enough for a single-tenant dashboard. Entries
 * are evicted lazily on read and via an optional sweep. If we later move to a
 * multi-instance serverless deployment where in-memory state isn't shared,
 * swap this for Redis behind the same get/set interface.
 *
 * NOTE: On serverless platforms each cold start gets a fresh cache. That's
 * fine — worst case we make one extra upstream call after a cold start.
 */

interface Entry<T> {
  value: T;
  expiresAt: number; // epoch ms
}

export class TtlCache {
  private store = new Map<string, Entry<unknown>>();

  /** Returns the cached value, or undefined if missing/expired. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Stores a value with a TTL in seconds. */
  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Epoch ms the key was last written, or undefined. Used for "last synced" badges. */
  ageMeta(key: string): { expiresAt: number } | undefined {
    const entry = this.store.get(key);
    return entry ? { expiresAt: entry.expiresAt } : undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Memoizing helper: return the cached value or run `loader`, cache, return.
   * Concurrent callers for the same key share one in-flight promise so a burst
   * of requests during a cold cache doesn't fan out into N upstream calls.
   */
  async getOrLoad<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  private inflight = new Map<string, Promise<unknown>>();
}

/** Process-wide shared cache instance. */
export const cache = new TtlCache();
