/** A value or a promise of it: stores may be synchronous or asynchronous. */
export type Awaitable<T> = T | Promise<T>;

/** What an algorithm decides for one request. */
export interface Decision {
  /** Whether the request may go ahead. */
  allowed: boolean;
  /** Requests (units of cost) still available right now, after this one. */
  remaining: number;
  /** Milliseconds until the quota is fully restored. */
  resetMs: number;
  /** Milliseconds until a request of the same cost could succeed. 0 when allowed. */
  retryAfterMs: number;
}

/** One step of an algorithm: the new state to store, how long to keep it, and the decision. */
export interface Step<S> {
  state: S;
  ttlMs: number;
  result: Decision;
}

/**
 * A rate-limiting algorithm. `step()` must be a pure function of its
 * arguments: stores may call it more than once for one request (optimistic
 * concurrency), and its state must survive `JSON.stringify`.
 */
export interface Algorithm<S = unknown> {
  /** Short identifier such as `'fixed-window'`. */
  readonly name: string;
  /** Requests allowed per window (the bucket capacity for the token bucket). */
  readonly limit: number;
  /** The policy window in milliseconds, used for the `w` header parameter. */
  readonly windowMs: number;
  step(state: S | undefined, now: number, cost: number): Step<S>;
}

/**
 * Where limiter state lives. `update()` must run `fn` against the current
 * state of `key` and save the state it returns atomically: if another
 * request changed the key in between, it must run `fn` again on the new
 * state. `fn` is pure, so calling it again is safe.
 */
export interface Store {
  update<S>(key: string, now: number, fn: (state: S | undefined) => Step<S>): Awaitable<Decision>;
  delete(key: string): Awaitable<void>;
}

/** The result of `RateLimiter.consume()`. */
export interface RateLimitResult extends Decision {
  /** The key as given (without the store prefix). */
  key: string;
  limit: number;
  windowMs: number;
  /** Epoch milliseconds at which the quota is fully restored. */
  resetAt: number;
  /** The algorithm name. */
  algorithm: string;
}
