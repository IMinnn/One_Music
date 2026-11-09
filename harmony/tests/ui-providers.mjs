import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { mkdir } from 'node:fs/promises';
import { fixture, wav } from './helpers.js';

const live = process.env.HARMONY_LIVE_PROVIDERS === '1';
let status = 'waiting', qrCount = 0, polls = 0;
const testImage = await QRCode.toDataURL('harmony-automated-test-not-a-login');
const fake = {
  async startQr() { qrCount++; return { image: testImage, hint: '自动化测试二维码', secret: {} }; },
  async pollQr() { polls++; return status === 'authorized' ? { status, credential: { test: true }, profile: { id: 'test123', nickname: '测试音乐账号' } } : { status }; },
  async profile() { return { id: 'test123', nickname: '测试音乐账号' }; },
  async playlists() { return [{ id: 'p1', name: '扫码测试歌单', trackCount: 1 }]; },
  async firstTrack() { return null; },
  async playlistTracks() { return [{ id: 't1', title: '测试歌曲', artist: '测试艺人' }]; },
  async lyrics() { return { lyric: '', translation: '' }; },
  async search() { return [{ id: 't1', title: '测试歌曲', artist: '测试艺人' }]; },
};
const f = await fixture(live ? {} : { providers: { qq: fake, netease: fake } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 880 } });
page.setDefaultTimeout(20000);
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && m.text().includes('Content Security Policy')) errors.push(m.text()); });
const click = (action, id) => page.locator(`[data-action="${action}"]${id ? `[data-id="${id}"]` : ''}`).first().click();
try {
  await page.goto(f.url); await page.locator('#register-tab').click();
  for (const value of ['Upper123', '用户123', 'user_name', 'ab']) {
    await page.locator('#username').fill(value);
    assert.equal(await page.locator('#username').evaluate(el => el.checkValidity()), false);
  }
  await page.locator('#username').fill('qrtest123'); await page.locator('#password').fill('Test-password-123');
  await page.locator('#confirm-password').fill('Test-password-123'); await page.locator('#auth-submit').click();
  await page.getByRole('heading', { name: '现在聆听', exact: true }).waitFor();
  await click('settings');
  for (const provider of ['qq', 'netease']) {
    await click('connect-provider', provider);
    await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth > 50);
    const response = await page.waitForResponse(r => /\/qr\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    assert.equal((await response.json()).status, 'waiting');
    if (!live) {
      status = 'scanned';
      await page.getByText('已扫码，请在手机上确认登录', { exact: true }).waitFor();
      status = 'expired'; await page.getByText('二维码已失效，请刷新', { exact: true }).waitFor();
      const before = qrCount; status = 'waiting'; await click('refresh-qr', provider);
      await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth > 50);
      assert.equal(qrCount, before + 1);
    }
    await click('close-dialog'); await page.locator('#dialog').waitFor({ state: 'hidden' });
    console.log(`PASS ${provider}: ${live ? '真实平台二维码显示与等待扫码响应' : '等待、扫码确认、失效、刷新、关闭'}`);
  }
  if (!live) {
    const qrEndpoint = '**/api/providers/qq/qr';
    const failQr = route => route.fulfill({ status: 502, json: { error: '音乐平台响应超时，请检查网络后重试' } });
    await page.route(qrEndpoint, failQr);
    await click('connect-provider', 'qq');
    await page.locator('#dialog [role="alert"]').getByText(/响应超时/).waitFor();
    await page.unroute(qrEndpoint, failQr);
    const brokenImage = route => route.fulfill({ status: 201, json: { id: 'broken', image: 'data:image/png;base64,AAAA' } });
    await page.route(qrEndpoint, brokenImage);
    await click('refresh-qr', 'qq');
    await page.locator('#dialog [role="alert"]').getByText(/二维码图片加载失败/).waitFor();
    await page.unroute(qrEndpoint, brokenImage);
    const pollEndpoint = '**/api/providers/qq/qr/*';
    const failPoll = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 404, json: { error: '二维码不存在或已取消' } })
      : route.continue();
    await page.route(pollEndpoint, failPoll);
    await click('refresh-qr', 'qq');
    await page.waitForFunction(() => document.querySelector('#qr-status')?.textContent.includes('二维码不存在或已取消'));
    assert.equal(await page.locator('.qr-image').isVisible(), false);
    await page.unroute(pollEndpoint, failPoll);
    await click('refresh-qr', 'qq');
    await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth > 50);
    await page.keyboard.press('Escape');
    await page.locator('#dialog').waitFor({ state: 'hidden' });
    console.log('PASS: 平台取码失败、图片无法解码、扫码会话失效、刷新恢复及 Esc 关闭');
    status = 'authorized'; await click('connect-provider', 'netease');
    await page.locator('[data-action="sync-provider"][data-id="netease"]').waitFor();
    await page.locator('[data-group="netease"] [data-action="open-list"]').waitFor();
    assert.equal(await page.locator('#content .playlist-card').count(), 0);
    assert.equal(await page.locator('.account-overview').count(), 1);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/providers.png' });
    await click('open-list'); await page.getByText('测试歌曲', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-action="edit-list"]').count(), 0);
    assert.equal(await page.locator('[data-action="download"]').first().isDisabled(), true);
    let playable = false;
    await page.route('**/api/tracks/*/audio', route => route.fulfill(playable
      ? { status: 200, contentType: 'audio/wav', body: wav(10) }
      : { status: 403, contentType: 'application/json', body: JSON.stringify({ error: '此歌曲需要平台播放权限，请更换歌曲', code: 'PROVIDER_PLAYBACK_RESTRICTED' }) }));
    await click('play');
    await page.waitForFunction(() => !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('此歌曲需要平台播放权限，请更换歌曲'));
    assert.equal(await page.locator('#account-name').textContent(), 'qrtest123');
    playable = true;
    await page.locator('#play-toggle').click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
    await page.locator('#play-toggle').click();
    await page.unroute('**/api/tracks/*/audio');
    console.log('PASS: 显示平台播放错误，失败后同一首歌曲可重试播放');
    await page.locator('#search').fill('测试'); await page.locator('#search').press('Enter');
    await page.locator('#content').getByText('测试歌曲', { exact: true }).first().waitFor();
    await click('settings'); await click('disconnect-provider', 'netease'); await click('confirm-disconnect-provider', 'netease');
    await page.locator('[data-action="connect-provider"][data-id="netease"]').waitFor();
    assert.equal(await page.locator('.playlist-card').count(), 0);
    console.log('PASS: 测试适配器授权后自动同步、只读歌单、搜索与解绑');
    assert.ok(polls >= 7);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 无脚本或 CSP 错误；真实个人账号授权需本人扫码验证');
} finally { await browser.close(); await f.close(); }
