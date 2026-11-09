import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, wav } from './helpers.js';
const root = await mkdtemp(join(tmpdir(), 'harmony-local-ref-')), handlers = new Map(); let selection;
const source = join(root, 'original'), data = join(root, 'profile'), file = join(source, '曲目.wav');
await mkdir(join(source, 'nested'), { recursive: true }); await mkdir(data);
await writeFile(file, wav(5)); await writeFile(join(source, 'nested', '第二首.wav'), wav()); await writeFile(join(source, 'notes.txt'), 'skip');
createRequire(import.meta.url)('../desktop/local-files.cjs')({ app: { getPath: () => data }, ipcMain: { handle: (n, f) => handlers.set(n, f) }, dialog: { showOpenDialog: async () => selection }, trusted: e => e === true, getWindow: () => null });
const invoke = (method, value) => handlers.get('local-files:' + method)(true, value);
selection = { canceled: false, filePaths: [file] }; assert.equal((await invoke('pick', 'files')).length, 1);
selection.filePaths = [source]; const records = await invoke('pick', 'folder'); assert.equal(records.length, 2); assert.equal((await invoke('pick', 'folder')).length, 2);
assert.deepEqual(await readdir(data), ['local-music.json']);
await rename(file, file + '.moved'); await assert.rejects(invoke('read', records[0].id), /原文件/); await rename(file + '.moved', file);
const f = await fixture({ localGuestKey: 'refs' }), guest = f.client(); await guest.request('/auth/guest', 'POST', {}, { 'X-Harmony-Local-Key': 'refs' });
const browser = await chromium.launch({ channel: 'chrome', headless: true }), context = await browser.newContext({ viewport: { width: 1320, height: 880 } });
await context.addCookies([{ name: 'harmony_session', value: guest.cookie.split('=')[1], url: f.url }]);
let reads = 0;
await context.exposeBinding('localList', () => invoke('list'));
await context.exposeBinding('localRead', async (_, id) => { reads++; return [...await invoke('read', id)]; });
await context.addInitScript(() => { window.harmonyDesktop = { updateLyrics: () => {}, onLyricsVisibility: () => {}, onLyricsNotice: () => {}, onLyricsControl: () => {}, listLocalFiles: () => window.localList(), pickLocalFiles: () => window.localList(), readLocalFile: async id => new Uint8Array(await window.localRead(id)), setLyricsVisible: async () => false }; });
const page = await context.newPage(), errors = [], uploads = [];
page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.url().includes('/tracks/import')) uploads.push(r.url()); });
try {
 await page.goto(f.url); await page.locator('#app').waitFor({ state: 'visible' });
 assert.equal(await page.locator('#top-import').count(), 0); assert.equal(await page.locator('[data-id=local] + [data-id=downloads]').count(), 1);
 await page.locator('[data-action=navigate][data-id=local]').click(); assert.equal(await page.locator('tr[data-track]').count(), 2); assert.equal(reads, 0);
 await page.locator('[data-action=import-folder]').click(); assert.equal(reads, 0); assert.equal(await page.locator('audio').evaluate(a => a.paused), true);
 await page.locator('tr[data-track] [data-action=play]').first().click(); await page.waitForFunction(() => document.querySelector('audio').currentTime > .1); assert.equal(reads, 1);
 await page.reload(); await page.locator('[data-action=navigate][data-id=local]').click(); assert.equal(await page.locator('tr[data-track]').count(), 2);
 await page.screenshot({ path: 'test-results/local-music-import.png' });
 assert.equal((await guest.request('/library')).data.tracks.length, 0); assert.deepEqual(uploads, []); assert.deepEqual(errors, []);
 console.log('PASS: 路径索引、文件/递归文件夹、去重、重载、按需播放、缺失文件提示、无上传或复制、侧栏页面');
} finally { await browser.close(); await f.close(); await rm(root, { recursive: true, force: true }); }


