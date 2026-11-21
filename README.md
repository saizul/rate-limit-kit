# rate-limit-kit

[![CI](https://github.com/saizul/rate-limit-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/saizul/rate-limit-kit/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/saizul/rate-limit-kit)](https://github.com/saizul/rate-limit-kit/releases)
[![npm (GitHub Packages)](https://img.shields.io/badge/npm-%40saizul%2Frate--limit--kit-blue)](https://github.com/saizul/rate-limit-kit/pkgs/npm/rate-limit-kit)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![TypeScript](https://img.shields.io/badge/types-included-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Rate limiting that works the same in Express, Next.js, Hono, Bun, Deno and Cloudflare Workers, in memory or on Redis.

- **Five algorithms**: token bucket, GCRA, fixed window, sliding window log and sliding window counter. Exact integer math, a cost per request, and rejected requests never use quota.
- **Pluggable stores**: an in-memory LRU store is built in. `RedisStore` works with *any* Redis client (ioredis, node-redis, Upstash, Valkey...) through two functions, `get` and `eval`, so there is no Redis dependency.
- **Middleware** for Express / Connect / `node:http`, for Fetch-API handlers (Next.js route handlers, Remix, SvelteKit, Bun.serve, Deno.serve, Workers) and for Hono.
- **Standard headers**: IETF `RateLimit-*` headers (draft 6, 7 or 8 and later), `Retry-After`, and optional legacy `X-RateLimit-*`.
- **Deterministic**: inject a clock and test your limits without waiting.
- Zero runtime dependencies, no Node APIs in the library. ESM, CommonJS and type declarations.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Choosing an algorithm](#choosing-an-algorithm)
- [The limiter](#the-limiter)
- [Middleware](#middleware)
- [Headers](#headers)
- [Stores](#stores)
- [Testing with a fake clock](#testing-with-a-fake-clock)
- [Examples](#examples)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Install

The package is published to GitHub Packages. Tell npm where `@saizul` packages live, once per project:

```console
$ echo "@saizul:registry=https://npm.pkg.github.com" >> .npmrc
$ npm install @saizul/rate-limit-kit
```

## Quick start

Express (or Connect, Polka, plain `node:http`):

```ts
import express from 'express';
import { createRateLimiter, rateLimit, slidingWindowCounter } from '@saizul/rate-limit-kit';

const limiter = createRateLimiter({ algorithm: slidingWindowCounter({ limit: 100, windowMs: 60_000 }) });

const app = express();
app.set('trust proxy', 1); // so req.ip is the client, not your load balancer
app.use(rateLimit(limiter)); // 100 requests per minute per IP
```

A Next.js route handler (any Fetch-API handler works the same way):

```ts
// app/api/login/route.ts
import { createRateLimiter, keyByHeader, tokenBucket, withRateLimit } from '@saizul/rate-limit-kit';

const limiter = createRateLimiter({ algorithm: tokenBucket({ capacity: 5, refillRate: 1, intervalMs: 60_000 }) });

export const POST = withRateLimit(limiter, { key: keyByHeader('x-forwarded-for') }, async (req) => {
  return Response.json({ ok: true });
});
```

Hono:

```ts
import { Hono } from 'hono';
import { createRateLimiter, fixedWindow, honoRateLimit } from '@saizul/rate-limit-kit';

const limiter = createRateLimiter({ algorithm: fixedWindow({ limit: 60, windowMs: 60_000 }) });
const app = new Hono();
app.use('/api/*', honoRateLimit(limiter, { key: (c) => c.req.header('cf-connecting-ip') ?? 'unknown' }));
```

Or call the limiter directly, for queues, jobs and anything that is not HTTP:

```ts
const result = await limiter.consume(`user:${userId}`);
if (!result.allowed) throw new Error(`Slow down, try again in ${result.retryAfterMs} ms`);
```

## Choosing an algorithm

| Algorithm | Memory per key | Behaviour | Use it for |
| --- | --- | --- | --- |
| `slidingWindowCounter({ limit, windowMs })` | 3 numbers | Weighs the previous window by its overlap with the sliding window. Smooth, close to exact. | **The default for APIs.** |
| `tokenBucket({ capacity, refillRate, intervalMs? })` | 2 numbers | A burst of up to `capacity`, then `refillRate` tokens per `intervalMs` (default 1 s), refilled continuously. | Allowing short bursts while capping the average rate; login attempts; outgoing calls. |
| `gcra({ limit, windowMs, burst? })` | 2 numbers | `limit` requests per `windowMs` spread evenly, with up to `burst` (default `limit`) back to back. Same answers as a token bucket. | Smooth limits on Redis with the smallest state; `burst: 1` spaces every request evenly. |
| `fixedWindow({ limit, windowMs })` | 2 numbers | `limit` per clock-aligned window. A client can get up to 2x `limit` around a boundary. | Quotas that reset at known times; the cheapest option. |
| `slidingWindowLog({ limit, windowMs })` | 1 timestamp per request | Exact: counts every request in the last `windowMs`. | Small limits that must be exact (e.g. 5 per hour). Avoid for limits in the thousands. |

All five take an integer `cost` per request (default 1), and none of them count rejected requests, so a client that waits for `Retry-After` gets in on time. Run `node examples/algorithms.mjs` to see them side by side.

An algorithm is a small object with a pure `step(state, now, cost)` function, so you can write your own (see the `Algorithm` type).

## The limiter

```ts
const limiter = createRateLimiter({
  algorithm: slidingWindowCounter({ limit: 100, windowMs: 60_000 }),
  store: new MemoryStore(), // default
  prefix: 'rl:', // default, prepended to every store key
  clock: Date.now, // default; inject a fake clock in tests
});

await limiter.consume(key, cost?); // takes quota and returns a result
await limiter.peek(key); // the same result without taking anything
await limiter.reset(key); // forget the key
```

`consume()` resolves to a `RateLimitResult`:

| Field | Meaning |
| --- | --- |
| `allowed` | Whether the request may go ahead. |
| `remaining` | Units left right now, after this request. |
| `resetMs` / `resetAt` | Milliseconds until (and the epoch time when) the quota is fully restored. |
| `retryAfterMs` | When rejected, milliseconds until a request of the same cost can succeed. 0 when allowed. |
| `limit`, `windowMs`, `algorithm`, `key` | The policy and the key as given. |

A `cost` larger than the limit can never succeed and throws a `RangeError`. Errors from the store are passed on.

## Middleware

All middleware accepts these options:

| Option | Default | Description |
| --- | --- | --- |
| `key` | Node: `req.ip`, then the socket address. Fetch and Hono: **required** | Which bucket the request belongs to. |
| `cost` | `1` | `(req) => number`, may be async. |
| `skip` | none | `(req) => boolean`, may be async. Skipped requests are not counted and get no headers. |
| `headers` | `{ standard: 'draft-6' }` | [Header options](#headers), or `false` for none. |
| `statusCode` | `429` | Status for rejected requests. |
| `message` | `'Too many requests, please try again later.'` | Body for rejected requests: a string is sent as text, anything else as JSON. Can be a function `(req, result)`. |
| `onLimited` | none | Replace the rejection entirely. Node: `(req, res, next, result)`. Fetch: `(req, result) => Response`. |
| `failOpen` | `false` | If the store throws (Redis is down), let requests through instead of failing them. |

**Node / Express / Connect**: `rateLimit(limiter, options)` returns `(req, res, next)`. It sets `req.rateLimit` to the result for later handlers and passes store errors to `next(err)`.

```ts
// A stricter limit for one route, keyed by account instead of IP.
app.post('/login', express.json(), rateLimit(loginLimiter, { key: (req) => req.body.email ?? req.ip }), login);
```

**Fetch-API handlers**: `withRateLimit(limiter, options, handler)` returns a handler with the same signature, extra arguments included (Next.js `context`, Workers `env` and `ctx`). Headers are added to the handler's response, even when its headers are immutable (`Response.redirect()`, a proxied `fetch()` response).

```ts
// Cloudflare Workers
export default {
  fetch: withRateLimit(limiter, { key: keyByHeader('cf-connecting-ip') }, async (req, env, ctx) => handle(req, env)),
};
// Bun
Bun.serve({ fetch: withRateLimit(limiter, { key: (req) => new URL(req.url).searchParams.get('token') ?? 'anon' }, handle) });
```

**Hono**: `honoRateLimit(limiter, options)` where `key`, `skip` and `cost` receive the Hono context `c`. It sets headers through `c.header()` and returns the 429 response when limited. It does not depend on Hono.

**Anything else**: `checkRequest(limiter, request, options)` returns `{ result, headers, response? }`; send `response` if it is set, otherwise add `headers` to yours.

**Which header is the client IP?** `keyByHeader(name)` reads the first value of a header your proxy sets: `cf-connecting-ip` on Cloudflare, `x-real-ip` behind nginx, `x-forwarded-for` behind most load balancers, `fly-client-ip` on Fly.io. Only trust a header that your own infrastructure sets or overwrites; anyone can send `x-forwarded-for: 1.2.3.4`. Better still, key by API token or user id when you have one.

## Headers

`rateLimitHeaders(result, options)` builds the headers; the middleware uses it for you. Times are whole seconds, rounded up.

| `standard` | Headers sent |
| --- | --- |
| `'draft-6'` (default) | `RateLimit-Policy: 100;w=60`, `RateLimit-Limit: 100`, `RateLimit-Remaining: 42`, `RateLimit-Reset: 31` |
| `'draft-7'` | `RateLimit-Policy: 100;w=60`, `RateLimit: limit=100, remaining=42, reset=31` |
| `'draft-8'` | `RateLimit-Policy: "default";q=100;w=60`, `RateLimit: "default";r=42;t=31` (name from `policyName`) |
| `false` | none |

Rejected requests also get `Retry-After` (disable with `retryAfter: false`). `legacy: true` adds `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds, as GitHub and others send it). The headers follow the IETF HTTPAPI working group's "RateLimit header fields for HTTP" drafts; draft 6 is the version most clients understand today.

## Stores

A store keeps one small JSON-serialisable state per key and must update it atomically:

```ts
interface Store {
  update<S>(key: string, now: number, fn: (state: S | undefined) => Step<S>): Decision | Promise<Decision>;
  delete(key: string): void | Promise<void>;
}
```

`fn` is pure: a store may run it again if another request changed the key in the meantime.

### MemoryStore

The default. Expiry and least-recently-used eviction, `maxKeys` (default 10 000) bounds memory. Updates are synchronous, so they are atomic within one process. `prune(now?)`, `clear()` and `size` are available. Use a shared store when you run more than one instance.

### RedisStore

```ts
import Redis from 'ioredis';
import { RedisStore } from '@saizul/rate-limit-kit';

const redis = new Redis(process.env.REDIS_URL);
const store = new RedisStore({
  client: {
    get: (key) => redis.get(key),
    eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args),
  },
});
```

With node-redis v4+: `eval: (script, keys, args) => redis.eval(script, { keys, arguments: args })`. With `@upstash/redis`: `eval: (script, keys, args) => redis.eval(script, keys, args)` (and `get` that returns the raw string, e.g. `new Redis({ ..., automaticDeserialization: false })`).

How it works: each update reads the key with `GET`, runs the same JavaScript algorithm as the memory store, and writes the result with this compare-and-set script, which only writes if nobody changed the key since the read. On a conflict it retries (up to `maxRetries`, default 10, then `StoreContentionError`). All algorithms therefore behave identically on Redis and in memory, and keys expire on their own through `PX`.

```lua
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
```

The script is exported as `COMPARE_AND_SET_SCRIPT` in case your Redis setup needs scripts loaded up front. In Redis Cluster each limiter key is a single key, so no hash tags are needed.

### Your own store

Implement `update` and `delete` for any database with a compare-and-set or transaction primitive: PostgreSQL (`UPDATE ... WHERE state = $old`), DynamoDB conditional writes, Cloudflare Durable Objects (single-threaded, so like `MemoryStore`).

## Testing with a fake clock

```ts
import assert from 'node:assert/strict';
import { createRateLimiter, tokenBucket } from '@saizul/rate-limit-kit';

let now = 0;
const limiter = createRateLimiter({ algorithm: tokenBucket({ capacity: 2, refillRate: 1 }), clock: () => now });

await limiter.consume('k');
await limiter.consume('k');
assert.equal((await limiter.consume('k')).retryAfterMs, 1000);
now += 1000;
assert.equal((await limiter.consume('k')).allowed, true);
```

## Examples

The scripts in [`examples/`](examples) run against the build without network access:

- [`algorithms.mjs`](examples/algorithms.mjs): the five algorithms on the same burst.
- [`node-http.mjs`](examples/node-http.mjs): the Node/Express middleware on a `node:http` server.
- [`fetch-handler.mjs`](examples/fetch-handler.mjs): a Fetch-API (Next.js style) handler.
- [`redis-store.mjs`](examples/redis-store.mjs): `RedisStore` with ioredis or node-redis (needs `REDIS_URL`).
- [`commonjs.cjs`](examples/commonjs.cjs): the CommonJS build.

## FAQ

**Which algorithm should I pick?** `slidingWindowCounter` for general API limits, `tokenBucket` when bursts are fine but the average must be capped.

**Why is `RateLimit-Reset` sometimes longer than the window?** It is the time until the quota is *fully* restored. With the sliding counter, requests in the current window still weigh on the next one, so full recovery can take up to two windows; `Retry-After` tells a client when its next request will succeed.

**Does a rejected request count?** No. Clients that hammer you stay blocked because each request is rejected, but a client that waits for `Retry-After` gets in on time.

**Can I limit by user and by IP at once?** Use two limiters and two middlewares, e.g. a generous per-IP limit globally and a strict per-account limit on `/login`.

**Is the memory store enough?** For one process, yes. With several instances (cluster mode, serverless, multiple pods) each has its own memory; use `RedisStore` or another shared store.

**What happens when Redis is down?** The middleware passes the error on (Node: `next(err)`; Fetch: the promise rejects) unless you set `failOpen: true`.

## Roadmap

Ideas for the next versions. Those marked *good first issue* are small and described in [CONTRIBUTING.md](CONTRIBUTING.md#good-first-issues).

- `draft-8` partition key (`pk`) parameter (*good first issue*)
- Ready-made `RateLimit-Policy` for several policies in one response
- A Fastify plugin and a Koa middleware (*good first issue*)
- A `blockDurationMs` option to ban a key for a while after it is limited
- Batch `consumeMany()` for multiple keys in one store round trip

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks CI runs and a list of beginner-friendly issues. Please follow the [code of conduct](CODE_OF_CONDUCT.md) and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Saizul Amin
