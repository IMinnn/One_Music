import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fixture } from './helpers.js';

const f = await fixture();
const client = f.client();
await client.register('searchtest');
await client.import('晚风本地.wav');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addCookies([{ name: 'harmony_session', value: client.cookie.split('=')[1], url: f.url }]);
const page = await context.newPage(), errors = [], requests = [];
page.on('pageerror', e => errors.push(e.message));
const networkTracks = [
  { id: 'cached-playlist', provider: 'qq', title: '晚风歌单旧歌曲', artist: '歌单艺人' },
  { id: 'qq-result', provider: 'qq', title: '晚风网络 QQ', artist: '网络艺人' },
  { id: 'netease-result', provider: 'netease', title: '晚风网络网易云', artist: '网络艺人' },
];
let connected = true;
await page.route('**/api/library', async route => {
  const response = await route.fetch(), library = await response.json();
  library.tracks.push(...networkTracks);
  library.providers = ['qq', 'netease'].map(id => ({ id, connected }));
  await route.fulfill({ json: library });
});
await page.route('**/api/providers/search', async route => {
  const input = route.request().postDataJSON(); requests.push(input);
  const trackIds = input.query === '无结果' ? [] : input.provider === 'all' ? ['qq-result', 'netease-result'] : [`${input.provider}-result`];
  await route.fulfill({ json: { trackIds, errors: input.query === '平台失败' ? [{ provider: 'qq', message: '平台暂时不可用' }] : [] } });
});
const click = (action, id) => page.locator(`[data-action="${action}"][data-id="${id}"]`).click();
const search = async term => {
  const response = page.waitForResponse(r => r.url().endsWith('/api/providers/search') && r.request().postDataJSON().query === term);
  await page.locator('#search').fill(term); await page.locator('#search').press('Enter');
  await response;
  await page.waitForFunction(() => !document.querySelector('#content').textContent.includes('正在搜索已连接的平台'));
};
try {
  await page.goto(f.url); await page.locator('#app').waitFor({ state: 'visible' });
  await click('navigate', 'search');
  assert.equal(await page.locator('tr[data-track]').count(), 0);
  assert.equal(await page.locator('#top-import').isVisible(), false);
  assert.equal(await page.locator('#content [data-action="import"]').count(), 0);
  assert.equal(await page.locator('[data-action="filter"][data-id="local"]').count(), 0);
  await page.locator('#empty-search').fill('晚风');
  assert.equal(await page.locator('#search').inputValue(), '晚风');
  await page.locator('#empty-search').dispatchEvent('compositionstart');
  await page.locator('#empty-search-form').dispatchEvent('submit');
  assert.equal(requests.length, 0);
  await page.locator('#empty-search').dispatchEvent('compositionend');
  await page.locator('#empty-search').press('Enter');
  await page.locator('tr[data-track="netease-result"]').waitFor();
  assert.equal(await page.locator('#empty-search').count(), 0);
  assert.deepEqual(await page.locator('tr[data-track]').evaluateAll(rows => rows.map(r => r.dataset.track)), ['qq-result', 'netease-result']);
  assert.deepEqual(requests.at(-1), { query: '晚风', provider: 'all' });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/search-network.png' });
  await click('filter', 'qq');
  await page.locator('tr[data-track="qq-result"]').waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 1);
  await click('filter', 'netease');
  await page.locator('tr[data-track="netease-result"]').waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 1);
  await search('无结果');
  assert.equal(await page.locator('tr[data-track]').count(), 0);
  await page.getByText('没有找到相关音乐', { exact: true }).waitFor();
  await search('平台失败');
  await page.getByText('QQ 音乐：平台暂时不可用', { exact: true }).waitFor();
  await page.locator('[data-action="clear-search"]').click();
  assert.equal(await page.locator('tr[data-track]').count(), 0);
  await page.locator('#empty-search').fill('晚风');
  await page.locator('#empty-search-form [type="submit"]').click();
  await page.locator('tr[data-track="netease-result"]').waitFor();
  await page.locator('[data-action="clear-search"]').click();
  await page.locator('#empty-search').waitFor();
  connected = false;
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#search').fill('晚风'); await page.locator('#search').press('Enter');
  await page.getByRole('heading', { name: '搜索「晚风」', exact: true }).waitFor();
  assert.equal(await page.locator('tr[data-track]').count(), 0);
  await click('navigate', 'tracks');
  assert.equal(await page.locator('tr[data-track]').count(), 1);
  assert.equal(await page.locator('#top-import').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: 网络结果独立于歌单/本地资料库；全部平台与单平台筛选、空搜索、无结果、平台错误、未连接状态和导入入口可见性');
} finally { await context.close(); await browser.close(); await f.close(); }
