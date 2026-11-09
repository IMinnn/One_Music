import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fixture, wav } from './helpers.js';

const testImage = await QRCode.toDataURL('playlist-transfer-test');
const calls = [], bindings = { qq: 0, netease: 0 };
const providers = Object.fromEntries(['qq', 'netease'].map(source => [source, {
  async startQr() { return { image: testImage, secret: {} }; },
  async pollQr() { const id = `${source}-account-${++bindings[source]}`; return { status: 'authorized', credential: { account: id }, profile: { id, nickname: id } }; },
  async playlists() { return []; },
  async playback(credential, id) { calls.push({ source, account: credential.account, id }); return `https://${source === 'qq' ? 'isure.stream.qqmusic.qq.com' : 'm701.music.126.net'}/transfer-test.wav`; },
  async lyrics() { return { lyric: '[00:00]导入播放测试' }; },
}]));
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).includes('/transfer-test.wav') ? Promise.resolve(new Response(wav(6), { headers: { 'Content-Type': 'audio/wav' } })) : originalFetch(url, options);
const f = await fixture({ providers });
const a = f.client(), b = f.client();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const bind = async (c, source) => {
  const qr = (await c.request(`/providers/${source}/qr`, 'POST', {})).data;
  assert.equal((await c.request(`/providers/${source}/qr/${qr.id}`, 'POST', {})).data.status, 'authorized');
};
const open = async c => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'harmony_session', value: c.cookie.split('=')[1], url: f.url }]);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(f.url); await page.locator('#library-tab-own').waitFor();
  return page;
};
try {
  await mkdir('test-results', { recursive: true });
  await a.register('transferfrom'); await b.register('transferto');
  for (const source of ['qq', 'netease']) await bind(a, source);
  const local = (await a.import('本地导入播放.wav', wav(6))).data.track;
  const userId = f.app.db.prepare('SELECT id FROM users WHERE username=?').get('transferfrom').id;
  for (const source of ['qq', 'netease']) f.app.db.prepare('INSERT INTO tracks(id,user_id,provider,provider_id,title,artist,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(`${source}-original`, userId, source, `${source}-song`, `${source} 导入测试`, '测试艺人', Date.now());
  const playlist = (await a.request('/playlists', 'POST', { name: '导入播放验证' })).data.playlist;
  await a.request(`/playlists/${playlist.id}/tracks`, 'PUT', { version: playlist.version, trackIds: ['qq-original', 'netease-original', local.id] });
  await a.request('/tracks/qq-original/favorite', 'PUT', { favorite: true });
  const sourcePage = await open(a);
  await sourcePage.locator('[data-action=navigate][data-id=library]').click();
  await sourcePage.exposeFunction('saveHyTest', content => writeFile('test-results/playlist-export.hy', content, 'utf8'));
  await sourcePage.evaluate(() => {
    window.showSaveFilePicker = async options => {
      window.savePickerOptions = options;
      return { createWritable: async () => ({ write: content => window.saveHyTest(content), close: async () => {}, abort: async () => {} }) };
    };
  });
  await sourcePage.locator('[data-action=export-playlists]').click();
  await sourcePage.waitForFunction(() => document.querySelector('#toast').textContent.includes('已导出'));
  assert.match(await sourcePage.evaluate(() => window.savePickerOptions.suggestedName), /\.hy$/);
  assert.deepEqual(await sourcePage.evaluate(() => window.savePickerOptions.types[0].accept), { 'application/json': ['.hy'] });
  assert.equal(await sourcePage.locator('#playlist-file-input').getAttribute('accept'), '.hy');
  const data = JSON.parse(await readFile('test-results/playlist-export.hy', 'utf8'));
  assert.equal(data.playlists.length, 1); assert.equal(data.favorites.length, 1);
  assert.equal(data.playlists[0].tracks.length, 3);
  await sourcePage.evaluate(() => {
    window.originalSavePicker = window.showSaveFilePicker;
    document.querySelector('#toast').textContent = '';
    window.showSaveFilePicker = async () => { throw new DOMException('取消保存', 'AbortError'); };
  });
  await sourcePage.locator('[data-action=export-playlists]').click();
  assert.equal(await sourcePage.locator('#toast').textContent(), '');
  await sourcePage.evaluate(() => { window.showSaveFilePicker = async () => ({ createWritable: async () => { throw new Error('磁盘不可写'); } }); });
  await sourcePage.locator('[data-action=export-playlists]').click();
  await sourcePage.waitForFunction(() => document.querySelector('#toast').textContent.includes('导出未完成：磁盘不可写'));
  await sourcePage.evaluate(() => { window.showSaveFilePicker = window.originalSavePicker; });
  await sourcePage.locator('#playlist-file-input').setInputFiles('test-results/playlist-export.hy');
  await sourcePage.getByRole('heading', { name: '歌单导入完成' }).waitFor();
  await sourcePage.locator('[data-action=close-dialog]').first().click();
  await sourcePage.locator(`[data-action=open-list][data-id="${playlist.id}"]`).first().click();
  await sourcePage.locator(`[data-action=play][data-id="${local.id}"]`).click();
  await sourcePage.waitForFunction(() => document.querySelector('audio').currentTime > .2);
  assert.equal((await a.request(`/tracks/${local.id}/audio`)).status, 200);
  console.log('PASS: 选择位置保存 .hy 文件（JSON 内容），原身份重新导入去重后，本地音频仍可解码播放');

  await b.request('/playlists', 'POST', { name: '导入播放验证', description: '保留介绍' });
  const page = await open(b);
  await page.locator('[data-action=navigate][data-id=library]').click();
  await page.screenshot({ path: 'test-results/playlist-transfer-page.png' });
  await page.locator('#playlist-file-input').setInputFiles('test-results/playlist-export.hy');
  await page.getByRole('heading', { name: '歌单导入完成' }).waitFor();
  assert.match(await page.locator('#dialog-content').textContent(), /QQ 音乐、网易云音乐尚未连接/);
  assert.match(await page.locator('#dialog-content').textContent(), /本地歌曲缺少原音频/);
  await page.screenshot({ path: 'test-results/playlist-import-result.png' });
  await page.locator('#dialog [data-action=close-dialog]').first().click();
  let library = (await b.request('/library')).data;
  const own = library.playlists.find(p => p.source === 'own');
  assert.equal(own.description, '保留介绍'); assert.equal(own.trackIds.length, 3);
  await page.locator(`[data-action=open-list][data-id="${own.id}"]`).first().click();
  for (const source of ['qq', 'netease']) {
    const t = library.tracks.find(t => t.provider === source);
    const unavailable = await b.request(`/tracks/${t.id}/audio`);
    assert.equal(unavailable.status, 409); assert.match(unavailable.data.error, new RegExp(source === 'qq' ? 'QQ 音乐' : '网易云音乐'));
    await page.locator(`[data-action=play][data-id="${t.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('本轮歌曲均无法播放'));
    assert.equal(await page.locator('audio').evaluate(a => a.paused), true);
    await page.locator('.playback-connection-notice [data-action="import-connection-settings"]').first().click();
    await page.locator(`[data-action="connect-provider"][data-id="${source}"]`).click();
    await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth > 50, null, { timeout: 5000 });
    await page.locator('#dialog [data-action=close-dialog]').first().click();
    await page.locator(`[data-action=open-list][data-id="${own.id}"]`).first().click();
  }
  console.log('PASS: 跨和音账号导入无需绑定；未绑定 QQ / 网易云时给出准确提示与连接入口');
  for (const source of ['qq', 'netease']) await bind(b, source);
  await page.reload(); await page.locator('#library-tab-own').waitFor();
  await page.locator(`[data-action=open-list][data-id="${own.id}"]`).first().click();
  library = (await b.request('/library')).data;
  for (const source of ['qq', 'netease']) {
    const t = library.tracks.find(t => t.provider === source);
    assert.equal(t.canPlay, true);
    const audio = await b.request(`/tracks/${t.id}/audio`);
    assert.equal(audio.status, 200); assert.equal(audio.data.subarray(0, 4).toString(), 'RIFF');
    await page.locator(`[data-action=play][data-id="${t.id}"]`).click();
    await page.waitForFunction(id => document.querySelector('audio').src.includes(id) && document.querySelector('audio').currentTime > .2, t.id);
    assert.ok(calls.some(c => c.source === source && c.account === `${source}-account-2` && c.id === `${source}-song`));
  }
  console.log('PASS: QQ / 网易云更换为不同平台账号后，通过后端音频代理，浏览器均实际开始播放（平台适配器与上游音频为受控测试替身）');
  await page.locator('[data-action=navigate][data-id=library]').click();
  await page.locator('#playlist-file-input').setInputFiles('test-results/playlist-export.hy');
  await page.getByRole('heading', { name: '歌单导入完成' }).waitFor();
  assert.match(await page.locator('#dialog-content').textContent(), /新增 0 条收藏/);
  await page.locator('#dialog [data-action=close-dialog]').first().click();
  await page.locator('#playlist-file-input').setInputFiles({ name: 'bad.hy', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('文件无法读取'));
  await page.setViewportSize({ width: 800, height: 850 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/playlist-transfer-narrow.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: 同文件重复导入、非法文件提示、窄窗口布局及页面无脚本异常');
} finally {
  await browser.close(); await f.close(); globalThis.fetch = originalFetch;
}

