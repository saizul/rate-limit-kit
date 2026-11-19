// Run after `npm run build`: node examples/node-http.mjs
// The same middleware works in Express: app.use(rateLimit(limiter)).
import { createServer } from 'node:http';
import { createRateLimiter, rateLimit, slidingWindowCounter } from '../dist/esm/index.js';

const limiter = createRateLimiter({ algorithm: slidingWindowCounter({ limit: 3, windowMs: 60_000 }) });
const limit = rateLimit(limiter, { headers: { standard: 'draft-7' } });

const server = createServer((req, res) => {
  limit(req, res, (err) => {
    if (err) {
      res.statusCode = 500;
      res.end('internal error');
      return;
    }
    res.end(`hello, ${req.rateLimit.remaining} requests left\n`);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

for (let i = 1; i <= 4; i++) {
  const res = await fetch(url);
  console.log(
    i,
    res.status,
    res.headers.get('ratelimit'),
    res.headers.get('retry-after') ?? '',
    (await res.text()).trim(),
  );
}
server.close();
