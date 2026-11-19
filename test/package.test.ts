import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as esm from '../src/index.js';

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('package', () => {
  it('the CommonJS build exposes the same API', async () => {
    const cjs = require('../cjs/index.js') as typeof esm;
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
    const limiter = new cjs.RateLimiter({ algorithm: cjs.fixedWindow({ limit: 1, windowMs: 1000 }) });
    assert.equal((await limiter.consume('k')).allowed, true);
  });

  it('the CommonJS folder is marked as commonjs', () => {
    assert.equal(JSON.parse(read('../cjs/package.json')).type, 'commonjs');
  });

  it('has no runtime dependencies and versions agree', () => {
    const pkg = JSON.parse(read('../../package.json'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.version, esm.VERSION);
    assert.equal(pkg.name, '@saizul/rate-limit-kit');
  });

  it('the library does not import Node built-ins, so it runs on edge runtimes', () => {
    const files = [
      'index',
      'algorithms',
      'headers',
      'limiter',
      'memory-store',
      'redis-store',
      'types',
      'middleware/node',
      'middleware/fetch',
      'middleware/shared',
    ];
    for (const file of files) assert.doesNotMatch(read(`../esm/${file}.js`), /from ['"]node:/, file);
  });

  it('the README shows the compare-and-set script the RedisStore uses', () => {
    const readme = read('../../README.md');
    assert.ok(readme.includes(esm.COMPARE_AND_SET_SCRIPT), 'README script is out of date');
  });
});
