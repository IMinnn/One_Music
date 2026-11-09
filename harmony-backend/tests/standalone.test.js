import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('独立后端默认只提供 API，不依赖或返回客户端资源', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await fetch(f.url + '/api/health')).status, 200);
  for (const path of ['/', '/app.js', '/styles.css']) assert.equal((await fetch(f.url + path)).status, 404);
});
