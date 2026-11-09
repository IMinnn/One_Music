import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('歌单导出、跨账号导入、同名合并和重复导入去重', async () => {
  const f = await fixture();
  try {
    const a = f.client(), b = f.client();
    await a.register('exporter'); await b.register('importer');
    const track = (await a.import()).data.track;
    const p = (await a.request('/playlists', 'POST', { name: '通勤', description: '原介绍', color: 'blue' })).data.playlist;
    await a.request(`/playlists/${p.id}/tracks`, 'PUT', { version: p.version, trackIds: [track.id] });
    const userId = f.app.db.prepare('SELECT id FROM users WHERE username=?').get('exporter').id;
    f.app.db.prepare('INSERT INTO favorites VALUES(?,?,?)').run(userId, track.id, Date.now());
    f.app.db.prepare("INSERT INTO playlists(id,user_id,name,source,created_at,updated_at) VALUES('remote',?,'平台歌单','qq',1,1)").run(userId);
    const exported = await a.request('/playlists/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.data.playlists.length, 1);
    assert.equal(exported.data.favorites.length, 1);
    assert.equal(JSON.stringify(exported.data).includes('file_name'), false);
    const sameAccount = await a.request('/playlists/import', 'POST', exported.data);
    assert.deepEqual(sameAccount.data, { created: 0, merged: 1, added: 0, skipped: 2 });
    const target = (await b.request('/playlists', 'POST', { name: '通勤', description: '保留介绍' })).data.playlist;
    const data = structuredClone(exported.data);
    data.playlists[0].tracks.push(data.playlists[0].tracks[0]);
    data.playlists.push({ name: '空歌单', tracks: [] });
    const imported = await b.request('/playlists/import', 'POST', data);
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.data, { created: 1, merged: 1, added: 2, skipped: 1 });
    const again = await b.request('/playlists/import', 'POST', data);
    assert.equal(again.data.added, 0); assert.equal(again.data.created, 0);
    const library = (await b.request('/library')).data;
    assert.equal(library.tracks.length, 1);
    assert.equal(library.tracks[0].canPlay, false);
    assert.notEqual(library.tracks[0].id, track.id);
    assert.equal(library.favorites.length, 1);
    const merged = library.playlists.find(p => p.id === target.id);
    assert.equal(merged.description, '保留介绍');
    assert.equal(merged.trackIds.length, 1);
    assert.ok(merged.version > target.version);
    const anonymous = f.client();
    assert.equal((await anonymous.request('/playlists/export')).status, 401);
  } finally { await f.close(); }
});

test('无效文件不落库、容量冲突整批回滚、平台歌曲按来源标识去重', async () => {
  const f = await fixture();
  try {
    const c = f.client(); await c.register();
    const song = { provider: 'qq', providerId: 'abc', title: '测试', artist: '艺人', album: '', duration: 10 };
    const data = { format: 'harmony-playlists', version: 1, favorites: [song, song],
      playlists: [{ name: '测试', tracks: [song, song] }, { name: '测试', tracks: [song] }] };
    assert.equal((await c.request('/playlists/import', 'POST', { ...data, version: 2 })).status, 400);
    const bad = structuredClone(data); bad.playlists[1].tracks[0].provider = 'invalid';
    assert.equal((await c.request('/playlists/import', 'POST', bad)).status, 400);
    assert.equal((await c.request('/library')).data.tracks.length, 0);
    assert.equal((await c.request('/playlists/import', 'POST', data)).status, 200);
    const lib = (await c.request('/library')).data;
    assert.equal(lib.playlists.length, 1); assert.equal(lib.playlists[0].trackIds.length, 1);
    assert.equal(lib.favorites.length, 1);
    const large = structuredClone(data);
    large.playlists = [{ name: '先新建', tracks: [] }, { name: '超限', tracks: Array.from({ length: 5001 }, () => song) }];
    assert.equal((await c.request('/playlists/import', 'POST', large)).status, 400);
    assert.equal((await c.request('/library')).data.playlists.length, 1);
    // Fail after a valid first playlist was inserted, then verify the transaction rolls it back.
    const userId = f.app.db.prepare('SELECT id FROM users WHERE username=?').get('listener').id;
    for (let i = 0; i < 498; i++) f.app.db.prepare('INSERT INTO playlists(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(`limit-${i}`, userId, `列表${i}`, 1, 1);
    const overflow = { ...data, playlists: [{ name: '最后一张', tracks: [] }, { name: '超过限制', tracks: [] }] };
    assert.equal((await c.request('/playlists/import', 'POST', overflow)).status, 400);
    assert.equal((await c.request('/library')).data.playlists.length, 499);
  } finally { await f.close(); }
});
