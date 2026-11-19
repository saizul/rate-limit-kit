import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkRequest,
  fixedWindow,
  honoRateLimit,
  keyByHeader,
  RateLimiter,
  type Store,
  tokenBucket,
  withHeaders,
  withRateLimit,
} from '../src/index.js';
import { fakeClock } from './helpers.js';

const req = (headers: Record<string, string> = {}) => new Request('https://app.test/api', { headers });

function limiter(limit = 2) {
  const time = fakeClock(0);
  return {
    time,
    limiter: new RateLimiter({ algorithm: fixedWindow({ limit, windowMs: 10_000 }), clock: time.clock }),
  };
}

describe('withRateLimit() for Fetch-API handlers', () => {
  it('calls the handler and adds headers until the limit, then answers 429', async () => {
    const { limiter: l } = limiter(1);
    let calls = 0;
    const handler = withRateLimit(l, { key: keyByHeader('x-forwarded-for') }, async () => {
      calls++;
      return Response.json({ ok: true });
    });
    const first = await handler(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(first.headers.get('ratelimit-remaining'), '0');
    const second = await handler(req({ 'x-forwarded-for': '203.0.113.7' }));
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '10');
    assert.equal(second.headers.get('ratelimit-limit'), '1');
    assert.equal(await second.text(), 'Too many requests, please try again later.');
    assert.equal(calls, 1);
    const other = await handler(req({ 'x-forwarded-for': '198.51.100.1' }));
    assert.equal(other.status, 200);
  });

  it('passes extra handler arguments through (Next.js context, Workers env)', async () => {
    const { limiter: l } = limiter();
    const handler = withRateLimit(
      l,
      { key: () => 'x' },
      async (_req, ctx: { params: { id: string } }) => new Response(ctx.params.id),
    );
    assert.equal(await (await handler(req(), { params: { id: '42' } })).text(), '42');
  });

  it('adds headers to responses whose headers are immutable', async () => {
    const { limiter: l } = limiter();
    const handler = withRateLimit(l, { key: () => 'x' }, async () =>
      Response.redirect('https://app.test/next', 302),
    );
    const res = await handler(req());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://app.test/next');
    assert.equal(res.headers.get('ratelimit-remaining'), '1');
  });

  it('onLimited builds a custom response that still gets the headers', async () => {
    const { limiter: l } = limiter(1);
    const handler = withRateLimit(
      l,
      { key: () => 'x', onLimited: (_req, r) => Response.json({ wait: r.retryAfterMs }, { status: 429 }) },
      async () => new Response('ok'),
    );
    await handler(req());
    const res = await handler(req());
    assert.deepEqual(await res.json(), { wait: 10_000 });
    assert.equal(res.headers.get('retry-after'), '10');
  });

  it('failOpen lets requests through when the store fails, otherwise the error is thrown', async () => {
    const broken: Store = {
      update: async () => {
        throw new Error('down');
      },
      delete: () => {},
    };
    const l = new RateLimiter({ algorithm: fixedWindow({ limit: 1, windowMs: 1000 }), store: broken });
    const open = withRateLimit(l, { key: () => 'x', failOpen: true }, async () => new Response('ok'));
    assert.equal(await (await open(req())).text(), 'ok');
    const closed = withRateLimit(l, { key: () => 'x' }, async () => new Response('ok'));
    await assert.rejects(closed(req()), /down/);
  });

  it('checkRequest() exposes the parts for other frameworks', async () => {
    const time = fakeClock(0);
    const l = new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillRate: 1 }), clock: time.clock });
    const a = await checkRequest(l, req(), { key: () => 'x', headers: { standard: 'draft-8' } });
    assert.equal(a.response, undefined);
    assert.equal(a.result?.remaining, 0);
    assert.equal(a.headers.RateLimit, '"default";r=0;t=1');
    const b = await checkRequest(l, req(), { key: () => 'x', message: { error: 'rate_limited' } });
    assert.equal(b.response?.status, 429);
    assert.deepEqual(await b.response?.json(), { error: 'rate_limited' });
    const skipped = await checkRequest(l, req(), { key: () => 'x', skip: () => true });
    assert.deepEqual(skipped, { headers: {} });
  });

  it('keyByHeader falls back when the header is missing', () => {
    assert.equal(keyByHeader('cf-connecting-ip')(req()), 'unknown');
    assert.equal(keyByHeader('cf-connecting-ip', 'anon')(req({ 'cf-connecting-ip': ' ' })), 'anon');
    assert.equal(keyByHeader('cf-connecting-ip')(req({ 'cf-connecting-ip': '192.0.2.1' })), '192.0.2.1');
  });

  it('withHeaders leaves a response alone when there is nothing to add', () => {
    const res = new Response('x');
    assert.equal(withHeaders(res, {}), res);
  });
});

describe('honoRateLimit()', () => {
  function context(headers: Record<string, string> = {}) {
    const set: Record<string, string> = {};
    return {
      set,
      c: {
        req: { raw: req(headers), header: (name: string) => headers[name] },
        header: (name: string, value: string) => {
          set[name] = value;
        },
      },
    };
  }

  type Ctx = ReturnType<typeof context>['c'];

  it('sets headers through c.header and calls next', async () => {
    const { limiter: l } = limiter();
    const mw = honoRateLimit<Ctx>(l, { key: (c) => c.req.header('x-user') ?? 'anon' });
    const { c, set } = context({ 'x-user': 'u1' });
    let nextCalled = false;
    const out = await mw(c, async () => {
      nextCalled = true;
    });
    assert.equal(out, undefined);
    assert.equal(nextCalled, true);
    assert.equal(set['RateLimit-Remaining'], '1');
  });

  it('returns a 429 Response without calling next when limited', async () => {
    const { limiter: l } = limiter(1);
    const mw = honoRateLimit(l, { key: () => 'same', skip: (c) => c.req.raw.headers.has('x-internal') });
    await mw(context().c, async () => {});
    let nextCalled = false;
    const out = await mw(context().c, async () => {
      nextCalled = true;
    });
    assert.equal(out?.status, 429);
    assert.equal(nextCalled, false);
    const internal = await mw(context({ 'x-internal': '1' }).c, async () => {});
    assert.equal(internal, undefined);
  });
});
