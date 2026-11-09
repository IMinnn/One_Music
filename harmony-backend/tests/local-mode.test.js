import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

function adapter() {
  return {
    startQr: async () => ({ secret: {}, image: '', hint: '' }),
    pollQr: async () => ({ status: 'authorized', credential: { cookie: 'private-test-key' }, profile: { id: 'platform-user', nickname: '本机平台账号' } }),
    profile: async () => ({ id: 'platform-user', nickname: '本机平台账号' }),
    playlists: async () => [{ id: 'remote', name: '本机平台歌单', trackCount: 2 }],
    firstTrack: async () => ({ id: 'first', coverUrl: 'https://y.gtimg.cn/first.jpg' }),
    playlistTracks: async () => [
      { id: 'first', title: '第一首', coverUrl: 'https://y.gtimg.cn/first.jpg' },
      { id: 'second', title: '第二首', coverUrl: 'https://y.gtimg.cn/second.jpg' },
    ],
  };
}
test('本地模式无需注册即可绑定平台，重启保留且与账号资料隔离', async t => {
  const key = 'test-device-secret', f = await fixture({ localGuestKey: key, providers: { qq: adapter(), netease: adapter() } });
  t.after(() => f.close()); const guest = f.client(), account = f.client();
  assert.equal((await guest.request('/auth/guest', 'POST', {})).status, 403);
  const opened = await guest.request('/auth/guest', 'POST', {}, { 'X-Harmony-Local-Key': key });
  assert.equal(opened.status, 200); assert.equal(opened.data.user.local, true); const id = opened.data.user.id;
  const qr = (await guest.request('/providers/qq/qr', 'POST', {})).data;
  assert.equal((await guest.request(`/providers/qq/qr/${qr.id}`, 'POST', {})).data.status, 'authorized');
  await guest.request('/providers/qq/sync', 'POST', {});
  const library = (await guest.request('/library')).data;
  assert.equal(library.playlists.length, 1);
  await account.register(); assert.equal((await account.request('/library')).data.playlists.length, 0);
  assert.equal((await guest.request('/auth/password', 'POST', { currentPassword: 'anything', newPassword: 'test-password-123' })).status, 403);
  await guest.request('/auth/logout', 'POST', {}); await f.restart();
  const restored = await guest.request('/auth/guest', 'POST', {}, { 'X-Harmony-Local-Key': key });
  assert.equal(restored.data.user.id, id);
  assert.equal((await guest.request('/library')).data.providers.find(p => p.id === 'qq').connected, true);
  assert.equal((await guest.request('/library')).data.playlists[0].id, library.playlists[0].id);
  assert.ok(!JSON.stringify((await guest.request('/library')).data).includes('private-test-key'));
});

test('远程/普通服务不开放本地入口；首曲封面预览和曲序变化', async t => {
  const f = await fixture({ providers: { qq: adapter(), netease: adapter() } }); t.after(() => f.close());
  const a = f.client(), b = f.client();
  assert.equal((await a.request('/auth/guest', 'POST', {}, { 'X-Harmony-Local-Key': 'anything' })).status, 403);
  await a.register(); await b.register('another');
  const qr = (await a.request('/providers/qq/qr', 'POST', {})).data; await a.request(`/providers/qq/qr/${qr.id}`, 'POST', {}); await a.request('/providers/qq/sync', 'POST', {});
  const platform = (await a.request('/library')).data.playlists[0];
  const preview = await fetch(f.url + `/api/platform-playlists/${platform.id}/cover`, { headers: { Cookie: a.cookie }, redirect: 'manual' });
  assert.equal(preview.status, 302); assert.equal(preview.headers.get('location'), 'https://y.gtimg.cn/first.jpg');
  assert.equal((await a.request('/library')).data.tracks.length, 0);
  assert.equal((await b.request(`/platform-playlists/${platform.id}/cover`)).status, 404);
  await a.request(`/platform-playlists/${platform.id}/refresh`, 'POST', {});
  const loaded = (await a.request('/library')).data.playlists[0];
  assert.equal(loaded.coverUrl, 'https://y.gtimg.cn/first.jpg');
  const own = (await a.request('/playlists', 'POST', { name: '自建首曲封面' })).data.playlist;
  await a.request(`/playlists/${own.id}/tracks`, 'PUT', { version: own.version, trackIds: loaded.trackIds });
  let updated = (await a.request('/library')).data.playlists.find(p => p.id === own.id);
  assert.equal(updated.coverUrl, 'https://y.gtimg.cn/first.jpg');
  await a.request(`/playlists/${own.id}/tracks`, 'PUT', { version: updated.version, trackIds: [...loaded.trackIds].reverse() });
  updated = (await a.request('/library')).data.playlists.find(p => p.id === own.id);
  assert.equal(updated.coverUrl, 'https://y.gtimg.cn/second.jpg');
});


test('本地登录仅续播指定歌曲，禁止读其他音乐、下载和写旧收藏，退出撤销', async t => {
  const f = await fixture({ localGuestKey: 'continuation-key' }); t.after(() => f.close());
  const account = f.client(), guest = f.client();
  await account.register('continuation');
  await guest.request('/auth/guest', 'POST', {}, { 'X-Harmony-Local-Key': 'continuation-key' });
  const first = (await guest.import('first.wav')).data.track.id;
  const second = (await guest.import('second.wav')).data.track.id;
  const login = await guest.request('/auth/login', 'POST', { username: 'continuation', password: 'correct horse battery', continueTrackId: first });
  assert.equal(login.status, 200);
  assert.equal((await guest.request('/library')).data.tracks.length, 0);
  assert.equal((await guest.request(`/tracks/${first}/audio`, 'GET', undefined, { Range: 'bytes=0-43' })).status, 206);
  assert.equal((await guest.request(`/tracks/${second}/audio`)).status, 404);
  assert.equal((await guest.request(`/tracks/${first}/audio?download=1`)).status, 404);
  assert.equal((await guest.request(`/tracks/${first}/favorite`, 'PUT', { favorite: true })).status, 404);
  assert.equal((await account.request(`/tracks/${first}/audio`)).status, 404);
  await guest.request('/auth/logout', 'POST', {});
  await guest.login('continuation');
  assert.equal((await guest.request(`/tracks/${first}/audio`)).status, 404);
});
