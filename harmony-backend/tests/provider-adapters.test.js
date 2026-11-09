import test from 'node:test';
import assert from 'node:assert/strict';
import { QQProvider } from '../src/providers/qq.js';
import { NeteaseProvider } from '../src/providers/netease.js';
import { cookiesForUrl, cookieValue } from '../src/providers/http.js';

test('QQ 授权保留目标域凭据，不被父域清理 Cookie 覆盖', () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'p_skey=valid-test-token; Domain=graph.qq.com; Path=/; Secure; HttpOnly');
  headers.append('Set-Cookie', 'p_skey=; Domain=qq.com; Path=/; Max-Age=0');
  headers.append('Set-Cookie', 'p_uin=test-user; Domain=graph.qq.com; Path=/; Secure');
  headers.append('Set-Cookie', 'wrong=test; Domain=unrelated.example; Path=/');
  headers.append('Set-Cookie', 'hostonly=test; Path=/');
  headers.append('Set-Cookie', 'limited=test; Domain=graph.qq.com; Path=/other');
  const cookie = cookiesForUrl(headers, 'https://ssl.ptlogin2.graph.qq.com/check_sig', 'https://graph.qq.com/oauth2.0/authorize');
  assert.equal(cookieValue(cookie, 'p_skey'), 'valid-test-token');
  assert.equal(cookieValue(cookie, 'p_uin'), 'test-user');
  for (const key of ['wrong', 'hostonly', 'limited']) assert.equal(cookieValue(cookie, key), '');
  headers.append('Set-Cookie', 'p_skey=; Domain=graph.qq.com; Path=/; Max-Age=0');
  assert.equal(cookieValue(cookiesForUrl(headers, 'https://ssl.ptlogin2.graph.qq.com/check_sig', 'https://graph.qq.com/oauth2.0/authorize'), 'p_skey'), '');
});

test('QQ 歌单合并自建、收藏与喜欢并完成分页', async () => {
  const p = new QQProvider(), calls = [];
  p.web = async (url, params) => {
    calls.push([url, params.sin]);
    if (url.includes('created_diss')) return { disslist: Array.from({ length: params.sin ? 1 : 200 }, (_, i) => ({ tid: String(params.sin + i + 1), diss_name: '歌单', song_cnt: 3 })), total: 201 };
    if (url.includes('homepage')) return { mymusic: [{ id: '999', num0: 9 }] };
    return { cdlist: [{ dissid: '1', dissname: '重复' }, { dissid: '888', dissname: '收藏歌单', songnum: 8 }], totaldiss: 2 };
  };
  const lists = await p.playlists({ musicid: '123', musickey: 'test' });
  assert.equal(lists.length, 203);
  assert.equal(lists.find(x => x.id === '999').name, '我喜欢');
  assert.equal(lists.find(x => x.id === '888').trackCount, 8);
  assert.deepEqual(calls.slice(0, 2).map(x => x[1]), [0, 200]);
});

test('平台不完整响应不能被当成空歌单覆盖缓存', async () => {
  const qq = new QQProvider(); qq.web = async () => ({});
  await assert.rejects(qq.playlists({}), /响应不完整/);
  qq.web = async () => ({ disslist: [], total: 201 });
  await assert.rejects(qq.playlists({}), /未完整返回/);
  const ne = new NeteaseProvider(); ne.call = async () => ({ body: { code: 200 } });
  await assert.rejects(ne.playlists({}, { id: '1' }), /完整歌单/);
  await assert.rejects(ne.playlistTracks({}, '1'), /完整歌曲/);
});

test('QQ 的非歌单系统栏目不阻断有效自建和收藏歌单', async () => {
  const qq = new QQProvider();
  qq.web = async url => url.includes('created_diss') ? {
    totoal: 3, disslist: [{ tid: 123, dirid: 201, diss_name: '我喜欢', song_cnt: 365 }, { tid: 0, dirid: 205, song_cnt: 2 }, { tid: 0, dirid: 206, song_cnt: 0 }],
  } : { totaldiss: 1, cdlist: [{ dissid: 456, dissname: '收藏歌单', songnum: 20 }] };
  const lists = await qq.playlists({});
  assert.deepEqual(lists.map(p => p.id), ['123', '456']);
  assert.equal(lists[0].trackCount, 365);
  qq.web = async () => ({ disslist: [{ tid: 0, dirid: 12 }], totoal: 1 });
  await assert.rejects(qq.playlists({}), /不完整的歌单/);
});

test('QQ 昵称读取 info.nick；歌单歌曲使用数值 ID 并逐页读取', async () => {
  const qq = new QQProvider(), offsets = [];
  qq.music = async (_module, method, params) => {
    if (method === 'GetLoginUserInfo') return { info: { nick: '测试昵称' } };
    assert.equal(params.disstid, 123456789);
    offsets.push(params.song_begin);
    return { total_song_num: 205, songlist: Array.from({ length: params.song_begin < 200 ? 100 : 5 }, (_, i) => ({ mid: `mid${params.song_begin + i}`, name: '曲目', singer: [{ name: '艺人' }] })) };
  };
  assert.equal((await qq.profile({ musicid: '123' })).nickname, '测试昵称');
  assert.equal((await qq.playlistTracks({}, '123456789')).length, 205);
  assert.deepEqual(offsets, [0, 100, 200]);
  await assert.rejects(qq.playlistTracks({}, 'invalid'), /标识无效/);
});

test('QQ 搜索过滤明确报错；允许平台返回的完整 M4A 音频', async () => {
  const qq = new QQProvider(); qq.music = async () => ({ meta: { is_filter: -9 }, body: { song: { list: [] } } }); qq.web = async () => { throw new Error('暂未开放'); };
  await assert.rejects(qq.search({}, '搜索'), /暂未开放/);
  qq.music = async () => ({ midurlinfo: [{ purl: 'C400song.m4a?vkey=test' }], sip: ['https://dl.stream.qqmusic.qq.com/'] });
  assert.equal(new URL(await qq.playback({ musicid: '123' }, 'mid')).pathname, '/C400song.m4a');
  qq.music = async () => ({ midurlinfo: [{ result: 104003, purl: '' }] });
  await assert.rejects(qq.playback({ musicid: '123' }, 'mid'), error => error.status === 403 && error.code === 'PROVIDER_PLAYBACK_RESTRICTED');
});


test('QQ 搜索在桌面接口过滤时回退并兼容旧字段，空结果和失效会话不重试', async () => {
  const qq = new QQProvider(); let attempts = 0;
  const credential = { musicid: '123', musickey: 'test' };
  qq.music = async () => { attempts++; return { meta: { is_filter: -9 } }; };
  qq.web = async (_url, params) => {
    assert.equal(params.w, '晴天');
    return { song: { list: [{ songmid: 'song1', songname: '晴天', singer: [{ name: '艺人' }], albummid: 'album1' }] } };
  };
  assert.equal((await qq.search(credential, '晴天')).tracks[0].title, '晴天');
  assert.equal(attempts, 2);
  qq.music = async () => ({ body: { song: { list: [] } } });
  qq.web = async () => { throw new Error('不应请求备用接口'); };
  assert.deepEqual(await qq.search(credential, '无结果'), { tracks: [], hasMore: false });
  qq.music = async () => { const error = new Error('登录过期'); error.code = 'PROVIDER_AUTH_EXPIRED'; throw error; };
  await assert.rejects(qq.search(credential, '晴天'), error => error.code === 'PROVIDER_AUTH_EXPIRED');
});

test('QQ 和网易云搜索传递后续页并依据平台总数结束', async () => {
 const qq = new QQProvider();
 qq.web = async (_url, params, credential) => {
  assert.deepEqual(credential, {});
  assert.equal(params.p, 2); assert.equal(params.n, 30);
  return { song: { totalnum: 31, list: [{ mid: 'qq-last', name: '末首' }] } };
 };
 const result = await qq.search({}, '歌', 2); assert.equal(result.hasMore, false); assert.equal(result.tracks.length, 1);
 const netease = new NeteaseProvider();
 netease.call = async (_route, params) => {
  assert.equal(params.offset, 30); assert.equal(params.limit, 30);
  return { body: { result: { songCount: 31, songs: [{ id: 31, name: '末首', ar: [], al: {} }] } } };
 };
 assert.equal((await netease.search({}, '歌', 2)).hasMore, false);
});

test('歌曲元数据来自明确的发表日期与播放量字段，不用热度或评论数替代', () => {
 const qq = new QQProvider(), netease = new NeteaseProvider();
 const q = qq.normalize({ mid: 'mid', time_public: '2024-02-29', playCount: '123456', album: { name: '专辑' } });
 assert.equal(q.releaseDate, '2024-02-29'); assert.equal(q.playCount, 123456); assert.equal(q.album, '专辑');
 const n = netease.normalize({ id: 1, publishTime: Date.UTC(2020, 0, 2), playCount: 0 });
 assert.equal(n.releaseDate, '2020-01-02'); assert.equal(n.playCount, 0);
 assert.equal(qq.normalize({ mid: 'mid', time_public: '2024-02-30', hot: 99, commentCount: 100 }).releaseDate, '');
 assert.equal(netease.normalize({ id: 1, pop: 100, playCount: -1 }).playCount, null);
 assert.equal(netease.normalize({ id: 1, pop: 100, album: { playCount: 9999 } }).playCount, null);
});


test('单曲收藏总量只使用明确计数，保留零且不混淆个人喜欢状态和专辑收藏', () => {
 const qq = new QQProvider(), ne = new NeteaseProvider();
 assert.equal(qq.normalize({mid:'m',collectCount:'12345'}).favoriteCount,12345);
 assert.equal(ne.normalize({id:1,favoriteCount:0}).favoriteCount,0);
 assert.equal(qq.normalize({mid:'m',collect_count:-1}).favoriteCount,null);
 assert.equal(ne.normalize({id:1,favoriteCount:true,liked:true,pop:100,album:{collectCount:99}}).favoriteCount,null);
 assert.equal(ne.normalize({id:1,subscribedCount:99}).favoriteCount,null);
});
