import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const register = createRequire(import.meta.url)('../desktop/playlist-file.cjs');
test('HY save uses selected destination, JSON content, cancellation and trust checks', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'harmony-hy-save-'));
 let handler, options, result = { canceled: true };
 register({ ipcMain: { handle: (_, fn) => handler = fn }, dialog: { showSaveDialog: async (_, value) => { options = value; return result; } }, trusted: e => e === true, getWindow: () => null });
 const input = { filename: '和音歌单-2026-11-08.hy', content: JSON.stringify({ playlists: [], favorites: [] }, null, 2) };
 try {
  assert.equal(await handler(true, input), false); assert.deepEqual(await readdir(dir), []);
  result = { canceled: false, filePath: join(dir, '自选文件.hy') };
  assert.equal(await handler(true, input), true);
  assert.equal(await readFile(result.filePath, 'utf8'), input.content);
  assert.deepEqual(options.filters, [{ name: '和音歌单', extensions: ['hy'] }]);
  assert.equal(options.defaultPath, input.filename);
  await assert.rejects(handler(false, input), /访问被拒绝/);
  await assert.rejects(handler(true, { ...input, content: '{broken' }));
  result = { canceled: false, filePath: join(dir, 'wrong.json') };
  await assert.rejects(handler(true, input), /后缀/);
  assert.deepEqual(await readdir(dir), ['自选文件.hy']);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
