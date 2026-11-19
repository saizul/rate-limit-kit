import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import {
  fixedWindow,
  type NodeLikeRequest,
  type NodeMiddlewareOptions,
  RateLimiter,
  rateLimit,
  type Store,
} from '../src/index.js';
import { fakeClock } from './helpers.js';

type Req = IncomingMessage & NodeLikeRequest;
const servers: Server[] = [];

after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

/** A plain node:http server running the middleware in front of a handler, Connect style. */
async function serve(limiter: RateLimiter, options?: NodeMiddlewareOptions<Req>) {
  const mw = rateLimit<Req>(limiter, options);
  const server = createServer((req: Req, res: ServerResponse) => {
    void mw(req, res, (err?: unknown) => {
      if (err) {
        res.statusCode = 500;
        res.end(`error: ${(err as Error).message}`);
        return;
      }
      res.end(`ok ${req.rateLimit?.remaining ?? '-'}`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return (headers: Record<string, string> = {}) => fetch(url, { headers });
}

function limiter(limit = 2) {
  const time = fakeClock(0);
  return new RateLimiter({ algorithm: fixedWindow({ limit, windowMs: 60_000 }), clock: time.clock });
}

describe('rateLimit() for Node, Express and Connect', () => {
  it('passes requests under the limit and sets the headers', async () => {
    const get = await serve(limiter());
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok 1');
    assert.equal(res.headers.get('ratelimit-limit'), '2');
    assert.equal(res.headers.get('ratelimit-remaining'), '1');
    assert.equal(res.headers.get('ratelimit-reset'), '60');
    assert.equal(res.headers.get('ratelimit-policy'), '2;w=60');
  });

  it('answers 429 with Retry-After once the limit is reached', async () => {
    const get = await serve(limiter(1));
    await (await get()).text();
    const res = await get();
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await res.text(), 'Too many requests, please try again later.');
  });

  it('keys by client address by default and by a custom key when given', async () => {
    const get = await serve(limiter(1), { key: (req) => String(req.headers['x-api-key']) });
    assert.equal((await get({ 'x-api-key': 'a' })).status, 200);
    assert.equal((await get({ 'x-api-key': 'b' })).status, 200);
    assert.equal((await get({ 'x-api-key': 'a' })).status, 429);
  });

  it('sends a JSON message and a custom status', async () => {
    const get = await serve(limiter(1), {
      statusCode: 503,
      message: (_req, result) => ({ error: 'slow down', retryInMs: result.retryAfterMs }),
    });
    await (await get()).text();
    const res = await get();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { error: 'slow down', retryInMs: 60_000 });
  });

  it('skip() lets requests through uncounted, cost() charges more', async () => {
    const get = await serve(limiter(3), {
      skip: (req) => req.headers['x-health'] === '1',
      cost: (req) => (req.headers['x-heavy'] ? 2 : 1),
    });
    const health = await get({ 'x-health': '1' });
    assert.equal(health.headers.get('ratelimit-remaining'), null);
    assert.equal(await health.text(), 'ok -');
    assert.equal(await (await get({ 'x-heavy': '1' })).text(), 'ok 1');
    assert.equal((await get({ 'x-heavy': '1' })).status, 429);
  });

  it('headers: false and other standards', async () => {
    const quiet = await serve(limiter(), { headers: false });
    const res = await quiet();
    assert.equal(res.headers.get('ratelimit-limit'), null);
    const draft7 = await serve(limiter(), { headers: { standard: 'draft-7', legacy: true } });
    const res7 = await draft7();
    assert.equal(res7.headers.get('ratelimit'), 'limit=2, remaining=1, reset=60');
    assert.equal(res7.headers.get('x-ratelimit-remaining'), '1');
  });

  it('onLimited replaces the default response', async () => {
    const get = await serve(limiter(1), {
      onLimited: (_req, res) => {
        res.statusCode = 418;
        res.end('custom');
      },
    });
    await (await get()).text();
    const res = await get();
    assert.equal(res.status, 418);
    assert.equal(await res.text(), 'custom');
  });

  it('passes store errors to next(), or lets requests through with failOpen', async () => {
    const broken: Store = {
      update: () => {
        throw new Error('redis down');
      },
      delete: () => {},
    };
    const failing = new RateLimiter({ algorithm: fixedWindow({ limit: 1, windowMs: 1000 }), store: broken });
    const strict = await serve(failing);
    const res = await strict();
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'error: redis down');
    const lenient = await serve(failing, { failOpen: true });
    assert.equal(await (await lenient()).text(), 'ok -');
  });
});
