import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { ApiError } from '../src/security.js';
import { safeMediaUrl } from '../src/providers/http.js';

function fakeProvider(name = 'netease') {
  return {
    async startQr() { return { image: 'data:image/png;base64,TEST', hint: '测试二维码', secret: { token: 'private-qr-secret' } }; },
    async pollQr() { return { status: 'authorized', credential: { cookie: 'MUSIC_U=test-secret-value' }, profile: { id: name + '-user', nickname: '测试音乐账号' } }; },
    async profile() { return { id: name + '-user', nickname: '测试音乐账号' }; },
    async playlists() { return [{ id: 'remote-list', name: '真实接口契约测试歌单', trackCount: 2 }]; },
    async playlistTracks() { return [{ id: 'song1', title: '曲目一', artist: '艺人一' }, { id: 'song2', title: '曲目二', duration: 200 }]; },
    async search() { return [{ id: 'song1', title: '曲目一', artist: '艺人一' }]; },
    async playback() { return 'https://m701.music.126.net/test.mp3'; },
  };
}
async function setup(t) {
  const providers = { qq: fakeProvider('qq'), netease: fakeProvider() }, f = await fixture({ providers });
  t.after(() => f.close()); return { ...f, providers };
}
async function bind(c, provider = 'netease') {
  const qr = await c.request(`/providers/${provider}/qr`, 'POST', {});
  assert.equal(qr.status, 201);
  const result = await c.request(`/providers/${provider}/qr/${qr.data.id}`, 'POST', {});
  assert.equal(result.status, 200); assert.equal(result.data.status, 'authorized');
  return { qr: qr.data, result: result.data };
}
test('二维码会话按账号隔离；凭据加密且不返回客户端', async t => {
  const f = await setup(t), a = f.client(), b = f.client(); await a.register('user1'); await b.register('user2');
  const qr = (await a.request('/providers/netease/qr', 'POST', {})).data;
  assert.ok(!JSON.stringify(qr).includes('private-qr-secret'));
  assert.equal((await b.request(`/providers/netease/qr/${qr.id}`, 'POST', {})).status, 404);
  const result = await a.request(`/providers/netease/qr/${qr.id}`, 'POST', {});
  assert.equal(result.data.status, 'authorized');
  assert.ok(!JSON.stringify(result.data).includes('test-secret-value'));
  const encrypted = f.app.db.prepare('SELECT credential FROM provider_connections').get().credential;
  assert.ok(!encrypted.includes('MUSIC_U')); assert.ok(!encrypted.includes('test-secret-value'));
  assert.equal((await readFile(join(f.dir, 'platform.key'))).length, 32);
  assert.equal((await a.request('/providers')).data.providers.find(p => p.id === 'netease').connected, true);
  assert.equal((await b.request('/providers')).data.providers.find(p => p.id === 'netease').connected, false);
});
test('扫码状态来自平台；等待、已扫码和失效不会保存授权', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  for (const status of ['waiting', 'scanned', 'expired']) {
    f.providers.qq.pollQr = async () => ({ status });
    const qr = (await c.request('/providers/qq/qr', 'POST', {})).data;
    assert.equal((await c.request(`/providers/qq/qr/${qr.id}`, 'POST', {})).data.status, status);
    assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').get().n, 0);
  }
});
test('取消二维码及退出账号阻止迟到的登录结果写入', async t => {
  const f = await setup(t), c = f.client(); await c.register();
  let finish; f.providers.qq.pollQr = () => new Promise(resolve => { finish = resolve; });
  const qr = (await c.request('/providers/qq/qr', 'POST', {})).data;
  const polling = c.request(`/providers/qq/qr/${qr.id}`, 'POST', {});
  while (!finish) await new Promise(r => setTimeout(r, 10));
  await c.request(`/providers/qq/qr/${qr.id}`, 'DELETE', {});
  finish(await fakeProvider('qq').pollQr());
  assert.equal((await polling).status, 409);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM provider_connections').get().n, 0);
  const next = (await c.request('/providers/qq/qr', 'POST', {})).data;
  await c.request('/auth/logout', 'POST', {}); await c.login();
  assert.equal((await c.request(`/providers/qq/qr/${next.id}`, 'POST', {})).status, 404);
});
test('平台歌单同步、只读、加载歌曲、混合歌单和解绑保留', async t => {
  const f = await setup(t), c = f.client(); await c.register(); await bind(c);
  assert.equal((await c.request('/providers/netease/sync', 'POST', {})).data.count, 1);
  let library = (await c.request('/library')).data, p = library.playlists[0];
  assert.equal(p.source, 'netease'); assert.equal(p.trackCount, 2); assert.equal(p.loadedAt, null);
  assert.equal((await c.request(`/playlists/${p.id}`, 'PATCH', { name: '修改', version: p.version })).status, 403);
  assert.equal((await c.request(`/platform-playlists/${p.id}/refresh`, 'POST', {})).status, 200);
  library = (await c.request('/library')).data; assert.equal(library.tracks.length, 2); p = library.playlists[0];
  assert.ok(p.loadedAt); assert.equal(library.tracks[0].canDownload, false); assert.equal(library.tracks[0].canPlay, true);
  const own = (await c.request('/playlists', 'POST', { name: '混合' })).data.playlist;
  assert.equal((await c.request(`/playlists/${own.id}/tracks`, 'PUT', { version: own.version, trackIds: p.trackIds })).status, 200);
  assert.equal((await c.request('/providers/netease', 'DELETE', {})).status, 200);
  library = (await c.request('/library')).data;
  assert.equal(library.playlists.length, 1); assert.equal(library.playlists[0].trackIds.length, 2);
  assert.equal(library.tracks[0].canPlay, false); assert.equal((await c.request(`/tracks/${library.tracks[0].id}/audio`)).status, 409);
});
test('平台搜索合并去重、失效提示不会退出和音、重启保留平台授权', async t => {
  const f = await setup(t), c = f.client(); await c.register(); await bind(c); await bind(c, 'qq');
  const result = await c.request('/providers/search', 'POST', { query: '曲目', provider: 'all' });
  assert.equal(result.data.trackIds.length, 2); assert.equal(new Set(result.data.trackIds).size, 2);
  const repeated = await c.request('/providers/search', 'POST', { query: '曲目', provider: 'all' });
  assert.deepEqual(repeated.data.trackIds, result.data.trackIds);
  await f.restart();
  assert.equal((await c.request('/providers')).data.providers.filter(p => p.connected).length, 2);
  f.providers.qq.profile = async () => { throw new ApiError(401, '平台授权已失效', 'PROVIDER_AUTH_EXPIRED'); };
  assert.equal((await c.request('/providers/qq/sync', 'POST', {})).status, 401);
  assert.equal((await c.request('/me')).status, 200);
  assert.equal((await c.request('/providers')).data.providers.find(p => p.id === 'qq').status, 'expired');
});
test('全部音乐汇总未打开的平台歌单、按平台曲目去重，搜索缓存不自动加入', async t => {
  const f = await setup(t), c = f.client(), other = f.client(); await c.register(); await other.register('other123');
  for (const source of ['qq', 'netease']) {
    await bind(c, source);
    f.providers[source].playlists = async () => [{ id: 'one', name: '一', trackCount: 2 }, { id: 'two', name: '二', trackCount: 2 }];
    f.providers[source].search = async () => [{ id: 'search-only', title: '搜索缓存' }];
    await c.request(`/providers/${source}/sync`, 'POST', {});
  }
  const searched = (await c.request('/providers/search', 'POST', { query: '搜索缓存', provider: 'all' })).data.trackIds;
  let library = (await c.request('/library')).data;
  assert.equal(library.tracks.length, 2); assert.deepEqual(library.collectionTrackIds, []);
  assert.equal((await other.request('/library/aggregate', 'POST', {})).data.loaded, 0);
  const aggregated = await c.request('/library/aggregate', 'POST', {});
  assert.equal(aggregated.status, 200); assert.equal(aggregated.data.loaded, 4); assert.deepEqual(aggregated.data.errors, []);
  library = (await c.request('/library')).data;
  assert.equal(library.collectionTrackIds.length, 4);
  assert.ok(searched.every(id => !library.collectionTrackIds.includes(id)));
  assert.ok(library.playlists.every(p => p.loadedAt && p.trackIds.length === 2));
  assert.equal((await c.request('/library/aggregate', 'POST', {})).data.loaded, 0);
  await c.request(`/tracks/${searched[0]}/recent`, 'POST', {});
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 4);
  await c.request(`/tracks/${searched[0]}/favorite`, 'PUT', { favorite: true });
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 5);
  await c.request(`/tracks/${searched[0]}/favorite`, 'PUT', { favorite: false });
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 4);
  const own = (await c.request('/playlists', 'POST', { name: '自己收藏' })).data.playlist;
  await c.request(`/playlists/${own.id}/tracks`, 'PUT', { version: own.version, trackIds: [searched[0]] });
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 5);
  await c.request('/providers/qq', 'DELETE', {});
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 3);
  await f.restart();
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 3);
});

test('汇总歌单部分失败保留成功项，重试只读取未加载歌单', async t => {
  const f = await setup(t), c = f.client(); await c.register(); await bind(c); await bind(c, 'qq');
  await c.request('/providers/qq/sync', 'POST', {}); await c.request('/providers/netease/sync', 'POST', {});
  let calls = 0;
  const original = f.providers.qq.playlistTracks;
  f.providers.qq.playlistTracks = async () => { calls++; if (calls === 1) throw new ApiError(502, '测试暂时失败'); return original(); };
  const first = await c.request('/library/aggregate', 'POST', {});
  assert.equal(first.data.loaded, 1); assert.equal(first.data.errors.length, 1);
  assert.equal((await c.request('/library')).data.collectionTrackIds.length, 2);
  const retry = await c.request('/library/aggregate', 'POST', {});
  assert.equal(retry.data.loaded, 1); assert.deepEqual(retry.data.errors, []);
  assert.equal(calls, 2); assert.equal((await c.request('/library')).data.collectionTrackIds.length, 4);
});

test('平台歌曲不能凭播放链接下载；拒绝非平台和内网媒体地址', async t => {
  const f = await setup(t), c = f.client(); await c.register(); await bind(c);
  const ids = (await c.request('/providers/search', 'POST', { query: '曲目', provider: 'netease' })).data.trackIds;
  assert.equal((await c.request(`/tracks/${ids[0]}/audio?download=1`)).status, 403);
  for (const url of ['http://127.0.0.1/a', 'https://music.126.net.evil.com/a', 'https://aqqmusic.tc.qq.com.evil.com/a', 'https://other.tc.qq.com/a', 'https://evil.com/a', 'https://u:p@music.126.net/a', 'https://graph.qq.com/a', 'file:///test']) assert.throws(() => safeMediaUrl(url));
  assert.equal(safeMediaUrl('http://m701.music.126.net/a'), 'https://m701.music.126.net/a');
  assert.equal(safeMediaUrl('http://aqqmusic.tc.qq.com/C400song.m4a?vkey=test'), 'https://aqqmusic.tc.qq.com/C400song.m4a?vkey=test');
});

test('旧版数据库升级保留账号、会话、歌单、收藏和音频', async t => {
  const f = await fixture(); t.after(() => f.close());
  const c = f.client(); await c.register('legacy123');
  const track = (await c.import()).data.track;
  const p = (await c.request('/playlists', 'POST', { name: '升级前歌单' })).data.playlist;
  await c.request(`/playlists/${p.id}/tracks`, 'PUT', { version: p.version, trackIds: [track.id] });
  await c.request(`/tracks/${track.id}/favorite`, 'PUT', { favorite: true });
  // Reconstruct the previous release's schema before reopening with the new app.
  f.app.db.exec('DROP TABLE provider_connections; DROP INDEX playlist_remote; ALTER TABLE playlists DROP COLUMN remote_id; ALTER TABLE playlists DROP COLUMN track_count; ALTER TABLE playlists DROP COLUMN loaded_at; PRAGMA user_version = 1;');
  await f.restart();
  assert.equal(f.app.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal((await c.request('/me')).data.user.username, 'legacy123');
  const lib = (await c.request('/library')).data;
  assert.deepEqual(lib.playlists[0].trackIds, [track.id]);
  assert.deepEqual(lib.favorites, [track.id]);
  assert.equal((await c.request(`/tracks/${track.id}/audio`)).status, 200);
});

test('同步网络失败及中途解除连接不覆盖或恢复旧歌单', async t => {
  const f = await setup(t), c = f.client(); await c.register(); await bind(c);
  await c.request('/providers/netease/sync', 'POST', {});
  const saved = (await c.request('/library')).data.playlists;
  f.providers.netease.playlists = async () => { throw new ApiError(502, '连接暂时中断'); };
  assert.equal((await c.request('/providers/netease/sync', 'POST', {})).status, 502);
  assert.deepEqual((await c.request('/library')).data.playlists, saved);
  let finish; f.providers.netease.playlists = () => new Promise(r => { finish = r; });
  const pending = c.request('/providers/netease/sync', 'POST', {});
  while (!finish) await new Promise(r => setTimeout(r, 10));
  await c.request('/providers/netease', 'DELETE', {});
  finish([{ id: 'late', name: '迟到歌单' }]);
  assert.equal((await pending).status, 409);
  assert.equal((await c.request('/library')).data.playlists.length, 0);
});

test('未绑定时也可搜索，分页分别推进平台页码、保留部分成功并支持失败页重试', async t => {
 const f = await setup(t), c = f.client(); await c.register();
 const calls = []; let fail = true;
 for (const source of ['qq', 'netease']) f.providers[source].search = async (credential, query, page) => {
  assert.deepEqual(credential, {});
  calls.push([source, query, page]);
  if (source === 'netease' && page === 2 && fail) throw new Error('临时失败');
  return { tracks: Array.from({ length: page === 1 ? 30 : 2 }, (_, i) => ({ id: `${source}-${page}-${i}`, title: `歌曲${page}-${i}` })), hasMore: page === 1 };
 };
 const first = (await c.request('/providers/search', 'POST', { query: '音乐', provider: 'all' })).data;
 assert.equal(first.trackIds.length, 60); assert.ok(first.pagination.every(p => p.page === 1 && p.hasMore));
 const second = (await c.request('/providers/search', 'POST', { query: '音乐', provider: 'all', pages: { qq: 2, netease: 2 } })).data;
 assert.equal(second.trackIds.length, 2); assert.equal(second.pagination[0].hasMore, false); assert.equal(second.errors[0].provider, 'netease');
 fail = false;
 const retried = (await c.request('/providers/search', 'POST', { query: '音乐', provider: 'all', pages: { netease: 2 } })).data;
 assert.equal(retried.trackIds.length, 2); assert.equal(retried.pagination[0].hasMore, false);
 assert.deepEqual(calls.at(-1), ['netease', '音乐', 2]);
 for (const pages of [{ qq: 0 }, { qq: -1 }, { qq: 1.5 }, { qq: '2' }, null, [], { unknown: 1 }]) assert.equal((await c.request('/providers/search', 'POST', { query: '音乐', provider: 'all', pages })).status, 400);
});

test('歌曲发表日期与播放量持久化，稀疏响应不擦除，未知值和真实零分开', async t => {
 const f = await setup(t), c = f.client(); await c.register(); await bind(c, 'qq');
 f.providers.qq.search = async () => [{id:'meta',title:'元数据',album:'专辑',releaseDate:'2020-01-02',playCount:0,favoriteCount:1234},{id:'missing',title:'未知',playCount:null}];
 await c.request('/providers/search','POST',{query:'歌曲',provider:'qq'});
 let tracks=(await c.request('/library')).data.tracks;
 assert.equal(tracks.find(t=>t.title==='元数据').releaseDate,'2020-01-02');assert.equal(tracks.find(t=>t.title==='元数据').playCount,0);assert.equal(tracks.find(t=>t.title==='元数据').favoriteCount,1234);
 assert.equal(tracks.find(t=>t.title==='未知').playCount,null);assert.equal(tracks.find(t=>t.title==='未知').favoriteCount,null);assert.equal(tracks.find(t=>t.title==='未知').releaseDate,'');
 f.providers.qq.search=async()=>[{id:'meta',title:'元数据'}];
 await c.request('/providers/search','POST',{query:'歌曲',provider:'qq'});
 tracks=(await c.request('/library')).data.tracks;
 assert.equal(tracks.find(t=>t.title==='元数据').releaseDate,'2020-01-02');assert.equal(tracks.find(t=>t.title==='元数据').playCount,0);assert.equal(tracks.find(t=>t.title==='元数据').favoriteCount,1234);
});
