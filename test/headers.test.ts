import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RateLimitResult, rateLimitHeaders } from '../src/index.js';

const ok: RateLimitResult = {
  allowed: true,
  remaining: 42,
  resetMs: 30_500,
  retryAfterMs: 0,
  key: 'k',
  limit: 100,
  windowMs: 60_000,
  resetAt: 1_700_000_030_500,
  algorithm: 'fixed-window',
};
const limited: RateLimitResult = { ...ok, allowed: false, remaining: 0, retryAfterMs: 1200 };

describe('rateLimitHeaders', () => {
  it('draft-6 by default', () => {
    assert.deepEqual(rateLimitHeaders(ok), {
      'RateLimit-Policy': '100;w=60',
      'RateLimit-Limit': '100',
      'RateLimit-Remaining': '42',
      'RateLimit-Reset': '31',
    });
  });

  it('draft-7 combines the fields', () => {
    assert.deepEqual(rateLimitHeaders(ok, { standard: 'draft-7' }), {
      'RateLimit-Policy': '100;w=60',
      RateLimit: 'limit=100, remaining=42, reset=31',
    });
  });

  it('draft-8 uses structured fields with a policy name', () => {
    assert.deepEqual(rateLimitHeaders(ok, { standard: 'draft-8' }), {
      'RateLimit-Policy': '"default";q=100;w=60',
      RateLimit: '"default";r=42;t=31',
    });
    assert.equal(
      rateLimitHeaders(ok, { standard: 'draft-8', policyName: 'api' }).RateLimit,
      '"api";r=42;t=31',
    );
  });

  it('adds Retry-After to rejected requests, rounded up to whole seconds', () => {
    assert.equal(rateLimitHeaders(limited)['Retry-After'], '2');
    assert.equal(rateLimitHeaders({ ...limited, retryAfterMs: 1 })['Retry-After'], '1');
    assert.equal(rateLimitHeaders(limited, { retryAfter: false })['Retry-After'], undefined);
    assert.equal(rateLimitHeaders(ok)['Retry-After'], undefined);
  });

  it('legacy X-RateLimit headers use epoch seconds', () => {
    assert.deepEqual(rateLimitHeaders(ok, { standard: false, legacy: true }), {
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': '1700000031',
    });
  });

  it('standard: false with nothing else sends only Retry-After', () => {
    assert.deepEqual(rateLimitHeaders(limited, { standard: false }), { 'Retry-After': '2' });
  });
});
