import { type Algorithm, RateLimiter, type Store } from '../src/index.js';

/** A limiter with a hand-driven clock. */
export function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    set: (t: number) => {
      now = t;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

export function limiterWith(algorithm: Algorithm<unknown>, start = 0, store?: Store) {
  const time = fakeClock(start);
  const limiter = new RateLimiter({ algorithm, clock: time.clock, ...(store ? { store } : {}) });
  /** Consumes and returns [allowed, remaining, resetMs, retryAfterMs]. */
  const hit = async (key = 'k', cost = 1) => {
    const r = await limiter.consume(key, cost);
    return [r.allowed, r.remaining, r.resetMs, r.retryAfterMs];
  };
  return { limiter, time, hit };
}
