import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

let failed = true;
const adapters = Object.fromEntries(['qq', 'netease'].map(source => [source, {
  async startQr() { return { image: 'data:image/png;base64,TEST', secret: {} }; },
  async pollQr() { return { status: 'authorized', credential: { test: true }, profile: { id: source, nickname: source } }; },
  async profile() { return { id: source, nickname: source }; },
  async playlists() { return [{ id: 'one', name: '未打开的歌单', trackCount: 2 }, { id: 'two', name: '另一歌单', trackCount: 2 }]; },
  async firstTrack() { return null; },
  async playlistTracks(credential, id) {
    if (source === 'qq' && id === 'two' && failed) throw new Error('歌单暂时不可用');
    return [{ id: 'shared', title: source + '共用歌曲' }, { id, title: source + id }];
  },
  async search() { return [{ id: 'search-only', title: '只搜索的音乐' }]; },
}]));
const f = await fixture({ providers: adapters });
const c = f.client(); await c.register('collectiontest');
for (const source of ['qq', 'netease']) {
  const qr = (await c.request(`/providers/${source}/qr`, 'POST', {})).data;
  await c.request(`/providers/${source}/qr/${qr.id}`, 'POST', {});
  await c.request(`/providers/${source}/sync`, 'POST', {});
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addCookies([{ name: 'harmony_session', value: c.cookie.split('=')[1], url: f.url }]);
const page = await context.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
const click = (action, id) => page.locator(`[data-action="${action}"]${id ? `[data-id="${id}"]` : ''}`).first().click();
try {
  await page.goto(f.url); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#search').fill('只搜索'); await page.locator('#search').press('Enter');
  await page.locator('tr[data-track]').first().waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 2);
  const searchedId = await page.locator('tr[data-track]').first().getAttribute('data-track');
  assert.equal(await page.locator('[data-action="navigate"][data-id="tracks"] .count').textContent(), '0');
  await click('navigate', 'tracks');
  await page.locator('[data-action="retry-collection"]').waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 5);
  assert.equal(await page.locator(`tr[data-track="${searchedId}"]`).count(), 0);
  failed = false; await click('retry-collection');
  await page.waitForFunction(() => document.querySelectorAll('tr[data-track]').length === 6);
  assert.equal(await page.locator('[data-action="retry-collection"]').count(), 0);
  assert.equal(await page.locator('[data-action="navigate"][data-id="tracks"] .count').textContent(), '6');
  await click('navigate', 'search');
  await page.locator(`tr[data-track="${searchedId}"]`).waitFor();
  await click('favorite', searchedId);
  await page.waitForFunction(id => document.querySelector(`[data-action="favorite"][data-id="${id}"]`)?.getAttribute('aria-pressed') === 'true', searchedId);
  await click('navigate', 'tracks');
  await page.locator(`tr[data-track="${searchedId}"]`).waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 7);
  await click('favorite', searchedId);
  await page.waitForFunction(() => document.querySelectorAll('tr[data-track]').length === 6);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await click('navigate', 'tracks');
  assert.equal(await page.locator('tr[data-track]').count(), 6);
  assert.deepEqual(errors, []);
  console.log('PASS: 搜索不增加汇总数量，自动加载未打开歌单并去重，失败可重试，收藏加入/取消及刷新后的汇总一致');
} finally { await context.close(); await browser.close(); await f.close(); }
