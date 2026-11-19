import type { Decision, Step, Store } from './types.js';

/**
 * The two Redis operations the store needs. Adapt any client in two lines:
 *
 * ```ts
 * // ioredis
 * const client = { get: (k) => redis.get(k), eval: (s, keys, args) => redis.eval(s, keys.length, ...keys, ...args) };
 * // node-redis v4+
 * const client = { get: (k) => redis.get(k), eval: (s, keys, args) => redis.eval(s, { keys, arguments: args }) };
 * ```
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null | undefined>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisLikeClient;
  /** How often to re-run an update that lost a race with another instance. Default 10. */
  maxRetries?: number;
}

/**
 * Compare-and-set: writes ARGV[2] with a PX of ARGV[3] only if the key still
 * holds ARGV[1] ('' meaning "missing"). Returns 1 on success, 0 on conflict.
 */
export const COMPARE_AND_SET_SCRIPT = `local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;

export const DELETE_SCRIPT = `return redis.call('DEL', KEYS[1])`;

/** Thrown when an update kept losing races for `maxRetries` attempts. */
export class StoreContentionError extends Error {
  constructor(key: string, attempts: number) {
    super(`Could not update rate limit key "${key}" after ${attempts} attempts (too much contention)`);
    this.name = 'StoreContentionError';
  }
}

/**
 * A store for Redis (or Valkey, KeyDB, Dragonfly, Upstash) through any client
 * that offers `GET` and `EVAL`. Each update reads the JSON state, runs the
 * algorithm in JavaScript and writes the result with an atomic
 * compare-and-set script, retrying if another instance got there first. All
 * algorithms behave exactly as with `MemoryStore`.
 */
export class RedisStore implements Store {
  readonly #client: RedisLikeClient;
  readonly #maxRetries: number;

  constructor(options: RedisStoreOptions) {
    this.#client = options.client;
    this.#maxRetries = options.maxRetries ?? 10;
  }

  async update<S>(key: string, _now: number, fn: (state: S | undefined) => Step<S>): Promise<Decision> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const raw = (await this.#client.get(key)) ?? null;
      const state = raw === null || raw === '' ? undefined : (JSON.parse(raw) as S);
      const step = fn(state);
      const ttl = String(Math.max(1, Math.ceil(step.ttlMs)));
      const ok = await this.#client.eval(
        COMPARE_AND_SET_SCRIPT,
        [key],
        [raw ?? '', JSON.stringify(step.state), ttl],
      );
      if (Number(ok) === 1) return step.result;
    }
    throw new StoreContentionError(key, this.#maxRetries + 1);
  }

  async delete(key: string) {
    await this.#client.eval(DELETE_SCRIPT, [key], []);
  }
}
