import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(tmpdir());
const dataDir = await mkdtemp(join(root, 'harmony-portable-test-'));
const portServer = createServer();
await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port;
await new Promise(r => portServer.close(r));
const env = { ...process.env, HARMONY_USER_DATA: dataDir, HARMONY_TEST_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const child = spawn(resolve(process.env.HARMONY_TEST_EXE || `release/${version}/Windows-x64/Harmony-${version}-Windows-x64-portable.exe`), [`--remote-debugging-port=${port}`], {
  env, windowsHide: true, stdio: 'ignore',
});
const exited = new Promise(resolveExit => child.once('exit', resolveExit));
let browser;
try {
  let reachable = false;
  for (let i = 0; i < 120; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) { reachable = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(`Portable exited: ${child.exitCode}`);
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(reachable, true, 'Portable application did not start');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.locator('#auth').waitFor({ state: 'visible' });
  assert.equal(await page.title(), '和音 · 让音乐回到音乐');
  await page.locator('#register-tab').click(); await page.locator('#username').fill('portable123');
  await page.locator('#password').fill('Portable-password-123'); await page.locator('#confirm-password').fill('Portable-password-123');
  await page.locator('#auth-submit').click();
  await page.getByRole('heading', { name: '现在聆听', exact: true }).waitFor();
  assert.equal(await page.locator('#account-name').textContent(), 'portable123');
  assert.equal(await page.locator('#connection-settings').count(), 0);
  const overlayOpened = browser.contexts()[0].waitForEvent('page');
  await page.locator('#desktop-lyrics').click();
  await page.waitForFunction(() => document.querySelector('#desktop-lyrics').getAttribute('aria-pressed') === 'true');
  const overlay = await overlayOpened;
  await overlay.locator('[data-control="lock"]').click();
  await overlay.waitForFunction(() => document.querySelector('#overlay').classList.contains('locked'));
  await page.locator('#desktop-lyrics').click();
  await page.locator('#account-button').click();
  for (const provider of (process.env.HARMONY_LIVE_PROVIDERS === '1' ? ['qq', 'netease'] : [])) {
    await page.locator(`[data-action="connect-provider"][data-id="${provider}"]`).click();
    await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth > 50);
    const response = await page.waitForResponse(r => /\/qr\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    assert.equal((await response.json()).status, 'waiting');
    await page.locator('[data-action="close-dialog"]').click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });
  }
  await page.evaluate(() => window.close());
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Portable did not exit')), 15000))]);
  console.log('Portable PASS: self-extracting EXE, registration, desktop lyrics, hidden configuration and clean exit' + (process.env.HARMONY_LIVE_PROVIDERS === '1' ? ', both real platform QR images' : ''));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  if (!resolve(dataDir).startsWith(root + '\\') && !resolve(dataDir).startsWith(root + '/')) throw new Error('Unsafe cleanup');
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
