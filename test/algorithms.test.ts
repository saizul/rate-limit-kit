import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRateLimiter,
  fixedWindow,
  RateLimiter,
  slidingWindowCounter,
  slidingWindowLog,
  tokenBucket,
} from '../src/index.js';
import { limiterWith } from './helpers.js';

describe('fixedWindow', () => {
  it('allows limit requests per aligned window', async () => {
    const { hit, time } = limiterWith(fixedWindow({ limit: 3, windowMs: 1000 }), 10_000);
    assert.deepEqual(await hit(), [true, 2, 1000, 0]);
    assert.deepEqual(await hit(), [true, 1, 1000, 0]);
    assert.deepEqual(await hit(), [true, 0, 1000, 0]);
    assert.deepEqual(await hit(), [false, 0, 1000, 1000]);
    time.set(10_500);
    assert.deepEqual(await hit(), [false, 0, 500, 500]);
    time.set(11_000);
    assert.deepEqual(await hit(), [true, 2, 1000, 0]);
  });

  it('aligns windows to the clock, so a burst at the boundary gets twice the limit', async () => {
    const { hit, time } = limiterWith(fixedWindow({ limit: 2, windowMs: 1000 }), 999);
    assert.deepEqual(await hit(), [true, 1, 1, 0]);
    assert.deepEqual(await hit(), [true, 0, 1, 0]);
    time.set(1000);
    assert.deepEqual(await hit(), [true, 1, 1000, 0]);
  });

  it('supports a cost and does not count rejected requests', async () => {
    const { hit } = limiterWith(fixedWindow({ limit: 3, windowMs: 1000 }));
    assert.deepEqual(await hit('k', 2), [true, 1, 1000, 0]);
    assert.deepEqual(await hit('k', 2), [false, 1, 1000, 1000]);
    assert.deepEqual(await hit('k', 1), [true, 0, 1000, 0]);
  });

  it('keeps keys apart', async () => {
    const { hit } = limiterWith(fixedWindow({ limit: 1, windowMs: 1000 }));
    assert.equal((await hit('a'))[0], true);
    assert.equal((await hit('a'))[0], false);
    assert.equal((await hit('b'))[0], true);
  });
});

describe('slidingWindowLog', () => {
  it('counts exactly the requests of the last windowMs', async () => {
    const { hit, time } = limiterWith(slidingWindowLog({ limit: 3, windowMs: 1000 }));
    assert.deepEqual(await hit(), [true, 2, 1000, 0]);
    time.set(200);
    assert.deepEqual(await hit(), [true, 1, 1000, 0]);
    time.set(400);
    assert.deepEqual(await hit(), [true, 0, 1000, 0]);
    time.set(500);
    assert.deepEqual(await hit(), [false, 0, 900, 500]);
    time.set(1000);
    assert.deepEqual(await hit(), [true, 0, 1000, 0]);
    time.set(1100);
    assert.deepEqual(await hit(), [false, 0, 900, 100]);
  });

  it('retryAfter waits for enough entries to expire for the cost', async () => {
    const { hit, time } = limiterWith(slidingWindowLog({ limit: 3, windowMs: 1000 }));
    for (const t of [200, 400, 1000]) {
      time.set(t);
      await hit();
    }
    time.set(1100);
    assert.deepEqual(await hit('k', 2), [false, 0, 900, 300]);
    time.set(1400);
    assert.deepEqual(await hit('k', 2), [true, 0, 1000, 0]);
  });

  it('peek reports the empty state', async () => {
    const { limiter } = limiterWith(slidingWindowLog({ limit: 5, windowMs: 1000 }));
    const r = await limiter.peek('new');
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 5);
    assert.equal(r.resetMs, 0);
  });
});

describe('slidingWindowCounter', () => {
  it('weighs the previous window by its overlap', async () => {
    const { hit, time } = limiterWith(slidingWindowCounter({ limit: 10, windowMs: 1000 }));
    for (let i = 0; i < 10; i++) await hit();
    time.set(1000);
    assert.deepEqual(await hit(), [false, 0, 1000, 100]);
    time.set(1099);
    assert.equal((await hit())[0], false);
    time.set(1100);
    assert.deepEqual(await hit(), [true, 0, 1900, 0]);
    time.set(1500);
    // previous 10 * 0.5 + current 1 = 6 used
    assert.deepEqual(await hit(), [true, 3, 1500, 0]);
  });

  it('a rejection in the same window waits into the next one', async () => {
    const { hit, time } = limiterWith(slidingWindowCounter({ limit: 10, windowMs: 1000 }));
    for (let i = 0; i < 10; i++) await hit();
    time.set(500);
    assert.deepEqual(await hit(), [false, 0, 1500, 600]);
    time.set(1099);
    assert.equal((await hit())[0], false);
    time.set(1100);
    assert.equal((await hit())[0], true);
  });

  it('forgets a window that is two windows old', async () => {
    const { hit, time } = limiterWith(slidingWindowCounter({ limit: 2, windowMs: 1000 }));
    await hit();
    await hit();
    time.set(2000);
    assert.deepEqual(await hit(), [true, 1, 2000, 0]);
  });
});

describe('tokenBucket', () => {
  it('allows a burst of capacity, then refills continuously', async () => {
    const { hit, time } = limiterWith(tokenBucket({ capacity: 5, refillRate: 1 }));
    for (let i = 4; i >= 0; i--) assert.deepEqual((await hit()).slice(0, 2), [true, i]);
    assert.deepEqual(await hit(), [false, 0, 5000, 1000]);
    time.advance(500);
    assert.deepEqual(await hit(), [false, 0, 4500, 500]);
    time.advance(500);
    assert.deepEqual(await hit(), [true, 0, 5000, 0]);
    time.advance(10_000);
    assert.deepEqual(await hit(), [true, 4, 1000, 0]);
  });

  it('supports fast refill rates exactly', async () => {
    const { hit, time } = limiterWith(tokenBucket({ capacity: 2, refillRate: 10, intervalMs: 1000 }));
    await hit();
    await hit();
    assert.deepEqual(await hit(), [false, 0, 200, 100]);
    time.advance(100);
    assert.deepEqual(await hit(), [true, 0, 200, 0]);
  });

  it('reports the time to fill as the window', () => {
    assert.equal(tokenBucket({ capacity: 60, refillRate: 1 }).windowMs, 60_000);
    assert.equal(tokenBucket({ capacity: 10, refillRate: 5, intervalMs: 60_000 }).windowMs, 120_000);
  });

  it('a cost larger than the tokens left is rejected and costs nothing', async () => {
    const { hit } = limiterWith(tokenBucket({ capacity: 3, refillRate: 1 }));
    assert.deepEqual(await hit('k', 2), [true, 1, 2000, 0]);
    assert.deepEqual(await hit('k', 2), [false, 1, 2000, 1000]);
    assert.deepEqual(await hit('k', 1), [true, 0, 3000, 0]);
  });
});

describe('RateLimiter', () => {
  it('returns a full result object', async () => {
    const { limiter } = limiterWith(fixedWindow({ limit: 5, windowMs: 60_000 }), 1_000_000);
    assert.deepEqual(await limiter.consume('user-1'), {
      allowed: true,
      remaining: 4,
      resetMs: 20_000,
      retryAfterMs: 0,
      key: 'user-1',
      limit: 5,
      windowMs: 60_000,
      resetAt: 1_020_000,
      algorithm: 'fixed-window',
    });
  });

  it('reset() forgets a key and peek() uses nothing', async () => {
    const { limiter } = limiterWith(fixedWindow({ limit: 1, windowMs: 1000 }));
    await limiter.consume('k');
    assert.equal((await limiter.peek('k')).remaining, 0);
    assert.equal((await limiter.peek('k')).remaining, 0);
    await limiter.reset('k');
    assert.equal((await limiter.consume('k')).allowed, true);
  });

  it('rejects impossible or invalid costs', async () => {
    const { limiter } = limiterWith(fixedWindow({ limit: 3, windowMs: 1000 }));
    await assert.rejects(limiter.consume('k', 4), /larger than the limit/);
    await assert.rejects(limiter.consume('k', -1), RangeError);
    await assert.rejects(limiter.consume('k', 1.5), RangeError);
  });

  it('is atomic for concurrent requests in one process', async () => {
    const limiter = createRateLimiter({ algorithm: slidingWindowCounter({ limit: 10, windowMs: 1000 }) });
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.consume('burst')));
    assert.equal(results.filter((r) => r.allowed).length, 10);
  });

  it('validates algorithm options', () => {
    assert.throws(() => fixedWindow({ limit: 0, windowMs: 1000 }), RangeError);
    assert.throws(() => slidingWindowLog({ limit: 1, windowMs: 0.5 }), RangeError);
    assert.throws(() => tokenBucket({ capacity: 1, refillRate: 0 }), RangeError);
    assert.throws(() => new RateLimiter({} as never), TypeError);
  });

  it('uses the real clock by default', async () => {
    const limiter = new RateLimiter({ algorithm: fixedWindow({ limit: 1, windowMs: 60_000 }) });
    const r = await limiter.consume('k');
    assert.ok(Math.abs(r.resetAt - (Date.now() + r.resetMs)) < 1000);
  });
});
