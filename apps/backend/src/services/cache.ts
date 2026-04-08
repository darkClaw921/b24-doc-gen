/**
 * Tiny in-memory TTL cache used by the REST proxy routes to avoid
 * pounding the Bitrix24 API with `crm.deal.fields` calls (which are
 * shape-stable but expensive).
 *
 * Not a real cache library — kept dependency-free on purpose. Each
 * entry stores `value` and `expiresAt` (epoch ms). `get` returns
 * `undefined` for missing or expired keys; `set` overwrites.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TTLCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** Returns the value if it exists and is still fresh. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Sets the value with the default TTL or a custom override. */
  set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /** Deletes a key explicitly (used by cache-busting endpoints). */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drops every entry. */
  clear(): void {
    this.store.clear();
  }

  /** Number of currently stored entries. */
  size(): number {
    return this.store.size;
  }
}
