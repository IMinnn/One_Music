import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fixture, wav } from './helpers.js';

const provider = name => ({
  startQr: async () => ({ secret: {}, image: '', hint: '' }),
  pollQr: async () => ({ status: 'authorized', credential: {}, profile: { id: name, nickname: name } }),
  profile: async () => ({ id: name, nickname: name }),
  playlists: async () => [{ id: 'one', name: name + ' 歌单', trackCount: 1 }],
  firstTrack: async () => ({ id: 'song', coverUrl: 'https://y.gtimg.cn/music/test.jpg' }),
  playlistTracks: async () => [{ id: 'song', title: '测试歌词', artist: '艺人', coverUrl: 'https://y.gtimg.cn/music/test.jpg' }],
  lyrics: async () => ({ lyric: '[00:00.00]第一句\n[00:02.00]第二句\n[00:04.00]第三句', translation: '[00:02.00]Second line' }),
});
const f = await fixture({ providers: { qq: provider('QQ'), netease: provider('网易云') } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1360, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.route('https://y.gtimg.cn/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#448866"/></svg>' }));
  // Redirected requests cannot be mocked reliably at the destination URL.
  await page.route('**/api/platform-playlists/*/cover', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#448866"/></svg>' }));
  await page.goto(f.url);
  await page.locator('#register-tab').click(); await page.locator('#username').fill('enhancements');
  await page.locator('#password').fill('Testing-passphrase-1'); await page.locator('#confirm-password').fill('Testing-passphrase-1');
  await page.locator('#auth-submit').click(); await page.locator('#app').waitFor({ state: 'visible' });
  const post = async (path, data = {}) => (await page.request.post(f.url + '/api' + path, { data, headers: { Origin: f.url } })).json();
  const one = (await post('/playlists', { name: '第一张自建' })).playlist.id;
  const two = (await post('/playlists', { name: '第二张自建' })).playlist.id;
  for (const source of ['qq', 'netease']) {
    const qr = await post(`/providers/${source}/qr`); await post(`/providers/${source}/qr/${qr.id}`); await post(`/providers/${source}/sync`);
  }
  await page.reload(); await page.locator(`[data-drag-list="${two}"]`).waitFor();
  let saved = page.waitForResponse(r => r.url().endsWith('/api/playlist-layout') && r.request().method() === 'PUT');
  await page.locator(`[data-drag-list="${two}"]`).dragTo(page.locator(`[data-drag-list="${one}"]`));
  assert.equal((await saved).status(), 200);
  await page.waitForFunction(id => document.querySelector('[data-group="own"] [data-drag-list]').dataset.dragList === id, two);
  saved = page.waitForResponse(r => r.url().endsWith('/api/playlist-layout') && r.request().method() === 'PUT');
  await page.locator('[data-drag-group="netease"]').dragTo(page.locator('[data-drag-group="own"]'));
  assert.equal((await saved).status(), 200);
  await page.reload(); await page.locator('[data-drag-group="netease"]').waitFor();
  assert.equal(await page.locator('.playlist-group').first().getAttribute('data-group'), 'netease');
  assert.equal(await page.locator('[data-group="own"] [data-drag-list]').first().getAttribute('data-drag-list'), two);
  console.log('PASS: 分组、组内拖动真实保存到后端，刷新恢复');
  saved = page.waitForResponse(r => r.url().endsWith('/api/playlist-layout') && r.request().method() === 'PUT');
  await page.locator('[data-action="toggle-playlist-group"][data-id="qq"]').click();
  assert.equal((await saved).status(), 200);
  await page.reload(); await page.locator('#playlist-search').waitFor();
  assert.equal(await page.locator('[data-drag-group="qq"]').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-group="qq"] [data-drag-list]').isVisible(), false);
  await page.locator('#playlist-search').pressSequentially('qQ');
  assert.equal(await page.locator('#playlist-search').inputValue(), 'qQ');
  assert.equal(await page.locator('[data-drag-group="qq"]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#navigation [data-drag-list]:visible').count(), 1);
  assert.equal(await page.locator('#search').inputValue(), '');
  await page.locator('#playlist-search').fill('不存在的歌单');
  assert.equal(await page.locator('#navigation [data-drag-list]:visible').count(), 0);
  await page.locator('[data-action="clear-playlist-search"]').click();
  assert.equal(await page.locator('[data-drag-group="qq"]').getAttribute('aria-expanded'), 'false');
  saved = page.waitForResponse(r => r.url().endsWith('/api/playlist-layout') && r.request().method() === 'PUT');
  await page.locator('[data-action="toggle-all-playlist-groups"]').click(); await saved;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-drag-group]')].every(g => g.getAttribute('aria-expanded') === 'false'));
  saved = page.waitForResponse(r => r.url().endsWith('/api/playlist-layout') && r.request().method() === 'PUT');
  await page.locator('[data-action="toggle-all-playlist-groups"]').click(); await saved;
  await page.waitForFunction(() => [...document.querySelectorAll('[data-drag-group]')].every(g => g.getAttribute('aria-expanded') === 'true'));
  console.log('PASS: 分组收起后刷新恢复、名称搜索自动展开与清空恢复、无结果、全部展开收起');
  await page.locator('#account-button').click();
  await page.getByRole('heading', { name: '账号与音乐平台', exact: true }).waitFor();
  assert.equal(await page.locator('.connection-card').count(), 2);
  assert.equal(await page.locator('.connection-state.connected').count(), 2);
  assert.equal(await page.locator('#content .playlist-card,#platform-playlist-panel').count(), 0);
  assert.equal(await page.locator('.connection-count').textContent(), '2 / 2 已连接');
  assert.equal(await page.locator('#account-button').getAttribute('aria-current'), 'page');
  await page.screenshot({ path: 'test-results/account-platforms-connected.png', style: '#toast{visibility:hidden}' });
  await page.locator('[data-action="theme"][data-id="dark"]').click();
  await page.screenshot({ path: 'test-results/account-platforms-dark.png', style: '#toast{visibility:hidden}' });
  await page.locator('[data-action="theme"][data-id="light"]').click();
  await page.setViewportSize({ width: 760, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/account-platforms-small.png', style: '#toast{visibility:hidden}' });
  await page.setViewportSize({ width: 1360, height: 900 });
  console.log('PASS: 账号与平台合并、两个连接状态、无歌单列表、深浅色及窄窗布局');
  await page.locator('[data-action="navigate"][data-id="library"]').click();
  assert.equal(await page.locator('.library-tabs [role="tab"]').count(), 3);
  assert.equal(await page.locator('#library-playlist-panel .playlist-card').count(), 2);
  await page.locator('#library-tab-qq').click();
  assert.equal(await page.locator('#library-playlist-panel .playlist-card').count(), 1);
  await page.waitForFunction(() => document.querySelector('#library-playlist-panel .playlist-art')?.naturalWidth > 0);
  await page.locator('#library-tab-qq').press('ArrowRight');
  assert.equal(await page.locator('#library-tab-netease').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#library-playlist-panel .playlist-card h3').textContent(), '网易云 歌单');
  await page.screenshot({ path: 'test-results/library-tabs-covers.png' });
  assert.equal(await page.locator('#shuffle,#repeat').count(), 0);
  await page.locator('#playback-mode').hover();
  await page.locator('#playback-mode-tip').waitFor({ state: 'visible' });
  for (const name of ['随机播放', '单曲循环', '列表循环']) {
    await page.locator('#playback-mode').click();
    assert.ok((await page.locator('#playback-mode').getAttribute('aria-label')).startsWith(name));
  }
  console.log('PASS: 全部歌单三类页签、首曲封面预览、合并播放模式三态切换与悬浮提示');
  assert.equal(await page.locator('#platform-navigation').count(), 0);
  await page.locator('[data-group="qq"] [data-action="open-list"]').click(); await page.locator('tr[data-track]').waitFor();
  await page.waitForFunction(() => document.querySelector('.mini-cover img')?.naturalWidth > 0);
  await page.unroute('https://y.gtimg.cn/**');
  await page.route('https://y.gtimg.cn/**', route => route.abort());
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('[data-action="navigate"][data-id="tracks"]').click();
  await page.waitForFunction(() => !document.querySelector('.mini-cover img'));
  await page.route('**/api/tracks/*/audio', route => route.fulfill({ contentType: 'audio/wav', body: wav(12) }));
  await page.locator('tr[data-track] td.source').first().click();
  await page.waitForFunction(() => document.querySelector('audio').currentTime > .05);
  const neteaseList = await page.locator('[data-group="netease"] [data-drag-list]').getAttribute('data-drag-list');
  await post(`/platform-playlists/${neteaseList}/refresh`);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('[data-action="navigate"][data-id="tracks"]').click();
  assert.equal(await page.locator('tr[data-track]').count(), 2);
  await page.locator('tr[data-track] .song-name').first().click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  const originalSource = await page.locator('audio').getAttribute('src');
  await page.locator('#playback-mode').click();
  await page.locator('audio').evaluate(a => a.dispatchEvent(new Event('ended')));
  await page.waitForFunction(src => document.querySelector('audio').getAttribute('src') !== src, originalSource);
  const randomSource = await page.locator('audio').getAttribute('src');
  await page.locator('#playback-mode').click();
  await page.locator('audio').evaluate(a => { a.currentTime = 3; a.dispatchEvent(new Event('ended')); });
  await page.waitForFunction(() => document.querySelector('audio').currentTime < 1);
  assert.equal(await page.locator('audio').getAttribute('src'), randomSource);
  await page.locator('#playback-mode').click();
  await page.locator('audio').evaluate(a => a.dispatchEvent(new Event('ended')));
  await page.waitForFunction(src => document.querySelector('audio').getAttribute('src') === src, originalSource);
  console.log('PASS: 播放结束时随机切换到其他歌曲、单曲重播、列表循环切换');
  await page.locator('#now-playing').click();
  await page.locator('.lyric-line').first().waitFor();
  await page.locator('.lyric-line').nth(2).click();
  await page.waitForFunction(() => document.querySelector('.lyric-line.active')?.textContent.includes('第三句'));
  assert.ok(await page.locator('.lyric-line').nth(1).textContent().then(t => t.includes('Second line')));
  await page.screenshot({ path: 'test-results/lyrics.png' });
  await page.locator('[data-action="navigate"][data-id="home"]').click();
  await page.locator('#home-lyric-line').waitFor();
  await page.screenshot({ path: 'test-results/home-optimized.png' });
  assert.equal(await page.locator('#connection-settings').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: 统一账号入口、封面回退、整行播放、歌词同步与点击跳转、翻译、首页歌词');
} catch (error) {
  await page.screenshot({ path: 'test-results/enhancements-failure.png' });
  throw error;
} finally { await browser.close(); await f.close(); }
