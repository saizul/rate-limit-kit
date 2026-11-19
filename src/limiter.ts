import { MemoryStore } from './memory-store.js';
import type { Algorithm, RateLimitResult, Store } from './types.js';

export interface RateLimiterOptions {
  /** `fixedWindow()`, `slidingWindowLog()`, `slidingWindowCounter()`, `tokenBucket()` or your own. */
  algorithm: Algorithm<unknown>;
  /** Default: a new `MemoryStore`. */
  store?: Store;
  /** Prepended to every key in the store. Default `'rl:'`. */
  prefix?: string;
  /** Clock in epoch milliseconds. Default `Date.now`; inject a fake one in tests. */
  clock?: () => number;
}

/** Applies one algorithm to many keys (users, IPs, API tokens) using a store. */
export class RateLimiter {
  readonly algorithm: Algorithm<unknown>;
  readonly store: Store;
  readonly prefix: string;
  readonly #clock: () => number;

  constructor(options: RateLimiterOptions) {
    if (!options?.algorithm || typeof options.algorithm.step !== 'function') {
      throw new TypeError(
        'options.algorithm is required, e.g. fixedWindow({ limit: 100, windowMs: 60_000 })',
      );
    }
    this.algorithm = options.algorithm;
    this.store = options.store ?? new MemoryStore();
    this.prefix = options.prefix ?? 'rl:';
    this.#clock = options.clock ?? Date.now;
  }

  get limit() {
    return this.algorithm.limit;
  }

  /**
   * Takes `cost` units (default 1) for `key`. Rejected requests take
   * nothing, so a client that backs off recovers on schedule.
   */
  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(cost) || cost < 0) throw new RangeError('cost must be a non-negative integer');
    if (cost > this.algorithm.limit) {
      throw new RangeError(
        `cost ${cost} is larger than the limit ${this.algorithm.limit} and can never succeed`,
      );
    }
    const now = this.#clock();
    const algorithm = this.algorithm;
    const decision = await this.store.update(this.prefix + key, now, (state) =>
      algorithm.step(state, now, cost),
    );
    return {
      ...decision,
      key,
      limit: algorithm.limit,
      windowMs: algorithm.windowMs,
      resetAt: now + decision.resetMs,
      algorithm: algorithm.name,
    };
  }

  /** The current quota for `key` without using any of it. */
  peek(key: string) {
    return this.consume(key, 0);
  }

  /** Forgets everything about `key`. */
  async reset(key: string) {
    await this.store.delete(this.prefix + key);
  }
}

/** Shorthand for `new RateLimiter(options)`. */
export function createRateLimiter(options: RateLimiterOptions) {
  return new RateLimiter(options);
}
