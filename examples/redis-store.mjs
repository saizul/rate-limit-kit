// A shared limit across several servers with Redis (or Valkey, KeyDB, Dragonfly, Upstash).
// rate-limit-kit does not depend on any Redis client: give it get() and eval().
//
//   npm install ioredis        (or: npm install redis)
//   REDIS_URL=redis://localhost:6379 node examples/redis-store.mjs
import { createRateLimiter, RedisStore, slidingWindowCounter } from '../dist/esm/index.js';

const url = process.env.REDIS_URL;
if (!url) {
  console.log('Set REDIS_URL (and install ioredis or redis) to run this example.');
  process.exit(0);
}

async function connect() {
  try {
    // ioredis: eval(script, numKeys, ...keys, ...args)
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(url);
    return {
      client: {
        get: (key) => redis.get(key),
        eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args),
      },
      close: () => redis.quit(),
    };
  } catch {
    // node-redis v4+: eval(script, { keys, arguments })
    const { createClient } = await import('redis');
    const redis = await createClient({ url }).connect();
    return {
      client: {
        get: (key) => redis.get(key),
        eval: (script, keys, args) => redis.eval(script, { keys, arguments: args }),
      },
      close: () => redis.quit(),
    };
  }
}

const { client, close } = await connect();
const limiter = createRateLimiter({
  algorithm: slidingWindowCounter({ limit: 5, windowMs: 10_000 }),
  store: new RedisStore({ client }),
  prefix: 'example:rl:',
});
await limiter.reset('demo');
for (let i = 1; i <= 7; i++) {
  const r = await limiter.consume('demo');
  console.log(
    i,
    r.allowed ? 'allowed' : `limited, retry in ${r.retryAfterMs} ms`,
    `remaining=${r.remaining}`,
  );
}
await close();
