// Run after `npm run build`: node examples/commonjs.cjs
const { createRateLimiter, fixedWindow, rateLimitHeaders } = require('../dist/cjs/index.js');

const limiter = createRateLimiter({ algorithm: fixedWindow({ limit: 2, windowMs: 60_000 }) });

(async () => {
  for (let i = 0; i < 3; i++) {
    const result = await limiter.consume('api-key-1');
    console.log(result.allowed, rateLimitHeaders(result));
  }
})();
