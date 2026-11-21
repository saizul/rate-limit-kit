# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `gcra({ limit, windowMs, burst? })`: the generic cell rate algorithm.
  `limit` requests per `windowMs` spread evenly with a configurable burst
  (default `limit`), exact integer math, and a two-number state. With the
  default burst it answers exactly like `tokenBucket()` at the same rate.

## [0.1.0] - 2026-11-19

### Added

- Algorithms `tokenBucket()`, `fixedWindow()`, `slidingWindowLog()` and
  `slidingWindowCounter()` with integer math, a cost per request, and no
  quota used by rejected requests.
- `RateLimiter` / `createRateLimiter()` with `consume()`, `peek()` and
  `reset()`, a key prefix and an injectable clock.
- `MemoryStore` with expiry and least-recently-used eviction.
- `RedisStore` for any client offering `get` and `eval`, using an atomic
  compare-and-set script; `StoreContentionError`.
- `rateLimit()` middleware for Express, Connect and `node:http`.
- `withRateLimit()` for Fetch-API handlers, `honoRateLimit()` for Hono,
  `checkRequest()`, `keyByHeader()` and `withHeaders()`.
- `rateLimitHeaders()` for IETF `RateLimit-*` headers (draft 6, 7 and 8),
  `Retry-After` and legacy `X-RateLimit-*` headers.
- ESM and CommonJS builds with type declarations; no runtime dependencies.

[Unreleased]: https://github.com/saizul/rate-limit-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saizul/rate-limit-kit/releases/tag/v0.1.0
