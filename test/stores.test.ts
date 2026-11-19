import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPARE_AND_SET_SCRIPT,
  DELETE_SCRIPT,
  fixedWindow,
  MemoryStore,
  type RedisLikeClient,
  RedisStore,
  RateLimiter,
  StoreContentionError,
  slidingWindowLog,
  tokenBucket,
} from '../src/index.js';
import { fakeClock, limiterWith } from './helpers.js';

const step = (ttlMs: number, value: number) => () => ({
  state: { value },
  ttlMs,
  result: { allowed: true, remaining: value, resetMs: ttlMs, retryAfterMs: 0 },
});

describe('MemoryStore', () => {
  it('expires entries after their ttl', () => {
    const store = new MemoryStore();
    store.update('a', 0, step(100, 1));
    let seen: unknown = 'unset';
    store.update('a', 99, (s) => {
      seen = s;
      return step(100, 2)();
    });
    assert.deepEqual(seen, { value: 1 });
    store.update('a', 199, (s) => {
      seen = s;
      return step(100, 3)();
    });
    assert.equal(seen, undefined);
  });

  it('evicts the least recently used key beyond maxKeys', () => {
    const store = new MemoryStore({ maxKeys: 2 });
    store.update('a', 0, step(1000, 1));
    store.update('b', 0, step(1000, 1));
    store.update('a', 1, step(1000, 2));
    store.update('c', 2, step(1000, 1));
    assert.equal(store.size, 2);
    const states: Record<string, unknown> = {};
    for (const key of ['a', 'b']) {
      store.update(key, 3, (s) => {
        states[key] = s;
        return step(1000, 9)();
      });
    }
    assert.deepEqual(states, { a: { value: 2 }, b: undefined });
  });

  it('prune() removes expired entries and clear() removes all', () => {
    const store = new MemoryStore();
    store.update('a', 0, step(10, 1));
    store.update('b', 0, step(1000, 1));
    assert.equal(store.prune(500), 1);
    assert.equal(store.size, 1);
    store.clear();
    assert.equal(store.size, 0);
  });

  it('validates maxKeys', () => {
    assert.throws(() => new MemoryStore({ maxKeys: 0 }), RangeError);
  });
});

/** An in-memory stand-in for Redis that understands the two scripts. */
function fakeRedis(clock: () => number) {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const read = (key: string) => {
    const e = data.get(key);
    if (!e || e.expiresAt <= clock()) return null;
    return e.value;
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  let evals = 0;
  const client: RedisLikeClient & { data: typeof data; evals: () => number } = {
    data,
    evals: () => evals,
    async get(key) {
      await tick();
      return read(key);
    },
    async eval(script, keys, args) {
      await tick();
      evals++;
      const key = keys[0]!;
      if (script === DELETE_SCRIPT) return data.delete(key) ? 1 : 0;
      assert.equal(script, COMPARE_AND_SET_SCRIPT);
      const [expected, next, px] = args as [string, string, string];
      if ((read(key) ?? '') !== expected) return 0;
      assert.match(px, /^\d+$/);
      data.set(key, { value: next, expiresAt: clock() + Number(px) });
      return 1;
    },
  };
  return client;
}

describe('RedisStore', () => {
  it('runs the algorithms just like the memory store', async () => {
    const time = fakeClock(10_000);
    const client = fakeRedis(time.clock);
    const { hit } = limiterWith(
      fixedWindow({ limit: 2, windowMs: 1000 }),
      10_000,
      new RedisStore({ client }),
    );
    // limiterWith has its own clock; keep both at the same time.
    assert.deepEqual(await hit(), [true, 1, 1000, 0]);
    assert.deepEqual(await hit(), [true, 0, 1000, 0]);
    assert.deepEqual(await hit(), [false, 0, 1000, 1000]);
    const stored = JSON.parse(client.data.get('rl:k')!.value);
    assert.deepEqual(stored, { s: 10_000, c: 2 });
    assert.equal(client.data.get('rl:k')!.expiresAt, 11_000);
  });

  it('stays exact under concurrent requests from many instances', async () => {
    const time = fakeClock(0);
    const client = fakeRedis(time.clock);
    // Five "servers", each with its own limiter object, sharing one Redis.
    const limiters = Array.from(
      { length: 5 },
      () =>
        new RateLimiter({
          algorithm: slidingWindowLog({ limit: 7, windowMs: 1000 }),
          store: new RedisStore({ client, maxRetries: 50 }),
          clock: time.clock,
        }),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => limiters[i % 5]!.consume('shared')),
    );
    assert.equal(results.filter((r) => r.allowed).length, 7);
    assert.ok(client.evals() > 20, 'some updates had to retry');
  });

  it('re-runs the update when another instance changed the key', async () => {
    const time = fakeClock(0);
    const client = fakeRedis(time.clock);
    const store = new RedisStore({ client });
    const limiter = new RateLimiter({
      algorithm: tokenBucket({ capacity: 3, refillRate: 1 }),
      store,
      clock: time.clock,
    });
    await limiter.consume('k');
    let interfered = false;
    const realGet = client.get.bind(client);
    client.get = async (key) => {
      const value = await realGet(key);
      if (!interfered) {
        interfered = true;
        // Someone else takes a token between our read and our write.
        await new RateLimiter({
          algorithm: tokenBucket({ capacity: 3, refillRate: 1 }),
          store,
          clock: time.clock,
        }).consume('k');
      }
      return value;
    };
    const r = await limiter.consume('k');
    assert.equal(r.remaining, 0);
  });

  it('gives up with StoreContentionError when it never wins', async () => {
    const client: RedisLikeClient = { get: async () => null, eval: async () => 0 };
    const limiter = new RateLimiter({
      algorithm: fixedWindow({ limit: 1, windowMs: 1000 }),
      store: new RedisStore({ client, maxRetries: 2 }),
    });
    await assert.rejects(limiter.consume('k'), StoreContentionError);
  });

  it('reset() deletes the key with a script', async () => {
    const time = fakeClock(0);
    const client = fakeRedis(time.clock);
    const limiter = new RateLimiter({
      algorithm: fixedWindow({ limit: 1, windowMs: 1000 }),
      store: new RedisStore({ client }),
      clock: time.clock,
    });
    await limiter.consume('k');
    await limiter.reset('k');
    assert.equal(client.data.has('rl:k'), false);
    assert.equal((await limiter.consume('k')).allowed, true);
  });
});
