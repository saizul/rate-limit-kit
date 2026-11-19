import type { Decision, Step, Store } from './types.js';

export interface MemoryStoreOptions {
  /** Most keys kept; the least recently used key is dropped beyond this. Default 10 000. */
  maxKeys?: number;
}

interface Entry {
  state: unknown;
  expiresAt: number;
}

/**
 * An in-process store with expiry and least-recently-used eviction.
 * Updates are synchronous, so they are atomic within one process. Use a
 * shared store such as `RedisStore` when you run several instances.
 */
export class MemoryStore implements Store {
  readonly maxKeys: number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: MemoryStoreOptions = {}) {
    const maxKeys = options.maxKeys ?? 10_000;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1)
      throw new RangeError('maxKeys must be a positive integer');
    this.maxKeys = maxKeys;
  }

  /** Keys currently held, including expired ones not yet pruned. */
  get size() {
    return this.#entries.size;
  }

  update<S>(key: string, now: number, fn: (state: S | undefined) => Step<S>): Decision {
    const entry = this.#entries.get(key);
    const current = entry && entry.expiresAt > now ? (entry.state as S) : undefined;
    const step = fn(current);
    // Delete and re-insert so the Map's order is least to most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, { state: step.state, expiresAt: now + step.ttlMs });
    while (this.#entries.size > this.maxKeys) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return step.result;
  }

  delete(key: string) {
    this.#entries.delete(key);
  }

  /** Removes expired entries. Returns how many were removed. */
  prune(now: number = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear() {
    this.#entries.clear();
  }
}
