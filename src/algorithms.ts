import type { Algorithm, Step } from './types.js';

function positiveInt(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export interface WindowOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** State of `fixedWindow()`: window start and count. */
export interface FixedWindowState {
  s: number;
  c: number;
}

/**
 * `limit` requests per aligned window (for a minute window: 12:00:00 to
 * 12:00:59.999). Cheapest algorithm, but a client can send up to twice the
 * limit across a window boundary.
 */
export function fixedWindow(options: WindowOptions): Algorithm<FixedWindowState> {
  const limit = positiveInt('limit', options.limit);
  const windowMs = positiveInt('windowMs', options.windowMs);
  return {
    name: 'fixed-window',
    limit,
    windowMs,
    step(state, now, cost): Step<FixedWindowState> {
      const start = now - (now % windowMs);
      let count = state && state.s === start ? state.c : 0;
      const allowed = count + cost <= limit;
      if (allowed) count += cost;
      const reset = start + windowMs - now;
      return {
        state: { s: start, c: count },
        ttlMs: reset,
        result: { allowed, remaining: limit - count, resetMs: reset, retryAfterMs: allowed ? 0 : reset },
      };
    },
  };
}

/** State of `slidingWindowLog()`: one timestamp per unit of cost, oldest first. */
export interface SlidingLogState {
  h: number[];
}

/**
 * Exact sliding window: remembers the time of every request in the last
 * `windowMs`. Precise, but stores one timestamp per request, so use it for
 * limits up to a few thousand.
 */
export function slidingWindowLog(options: WindowOptions): Algorithm<SlidingLogState> {
  const limit = positiveInt('limit', options.limit);
  const windowMs = positiveInt('windowMs', options.windowMs);
  return {
    name: 'sliding-window-log',
    limit,
    windowMs,
    step(state, now, cost): Step<SlidingLogState> {
      const history = (state?.h ?? []).filter((t) => t > now - windowMs);
      const used = history.length;
      const allowed = used + cost <= limit;
      if (allowed) for (let i = 0; i < cost; i++) history.push(now);
      const newest = history[history.length - 1];
      const reset = newest === undefined ? 0 : newest + windowMs - now;
      let retryAfter = 0;
      if (!allowed) {
        // The oldest (used + cost - limit) entries must expire first.
        retryAfter = history[used + cost - limit - 1]! + windowMs - now;
      }
      return {
        state: { h: history },
        ttlMs: Math.max(1, reset),
        result: { allowed, remaining: limit - history.length, resetMs: reset, retryAfterMs: retryAfter },
      };
    },
  };
}

/** State of `slidingWindowCounter()`: current window start, its count and the previous window's count. */
export interface SlidingCounterState {
  s: number;
  c: number;
  p: number;
}

/**
 * Approximate sliding window: weighs the previous window's count by how much
 * of it still overlaps the sliding window. Constant memory and smooth, the
 * usual choice for APIs.
 */
export function slidingWindowCounter(options: WindowOptions): Algorithm<SlidingCounterState> {
  const limit = positiveInt('limit', options.limit);
  const windowMs = positiveInt('windowMs', options.windowMs);
  return {
    name: 'sliding-window-counter',
    limit,
    windowMs,
    step(state, now, cost): Step<SlidingCounterState> {
      const start = now - (now % windowMs);
      let current = 0;
      let previous = 0;
      if (state?.s === start) {
        current = state.c;
        previous = state.p;
      } else if (state?.s === start - windowMs) {
        previous = state.c;
      }
      // Everything is scaled by windowMs so the weighting stays in exact integers.
      const elapsed = now - start;
      const capacity = limit * windowMs;
      const weighted = previous * (windowMs - elapsed);
      const allowed = weighted + (current + cost) * windowMs <= capacity;
      if (allowed) current += cost;
      const used = weighted + current * windowMs;
      const remaining = Math.max(0, Math.floor((capacity - used) / windowMs));
      const reset = current > 0 ? start + 2 * windowMs - now : previous > 0 ? start + windowMs - now : 0;

      let retryAfter = 0;
      if (!allowed) {
        const room = limit - cost - current;
        if (room >= 0) {
          // Wait in this window until the previous window's weight has dropped enough.
          retryAfter = Math.ceil(windowMs - (room * windowMs) / previous) - elapsed;
        } else {
          // Wait for the next window, where this window's count becomes the previous one.
          const into = Math.ceil(windowMs - ((limit - cost) * windowMs) / current);
          retryAfter = start + windowMs - now + Math.max(0, into);
        }
        retryAfter = Math.max(1, retryAfter);
      }
      return {
        state: { s: start, c: current, p: previous },
        ttlMs: start + 2 * windowMs - now,
        result: { allowed, remaining, resetMs: reset, retryAfterMs: retryAfter },
      };
    },
  };
}

export interface TokenBucketOptions {
  /** Most tokens the bucket holds: the largest burst. */
  capacity: number;
  /** Tokens added every `intervalMs`, continuously (not in steps). */
  refillRate: number;
  /** Default 1000: `refillRate` tokens per second. */
  intervalMs?: number;
}

/** State of `tokenBucket()`: tokens multiplied by `intervalMs` (to keep the math exact) and the last update time. */
export interface TokenBucketState {
  t: number;
  l: number;
}

/**
 * Token bucket: a full bucket allows a burst of `capacity` requests, and
 * tokens come back at `refillRate` per `intervalMs`. Good for allowing short
 * bursts while capping the average rate.
 */
export function tokenBucket(options: TokenBucketOptions): Algorithm<TokenBucketState> {
  const capacity = positiveInt('capacity', options.capacity);
  const rate = positiveInt('refillRate', options.refillRate);
  const interval = positiveInt('intervalMs', options.intervalMs ?? 1000);
  // Tokens are counted in units of 1 / interval, so refills are whole numbers.
  const full = capacity * interval;
  return {
    name: 'token-bucket',
    limit: capacity,
    windowMs: Math.ceil(full / rate),
    step(state, now, cost): Step<TokenBucketState> {
      let tokens = state ? Math.min(full, state.t + Math.max(0, now - state.l) * rate) : full;
      const need = cost * interval;
      const allowed = tokens >= need;
      if (allowed) tokens -= need;
      const reset = Math.ceil((full - tokens) / rate);
      return {
        state: { t: tokens, l: now },
        ttlMs: Math.max(1, reset),
        result: {
          allowed,
          remaining: Math.floor(tokens / interval),
          resetMs: reset,
          retryAfterMs: allowed ? 0 : Math.ceil((need - tokens) / rate),
        },
      };
    },
  };
}
