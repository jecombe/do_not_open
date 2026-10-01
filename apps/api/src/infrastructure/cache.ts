/**
 * A value read at most once per `ttlMs`, however many ask for it meanwhile: concurrent callers
 * share the read in flight. A failed read is not kept.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: Promise<V>; until: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.until > now) return hit.value;
    if (this.entries.size >= this.maxEntries) this.evict(now);
    const value = load();
    this.entries.set(key, { value, until: now + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  private evict(now: number) {
    for (const [k, e] of this.entries) if (e.until <= now) this.entries.delete(k);
    // Still full of live entries: drop the oldest.
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value as K);
  }
}

/**
 * Gathers the keys asked for within `windowMs` and loads them in one go: fifty boxes asking for
 * their next claim time cost one multicall, not fifty calls.
 */
export class Batcher<K, V> {
  private queue: { key: K; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly loadMany: (keys: K[]) => Promise<V[]>,
    private readonly windowMs = 20,
  ) {}

  load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      this.timer ??= setTimeout(() => void this.flush(), this.windowMs);
    });
  }

  private async flush() {
    const queue = this.queue;
    this.queue = [];
    this.timer = null;
    const keys = [...new Set(queue.map((q) => q.key))];
    try {
      const values = await this.loadMany(keys);
      const byKey = new Map(keys.map((k, i) => [k, values[i]!]));
      for (const q of queue) q.resolve(byKey.get(q.key)!);
    } catch (error) {
      for (const q of queue) q.reject(error);
    }
  }
}
