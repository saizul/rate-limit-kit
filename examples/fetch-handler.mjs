// Run after `npm run build`: node examples/fetch-handler.mjs
// A Fetch-API handler, as used by Next.js route handlers, Bun.serve, Deno.serve and Workers.
import { createRateLimiter, keyByHeader, tokenBucket, withRateLimit } from '../dist/esm/index.js';

const limiter = createRateLimiter({ algorithm: tokenBucket({ capacity: 2, refillRate: 1 }) });

// In Next.js: export const POST = withRateLimit(...)
const POST = withRateLimit(limiter, { key: keyByHeader('x-forwarded-for') }, async (req) => {
  const body = await req.json();
  return Response.json({ received: body });
});

for (let i = 1; i <= 3; i++) {
  const req = new Request('https://example.test/api/echo', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5', 'content-type': 'application/json' },
    body: JSON.stringify({ n: i }),
  });
  const res = await POST(req);
  console.log(i, res.status, `remaining=${res.headers.get('ratelimit-remaining')}`, await res.text());
}
