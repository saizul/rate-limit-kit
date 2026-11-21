# Contributing

Thanks for helping improve rate-limit-kit. New algorithms, store adapters,
framework middleware, bug reports and documentation fixes are all welcome.
If you are new to open source, start with one of the
[beginner issues](#good-first-issues) below; each is small and comes with
pointers to the files involved.

## Reporting a bug

Open an issue with:

- the algorithm and its options, the store and the middleware you use
- the sequence of requests (times and costs) and the results you got, and
  what you expected; a failing test with a fake clock is ideal
- your rate-limit-kit version and runtime (`node --version`, Bun, Deno,
  Workers)

## Development setup

You need Node 20 or newer.

```console
$ git clone https://github.com/saizul/rate-limit-kit.git
$ cd rate-limit-kit
$ npm ci
$ npm test              # builds ESM + CJS, compiles the tests and runs node:test
$ npm run lint          # biome lint + tsc --noEmit
$ npm run format        # biome format --write
$ npm run format:check  # what CI runs
```

Run the examples against the build:

```console
$ node examples/algorithms.mjs
$ node examples/node-http.mjs
```

## Guidelines

- **Zero runtime dependencies**, and **no Node APIs in `src/`**: the
  library must run on edge runtimes. Middleware for a framework uses
  structural types (see `HonoLikeContext`), never an import of the
  framework. A test checks that the build imports no `node:` modules.
- **Algorithms are pure.** `step(state, now, cost)` must not read the clock
  or keep hidden state, and its state must survive `JSON.stringify`, so
  every store can run it (and run it again after a conflict).
- **Integer math.** Use whole milliseconds and scale by the window or
  interval rather than using fractions, so results are exact and tests can
  pin numbers.
- **Tests use a fake clock.** Use `limiterWith()` and `fakeClock()` from
  `test/helpers.ts`; never wait for real time.
- Every change comes with a test and a line in the `Unreleased` section of
  `CHANGELOG.md`.

## Project layout

```text
src/
  algorithms.ts        fixedWindow, slidingWindowLog, slidingWindowCounter, tokenBucket
  limiter.ts           RateLimiter, createRateLimiter
  memory-store.ts      MemoryStore
  redis-store.ts       RedisStore and the compare-and-set script
  headers.ts           rateLimitHeaders()
  middleware/node.ts   Express / Connect / node:http
  middleware/fetch.ts  Fetch-API handlers and Hono
  types.ts             Algorithm, Store, Decision, RateLimitResult
test/                  node:test suites and helpers
examples/              runnable examples (no network needed)
```

## Good first issues

These are deliberately small. Each one lists where to start.

1. **Fastify plugin**: add `src/middleware/fastify.ts` with an `onRequest`
   hook using structural types for `request` and `reply`
   (`reply.header()`, `reply.code().send()`). Test it with a fake request
   and reply, like the Hono tests in `test/fetch-middleware.test.ts`.
2. **Koa middleware**: `async (ctx, next)` with `ctx.ip`, `ctx.set()` and
   `ctx.status` / `ctx.body`. Same approach as the Fastify plugin.
3. **draft-8 partition key**: add an optional `partitionKey` to
   `HeaderOptions` in `src/headers.ts` that adds `;pk=:<base64>:` to the
   `RateLimit` field. Add a case to `test/headers.test.ts`.
4. **`MemoryStore` automatic pruning**: an optional `pruneIntervalMs` that
   calls `prune()` on a timer, with `unref()` when available and a
   `close()` method. Edit `src/memory-store.ts`.
5. **Upstash example**: add `examples/upstash.mjs` showing the adapter
   from the README, with `automaticDeserialization: false`, skipped when
   the environment variables are missing.
6. **`blockDurationMs` option**: after a key is limited, keep rejecting it
   for a fixed time. Implement it as a wrapper algorithm in
   `src/algorithms.ts` so it works with every store.
7. **README recipe**: limiting a GraphQL endpoint by query cost using the
   `cost` option.

## Pull requests

Keep them focused: one fix or feature per pull request. Describe what
changed and how you tested it; the template has a short checklist. CI runs
lint, format check and the tests on Node 20 and 22 on Linux, and Node 22 on
Windows and macOS.
