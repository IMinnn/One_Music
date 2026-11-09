import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, wav } from './helpers.js';

const remote = await fixture(), root = resolve(tmpdir()), userData = await mkdtemp(join(root, 'harmony-local-test-'));
const env = { ...process.env, HARMONY_USER_DATA: userData, HARMONY_TEST_HIDDEN: '1', HARMONY_SERVER_URL: remote.url };
delete env.ELECTRON_RUN_AS_NODE;
await remote.client().register('localmodetest', 'Local-test-password-1');
let app;
async function launch() {
  app = await electron.launch({ ...(process.env.HARMONY_TEST_EXE ? { executablePath: resolve(process.env.HARMONY_TEST_EXE), args: [] } : { args: ['.'] }), env, timeout: 45000 });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return page;
}
try {
  let page = await launch(); await page.locator('#auth').waitFor({ state: 'visible' });
  await page.locator('#guest-start').click();
  await page.waitForFunction(() => document.querySelector('#account-name').textContent === '关联音乐平台账号');
  assert.notEqual(new URL(page.url()).origin, remote.url);
  assert.equal((await page.request.get(new URL('/api/me', page.url()).href)).ok(), true);
  await page.locator('[data-action="new-list"]').first().click(); await page.locator('#list-name').fill('本地保存的歌单'); await page.locator('#playlist-form [type="submit"]').click();
  await page.getByRole('heading', { name: '本地保存的歌单', exact: true }).waitFor();
  assert.equal(remote.app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  await app.close(); app = null;
  page = await launch(); await page.locator('.playlist-card').first().waitFor();
  assert.equal(await page.locator('#account-name').textContent(), '关联音乐平台账号');
  assert.equal(await page.locator('.playlist-card h3').textContent(), '本地保存的歌单');
  await page.locator('#account-button').click();
  assert.equal(await page.locator('[data-action="password"]').count(), 0);
  const localUrl = page.url();
  const seeded = await page.request.post(new URL('/api/tracks/import?name=continuation.wav', page.url()).href, { headers: { Origin: new URL(page.url()).origin, 'Content-Type': 'application/octet-stream' }, data: wav(60) });
  const localTrack = (await seeded.json()).track.id;
  await page.reload(); await page.locator(`[data-action="play"][data-id="${localTrack}"]`).first().click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  const audioSource = await page.locator('audio').getAttribute('src');
  await page.locator('#account-button').click(); await page.locator('[data-action="account-mode"]').click();
  await page.locator('#account-login-form').waitFor();
  await page.locator('#account-username').fill('localmodetest'); await page.locator('#account-password').fill('Local-test-password-1');
  await page.locator('#account-login-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#account-name').textContent === 'localmodetest');
  assert.equal(page.url(), localUrl);
  assert.equal(await page.locator('audio').getAttribute('src'), audioSource);
  assert.equal(await page.locator('audio').evaluate(a => a.paused), false);
  const remoteAccount = await (await page.request.get(new URL('/api/me', page.url()).href)).json();
  assert.equal(remoteAccount.user.username, 'localmodetest');
  assert.equal((await page.request.get(new URL(`/api/tracks/${localTrack}/audio`, page.url()).href, { headers: { Range: 'bytes=0-43' } })).status(), 206);
  assert.equal(await page.locator('.playlist-card').count(), 0);
  await page.locator('[data-action="new-list"]').first().click(); await page.locator('#list-name').fill('远程账号歌单'); await page.locator('#playlist-form [type=submit]').click();
  await page.getByRole('heading', { name: '远程账号歌单', exact: true }).waitFor();
  assert.equal(remote.app.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE name=?').get('远程账号歌单').n, 1);
  await app.close(); app = null;
  page = await launch(); await page.waitForFunction(() => document.querySelector('#account-name').textContent === 'localmodetest');
  console.log('PASS: remote account modal login keeps local playback and origin; proxy session survives restart');
  await page.locator('#account-button').click(); await page.locator('[data-action="logout"]').click(); await page.locator('[data-action="confirm-logout"]').click();
  await page.locator('#guest-start').click(); await page.locator('.playlist-card').first().waitFor();
  assert.equal(await page.locator('.playlist-card h3').textContent(), '本地保存的歌单');
  console.log('Desktop local PASS: no account login, local disk storage despite remote configuration, restart restoration, account switching and isolated data');
} finally {
  if (app) await app.close(); await remote.close();
  if (!resolve(userData).startsWith(root + '\\') && !resolve(userData).startsWith(root + '/')) throw new Error('Unsafe cleanup');
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
