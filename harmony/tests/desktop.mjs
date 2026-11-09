import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { wav } from './helpers.js';

const tempRoot = resolve(tmpdir());
const userData = await mkdtemp(join(tempRoot, 'harmony-desktop-test-'));
const packaged = process.env.HARMONY_TEST_EXE;
const env = { ...process.env, HARMONY_USER_DATA: userData, HARMONY_TEST_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
async function launch() {
  app = await electron.launch({ ...(packaged ? { executablePath: resolve(packaged), args: [] } : { args: ['.'] }), env, timeout: 45000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}
try {
  console.log('Desktop checkpoint: 启动完成');
  let page = await launch();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.locator('#auth').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.harmonyDesktop.connection), 'undefined');
  assert.equal(await page.locator('#connection-settings').count(), 0);
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
  await page.locator('#register-tab').click();
  await page.locator('#username').fill('desktop123');
  await page.locator('#password').fill('Desktop-password-123');
  await page.locator('#confirm-password').fill('Desktop-password-123');
  await page.locator('#auth-submit').click();
  await page.getByRole('heading', { name: '现在聆听', exact: true }).waitFor();
  await page.locator('[data-action="new-list"]').first().click();
  await page.locator('#list-name').fill('Windows 桌面歌单');
  await page.locator('#playlist-form [type=submit]').click();
  await page.getByRole('heading', { name: 'Windows 桌面歌单', exact: true }).waitFor();
  const audioPath = join(userData, 'Desktop music.wav'); await writeFile(audioPath, wav(3));
  await page.locator('#file-input').setInputFiles(audioPath);
  await page.waitForFunction(() => document.querySelector('#sync-state')?.textContent.includes('资料库已同步'));
  await page.locator('[data-action="navigate"][data-id="tracks"]').click();
  await page.locator('tr[data-track]').waitFor();
  await page.locator('[data-action="play"]').click();
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.05);
  await page.locator('#play-toggle').click();
  console.log('Desktop checkpoint: 切换桌面歌词');
  await page.locator('#desktop-lyrics').click();
  await page.waitForFunction(() => document.querySelector('#desktop-lyrics').getAttribute('aria-pressed') === 'true');
  const overlay = app.windows().find(w => w !== page);
  assert.ok(overlay);
  await overlay.locator('#line').waitFor();
  await overlay.waitForFunction(() => document.querySelector('#line').textContent.includes('暂无歌词'));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle().includes('桌面歌词'))?.isAlwaysOnTop()), true);
  await overlay.locator('[data-control="lock"]').evaluate(button => button.click());
  await overlay.waitForFunction(() => document.querySelector('#overlay').classList.contains('locked'));
  assert.ok((await page.locator('#toast').textContent()).includes('桌面歌词已锁定'));
  console.log('Desktop checkpoint: 切换桌面歌词');
  await page.locator('#desktop-lyrics').click();
  assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+L')), false);
  await page.locator('#now-playing').click();
  await page.locator('#lyrics-page').waitFor();
  assert.ok((await page.locator('.lyric-placeholder').textContent()).includes('暂无歌词'));
  await page.locator('[data-action="navigate"][data-id="tracks"]').click();
  console.log('Desktop checkpoint: 开始下载验证');
  const downloadPath = join(userData, 'download.wav');
  await app.evaluate(({ session }, file) => {
    globalThis.harmonyDownloadResult = null;
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file);
      item.once('done', (_event, state) => { globalThis.harmonyDownloadResult = state; });
    });
  }, downloadPath);
  await page.locator('[data-action="download"]').click();
  for (let i = 0; i < 40; i++) {
    if (await app.evaluate(() => globalThis.harmonyDownloadResult)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(await app.evaluate(() => globalThis.harmonyDownloadResult), 'completed');
  assert.deepEqual(await readFile(downloadPath), wav(3));
  assert.deepEqual(errors, []);
  console.log('Desktop checkpoint: 关闭并重启');
  await app.close(); app = null;
  console.log('Desktop checkpoint: 重启完成');
  page = await launch();
  await page.locator('.playlist-card').first().waitFor();
  assert.equal(await page.locator('.playlist-card h3').textContent(), 'Windows 桌面歌单');
  assert.equal(await page.locator('#account-name').textContent(), 'desktop123');
  await mkdir('test-results', { recursive: true });
  if (!packaged) await page.screenshot({ path: 'test-results/windows-desktop.png' });
  console.log('Desktop PASS: app startup, isolated renderer, hidden configuration, desktop lyrics, registration, playlists, actual audio, actual download, restart and persistent session');
} finally {
  if (app) await app.close();
  if (!resolve(userData).startsWith(tempRoot + '\\') && !resolve(userData).startsWith(tempRoot + '/')) throw new Error('Unsafe cleanup');
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
