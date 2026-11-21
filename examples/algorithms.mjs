// Run after `npm run build`: node examples/algorithms.mjs
// Sends the same burst of 8 requests through each algorithm, with a fake clock.
import {
  createRateLimiter,
  fixedWindow,
  gcra,
  slidingWindowCounter,
  slidingWindowLog,
  tokenBucket,
} from '../dist/esm/index.js';

const algorithms = [
  fixedWindow({ limit: 5, windowMs: 1000 }),
  slidingWindowLog({ limit: 5, windowMs: 1000 }),
  slidingWindowCounter({ limit: 5, windowMs: 1000 }),
  tokenBucket({ capacity: 5, refillRate: 5 }),
  gcra({ limit: 5, windowMs: 1000 }),
];

for (const algorithm of algorithms) {
  let now = 900; // 100 ms before a window boundary, where fixed windows are weakest
  const limiter = createRateLimiter({ algorithm, clock: () => now });
  const line = [];
  for (let i = 0; i < 8; i++) {
    const r = await limiter.consume('client');
    line.push(r.allowed ? 'ok' : `wait ${r.retryAfterMs}ms`);
    now += 50;
  }
  console.log(`${algorithm.name.padEnd(24)} ${line.join(', ')}`);
}
