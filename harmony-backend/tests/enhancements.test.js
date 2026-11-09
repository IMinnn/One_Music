import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { QQProvider } from '../src/providers/qq.js';
import { NeteaseProvider } from '../src/providers/netease.js';

test('歌单布局按账号持久化、跨设备恢复、版本冲突和隔离校验', async t => {
  const f = await fixture(); t.after(() => f.close());
  const a = f.client(), otherDevice = f.client(), b = f.client();
  await a.register('sortuser'); await otherDevice.login('sortuser'); await b.register('another');
  const one = (await a.request('/playlists', 'POST', { name: '一' })).data.playlist.id;
  const two = (await a.request('/playlists', 'POST', { name: '二' })).data.playlist.id;
  const layout = { groups: ['netease', 'own', 'qq'], lists: { own: [two, one], qq: [], netease: [] }, version: 0 };
  assert.equal((await a.request('/playlist-layout', 'PUT', layout)).status, 200);
  const restored = (await otherDevice.request('/library')).data.playlistLayout;
  assert.deepEqual(restored.lists.own, [two, one]); assert.deepEqual(restored.groups, layout.groups);
  assert.equal((await otherDevice.request('/playlist-layout', 'PUT', layout)).status, 409);
  assert.equal((await b.request('/playlist-layout', 'PUT', layout)).status, 400);
  assert.equal((await b.request('/library')).data.playlistLayout.version, 0);
  assert.equal((await a.request('/playlist-layout', 'PUT', { ...layout, groups: ['qq', 'qq', 'own'], version: 1 })).status, 400);
  await f.restart();
  assert.deepEqual((await a.request('/library')).data.playlistLayout, restored);
});

test('歌单折叠状态按账号保存，兼容旧客户端排序写入与校验', async t => {
  const f = await fixture(); t.after(() => f.close()); const a = f.client(), second = f.client();
  await a.register(); await second.login();
  const data = { groups: ['own', 'qq', 'netease'], lists: {}, collapsed: ['qq'], version: 0 };
  assert.equal((await a.request('/playlist-layout', 'PUT', data)).status, 200);
  assert.deepEqual((await second.request('/library')).data.playlistLayout.collapsed, ['qq']);
  const { collapsed, ...legacy } = data;
  assert.equal((await second.request('/playlist-layout', 'PUT', { ...legacy, version: 1 })).status, 200);
  await f.restart();
  assert.deepEqual((await a.request('/library')).data.playlistLayout.collapsed, ['qq']);
  assert.equal((await a.request('/playlist-layout', 'PUT', { ...data, collapsed: ['invalid'], version: 2 })).status, 400);
});

test('平台封面提取', () => {
  assert.ok(new QQProvider().normalize({ mid: 'x', album: { mid: 'abc' } }).coverUrl.includes('abc.jpg'));
  assert.equal(new NeteaseProvider().normalize({ id: 1, al: { picUrl: 'https://p1.music.126.net/a.jpg' } }).coverUrl, 'https://p1.music.126.net/a.jpg');
});

test('歌词鉴权与账号隔离、封面保存与不可信地址过滤', async t => {
  const adapter = {
    startQr: async () => ({ secret: {}, image: '', hint: '' }),
    pollQr: async () => ({ status: 'authorized', credential: {}, profile: { id: 'music', nickname: 'music' } }),
    search: async () => [
      { id: '1', title: '带封面的歌', coverUrl: 'https://p1.music.126.net/a.jpg' },
      { id: '2', title: '无效封面', coverUrl: 'https://attacker.example/a.jpg' },
    ],
    lyrics: async () => ({ lyric: '[00:00.00]第一句\n[00:01.00]第二句', translation: '' }),
  };
  const f = await fixture({ providers: { netease: adapter, qq: adapter } }); t.after(() => f.close());
  const a = f.client(), b = f.client(); await a.register(); await b.register('otheruser');
  const qr = (await a.request('/providers/netease/qr', 'POST', {})).data;
  await a.request(`/providers/netease/qr/${qr.id}`, 'POST', {});
  const ids = (await a.request('/providers/search', 'POST', { query: '歌', provider: 'netease' })).data.trackIds;
  const tracks = (await a.request('/library')).data.tracks;
  assert.equal(tracks.find(t => t.id === ids[0]).coverUrl, 'https://p1.music.126.net/a.jpg');
  assert.equal(tracks.find(t => t.id === ids[1]).coverUrl, '');
  assert.ok((await a.request(`/tracks/${ids[0]}/lyrics`)).data.lyric.includes('第二句'));
  assert.equal((await b.request(`/tracks/${ids[0]}/lyrics`)).status, 404);
  await a.request('/providers/netease', 'DELETE', {});
  assert.equal((await a.request(`/tracks/${ids[0]}/lyrics`)).status, 409);
});
