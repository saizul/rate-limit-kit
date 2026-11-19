# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
private vulnerability reporting ("Report a vulnerability" under the
repository's **Security** tab). You will get an answer within a week.

## Scope

rate-limit-kit is a security control, so bypasses matter. Reports in these
areas are especially welcome:

- **Limit bypass.** Any sequence of requests, costs or clock values that
  lets a key get more than its limit, or a race in `MemoryStore` or
  `RedisStore` that lets concurrent requests exceed it.
- **Memory exhaustion.** A way to make `MemoryStore` grow beyond `maxKeys`,
  or the sliding window log keep more entries than its limit.
- **Header or body injection.** A key, policy name or message that breaks
  the response headers or the JSON body.

## Your part

The default key for the Node middleware is `req.ip`; in Express that is
only the real client address if `trust proxy` is set correctly for your
deployment. For Fetch-API handlers, only key by a header your own proxy
sets or overwrites (see "Which header is the client IP?" in the README).
A wrong key choice lets clients pick their own bucket, which no library can
prevent.
