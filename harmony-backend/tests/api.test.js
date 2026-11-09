import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, wav } from './helpers.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

async function setup(t, options) { const f = await fixture(options); t.after(() => f.close()); return f; }

test('注册、旧登录兼容、密码哈希与 HttpOnly 会话', async t => {
  const f = await setup(t), c = f.client();
  const result = await c.register('musicuser1');
  assert.equal(result.status, 201); assert.equal(result.data.user.username, 'musicuser1');
  assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(result.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.equal((await c.request('/me')).status, 200);
  const stored = f.app.db.prepare('SELECT * FROM users').get();
  assert.match(stored.password_hash, /^scrypt\$/); assert.ok(!stored.password_hash.includes('correct horse'));
  assert.notEqual(f.app.db.prepare('SELECT token_hash FROM sessions').get().token_hash, c.cookie.split('=')[1]);
  assert.equal((await f.client().register('musicuser1')).status, 409);
  assert.equal((await f.client().login('MUSICUSER1')).status, 200);
  f.app.db.prepare('UPDATE users SET username=?,username_key=? WHERE id=?').run('旧用户', '旧用户', result.data.user.id);
  assert.equal((await f.client().login('旧用户')).status, 200);
});
test('输入校验、错误密码、匿名访问与非法 JSON', async t => {
  const f = await setup(t), c = f.client();
  assert.equal((await c.register('ab')).status, 400);
  assert.equal((await c.register('a<b')).status, 400);
  assert.equal((await c.register('listener', 'short')).status, 400);
  for (const name of ['音乐爱好者', 'Music123', 'music_1', 'music.1', 'music-1', 'music 1']) assert.equal((await c.register(name)).status, 400);
  assert.equal((await c.register('music123')).status, 201);
  assert.equal((await f.client().login('music123', 'wrong password')).status, 401);
  assert.equal((await f.client().request('/library')).status, 401);
  assert.equal((await c.request('/playlists', 'POST', Buffer.from('{'))).status, 400);
  assert.equal((await c.request('/playlists', 'POST', { name: ' ' })).status, 400);
});
test('拒绝跨来源写入、表单请求和伪造 Host', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  assert.equal((await c.request('/playlists', 'POST', { name: 'x' }, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await c.request('/playlists', 'POST', { name: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url + '/api/library', { headers: { Host: 'evil.invalid', Cookie: c.cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHostStatus, 403);
  const page = await fetch(f.url);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});
test('多个账号的歌单、音乐、收藏和音频相互隔离', async t => {
  const f = await setup(t), a = f.client(), b = f.client(); await a.register('accounta'); await b.register('accountb');
  const p = (await a.request('/playlists', 'POST', { name: 'A 的歌单' })).data.playlist;
  const song = (await a.import()).data.track;
  assert.equal((await b.request(`/playlists/${p.id}`)).status, 404);
  assert.equal((await b.request(`/playlists/${p.id}`, 'PATCH', { name: '偷改', version: 1 })).status, 404);
  assert.equal((await b.request(`/playlists/${p.id}`, 'DELETE', { version: 1 })).status, 404);
  assert.equal((await b.request(`/tracks/${song.id}/audio`)).status, 404);
  assert.equal((await b.request(`/tracks/${song.id}/favorite`, 'PUT', { favorite: true })).status, 404);
  const bp = (await b.request('/playlists', 'POST', { name: 'B 的歌单' })).data.playlist;
  assert.equal((await b.request(`/playlists/${bp.id}/tracks`, 'PUT', { version: 1, trackIds: [song.id] })).status, 404);
  const library = (await b.request('/library')).data;
  assert.equal(library.playlists.length, 1); assert.equal(library.tracks.length, 0); assert.deepEqual(library.favorites, []);
});
test('歌单新建、修改、去重、曲序、移除与删除', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  const p = (await c.request('/playlists', 'POST', { name: '午后', description: '专注', color: 'blue' })).data.playlist;
  assert.equal(p.source, 'own'); assert.equal(p.color, 'blue');
  const one = (await c.import('one.wav')).data.track, two = (await c.import('two.wav')).data.track;
  assert.equal((await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 1, trackIds: [one.id, one.id] })).status, 400);
  let result = await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 1, trackIds: [one.id, two.id] });
  assert.equal(result.status, 200); assert.equal(result.data.playlist.version, 2);
  result = await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 2, trackIds: [two.id, one.id] });
  assert.deepEqual(result.data.playlist.trackIds, [two.id, one.id]);
  result = await c.request(`/playlists/${p.id}`, 'PATCH', { version: 3, name: '夜晚', description: '听歌' });
  assert.equal(result.data.playlist.name, '夜晚');
  result = await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 4, trackIds: [one.id] });
  assert.deepEqual(result.data.playlist.trackIds, [one.id]);
  assert.equal((await c.request(`/playlists/${p.id}`, 'DELETE', { version: 5 })).status, 200);
  assert.equal((await c.request('/library')).data.tracks.length, 2);
});
test('并发歌单修改只接受一个版本，防止静默覆盖', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  const p = (await c.request('/playlists', 'POST', { name: '原名' })).data.playlist;
  const results = await Promise.all(['名字 A', '名字 B'].map(name => c.request(`/playlists/${p.id}`, 'PATCH', { name, version: 1 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await c.request(`/playlists/${p.id}`)).data.playlist.version, 2);
});
test('平台歌单只读，无法通过修改接口编辑', async t => {
  const f = await setup(t), c = f.client(); const user = (await c.register()).data.user;
  const p = (await c.request('/playlists', 'POST', { name: '平台歌单' })).data.playlist;
  f.app.db.prepare("UPDATE playlists SET source = 'qq' WHERE id = ? AND user_id = ?").run(p.id, user.id);
  assert.equal((await c.request(`/playlists/${p.id}`, 'PATCH', { name: '覆盖', version: 1 })).status, 403);
  assert.equal((await c.request(`/playlists/${p.id}`, 'DELETE', { version: 1 })).status, 403);
});
test('收藏、播放记录、重启后数据和会话持久化', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  const song = (await c.import()).data.track;
  const p = (await c.request('/playlists', 'POST', { name: '持久化' })).data.playlist;
  await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 1, trackIds: [song.id] });
  await c.request(`/tracks/${song.id}/favorite`, 'PUT', { favorite: true });
  await c.request(`/tracks/${song.id}/recent`, 'POST', {});
  await f.restart();
  const library = (await c.request('/library')).data;
  assert.equal(library.playlists[0].name, '持久化'); assert.deepEqual(library.playlists[0].trackIds, [song.id]);
  assert.deepEqual(library.favorites, [song.id]); assert.deepEqual(library.recent, [song.id]);
  assert.equal((await c.request(`/tracks/${song.id}/audio`)).status, 200);
});
test('真实音频字节、范围请求和原始文件下载', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  const bytes = wav(), song = (await c.import('我的音乐.wav', bytes)).data.track;
  assert.equal(song.canDownload, true); assert.equal(song.canPlay, true);
  assert.deepEqual((await c.request(`/tracks/${song.id}/audio`)).data, bytes);
  const range = await c.request(`/tracks/${song.id}/audio`, 'GET', undefined, { Range: 'bytes=10-20' });
  assert.equal(range.status, 206); assert.deepEqual(range.data, bytes.subarray(10, 21));
  const suffix = await c.request(`/tracks/${song.id}/audio`, 'GET', undefined, { Range: 'bytes=-4' });
  assert.deepEqual(suffix.data, bytes.subarray(-4));
  assert.equal((await c.request(`/tracks/${song.id}/audio`, 'GET', undefined, { Range: 'bytes=999999-1000000' })).status, 416);
  assert.match((await c.request(`/tracks/${song.id}/audio?download=1`)).headers.get('content-disposition'), /attachment/);
});
test('拒绝伪音频、过大文件、越过配额并清理未成功的文件', async t => {
  const f = await setup(t, { maxUploadMB: 0.1, userStorageMB: 0.025 }), c = f.client(); await c.register();
  assert.equal((await c.import('x.exe')).status, 415);
  assert.equal((await c.import('x.mp3', Buffer.alloc(100))).status, 415);
  assert.equal((await c.import('first.wav')).status, 201);
  assert.equal((await c.import('too-much.wav')).status, 413);
  assert.equal((await readdir(join(f.dir, 'media'))).length, 1);
  assert.equal((await c.request('/library')).data.tracks.length, 1);
});
test('删除音乐会移除全部关联并使旧歌单版本失效', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  const song = (await c.import()).data.track;
  const p = (await c.request('/playlists', 'POST', { name: '测试' })).data.playlist;
  await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: 1, trackIds: [song.id] });
  await c.request(`/tracks/${song.id}/favorite`, 'PUT', { favorite: true });
  await c.request(`/tracks/${song.id}/recent`, 'POST', {});
  assert.equal((await c.request(`/tracks/${song.id}`, 'DELETE', {})).status, 200);
  const library = (await c.request('/library')).data;
  assert.equal(library.tracks.length, 0); assert.equal(library.favorites.length, 0); assert.equal(library.recent.length, 0);
  assert.deepEqual(library.playlists[0].trackIds, []); assert.equal(library.playlists[0].version, 3);
  assert.equal((await readdir(join(f.dir, 'media'))).length, 0);
});
test('退出后旧会话不可复用，过期会话不可用', async t => {
  const f = await setup(t), c = f.client(); await c.register(); const cookie = c.cookie;
  await c.request('/auth/logout', 'POST', {});
  assert.equal((await c.request('/library', 'GET', undefined, { Cookie: cookie })).status, 401);
  await c.login(); f.app.db.prepare('UPDATE sessions SET expires_at = 0').run();
  assert.equal((await c.request('/library')).status, 401);
});
test('修改密码撤销其他设备会话，旧密码不可再登录', async t => {
  const f = await setup(t), a = f.client(), b = f.client(); await a.register(); await b.login();
  assert.equal((await a.request('/auth/password', 'POST', { currentPassword: 'wrong password', newPassword: 'new secure password' })).status, 400);
  assert.equal((await a.request('/auth/password', 'POST', { currentPassword: 'correct horse battery', newPassword: 'new secure password' })).status, 200);
  assert.equal((await a.request('/me')).status, 200);
  assert.equal((await b.request('/me')).status, 401);
  assert.equal((await b.login()).status, 401);
  assert.equal((await b.login('listener', 'new secure password')).status, 200);
});
test('登录失败触发限流', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  for (let i = 0; i < 12; i++) assert.equal((await c.login('listener', 'wrong password')).status, 401);
  assert.equal((await c.login()).status, 429);
});
