import { releaseDate, statisticCount as normalizeCount } from './metadata.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../security.js';
import { request, readJson, cookiesFrom, cookiesForUrl, cookieValue, authError } from './http.js';

export function hash33(value, seed = 0) { let hash = seed; for (const character of value) hash = ((hash << 5) + hash + character.charCodeAt(0)) & 0x7fffffff; return hash; }
const endpoint = (base, params) => base + '?' + new URLSearchParams(params);
const redirectUri = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/';
export class QQProvider {
  async music(module, method, param, credential = {}, comm = {}) {
    const cookie = credential.musickey ? `uin=${credential.musicid}; qqmusic_key=${credential.musickey}; qm_keyst=${credential.musickey}; tmeLoginType=2` : '';
    const response = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST',
      headers: { Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comm: { cv: 13020508, v: 13020508, ct: '11', tmeAppID: 'qqmusic', format: 'json', inCharset: 'utf-8', outCharset: 'utf-8',
        uid: credential.musicid || '0', ...(credential.musickey ? { qq: credential.musicid, authst: credential.musickey, tmeLoginType: 2, loginUin: credential.musicid } : {}), ...comm },
        req: { module, method, param } }) });
    const body = await readJson(response), result = body.req;
    const code = result?.code ?? body.code;
    if ([1000, 104401, 104400].includes(code)) throw authError();
    if (body.code !== 0 || !result || result.code !== 0) throw new ApiError(502, `QQ 音乐请求未完成（${Number(code) || '未知'}），请稍后重试`, 'PROVIDER_UNAVAILABLE');
    return result.data;
  }
  async startQr() {
    const response = await request(endpoint('https://ssl.ptlogin2.qq.com/ptqrshow', { appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4', t: String(Math.random()), daid: '383', pt_3rd_aid: '100497308' }), { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } });
    const qrsig = cookieValue(cookiesFrom(response.headers), 'qrsig');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!qrsig || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ApiError(502, 'QQ 未返回有效二维码，请稍后重试');
    return { secret: { qrsig }, image: 'data:image/png;base64,' + bytes.toString('base64'), hint: '使用手机 QQ 的扫一扫，并在手机上确认登录 QQ 音乐' };
  }
  async pollQr(secret) {
    const response = await request(endpoint('https://ssl.ptlogin2.qq.com/ptqrlogin', {
      u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: String(hash33(secret.qrsig)), ptredirect: '0', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
      action: '0-0-' + Date.now(), js_ver: '20102616', js_type: '1', pt_uistyle: '40', aid: '716027609', daid: '383', pt_3rd_aid: '100497308', has_onekey: '1',
    }), { headers: { Cookie: `qrsig=${secret.qrsig}`, Referer: 'https://xui.ptlogin2.qq.com/' } });
    const text = await response.text();
    const match = /^\s*ptuiCB\((.*)\);?\s*$/s.exec(text);
    const args = match ? [...match[1].matchAll(/'((?:\\.|[^'])*)'/g)].map(x => x[1]) : [];
    if (!args.length) throw new ApiError(502, 'QQ 登录响应无法识别，请刷新二维码');
    if (args[0] === '66') return { status: 'waiting' };
    if (args[0] === '67') return { status: 'scanned' };
    if (['65', '68'].includes(args[0])) return { status: 'expired' };
    if (args[0] !== '0') throw new ApiError(502, `QQ 未完成扫码授权（${Number(args[0]) || '未知'}），请刷新二维码重试`);
    let jump; try { jump = new URL(args[2]); } catch { throw new ApiError(502, 'QQ 授权地址无效'); }
    const uin = jump.searchParams.get('uin'), sig = jump.searchParams.get('ptsigx');
    if (!uin || !sig) throw new ApiError(502, 'QQ 授权信息不完整，请重新扫码');
    const checked = await request(endpoint('https://ssl.ptlogin2.graph.qq.com/check_sig', {
      uin, ptsigx: sig, pttype: '1', service: 'ptqrlogin', nodirect: '0', s_url: 'https://graph.qq.com/oauth2.0/login_jump',
      ptlang: '2052', ptredirect: '100', aid: '716027609', daid: '383', j_later: '0', low_login_hour: '0', regmaster: '0', pt_login_type: '3', pt_aid: '0', pt_aaid: '16', pt_light: '0', pt_3rd_aid: '100497308',
    }), { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } });
    const cookie = cookiesForUrl(checked.headers, 'https://ssl.ptlogin2.graph.qq.com/check_sig', 'https://graph.qq.com/oauth2.0/authorize');
    const skey = cookieValue(cookie, 'p_skey');
    await checked.body?.cancel();
    if (!skey) throw new ApiError(502, 'QQ 未完成授权凭据交换，请重新扫码');
    const authorized = await request('https://graph.qq.com/oauth2.0/authorize', { method: 'POST',
      headers: { Cookie: cookie, Referer: 'https://xui.ptlogin2.qq.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ response_type: 'code', client_id: '100497308', redirect_uri: redirectUri, scope: 'get_user_info,get_app_friends',
        state: 'harmony', switch: '', from_ptlogin: '1', src: '1', update_auth: '1', openapi: '1010_1030', g_tk: String(hash33(skey, 5381)), auth_time: String(Date.now()), ui: randomUUID() }).toString() });
    const location = authorized.headers.get('location'); await authorized.body?.cancel();
    let code; try { code = new URL(location).searchParams.get('code'); } catch {}
    if (!code) throw new ApiError(502, 'QQ 音乐未返回授权码，请在手机上确认后重试');
    const result = await this.music('QQConnectLogin.LoginServer', 'QQLogin', { code }, {}, { tmeLoginType: 2 });
    const credential = { musicid: String(result.str_musicid || result.musicid || ''), musickey: result.musickey || result.music_key || '' };
    if (!credential.musicid || !credential.musickey) throw new ApiError(502, 'QQ 音乐登录未完成，请重新扫码');
    return { status: 'authorized', credential, profile: await this.profile(credential) };
  }
  async profile(credential) {
    const result = await this.music('music.UserInfo.userInfoServer', 'GetLoginUserInfo', {}, credential);
    return { id: credential.musicid, nickname: result.info?.nick || result.nick || result.nickname || result.name || result.userInfo?.nick || 'QQ 音乐用户' };
  }
  normalize(t) {
    return { id: String(t.mid || t.songmid || ''), title: t.name || t.songname || '未命名歌曲', artist: (t.singer || []).map(a => a.name).join(' / '),
      album: t.album?.name || t.albumname || '', duration: t.interval || 0,
      releaseDate: releaseDate(t.time_public || t.pubtime || t.publishTime), playCount: normalizeCount(t.playCount ?? t.play_count),
      favoriteCount: normalizeCount(t.favoriteCount ?? t.collectCount ?? t.collect_count),
      coverUrl: (t.album?.mid || t.albummid) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(t.album?.mid || t.albummid)}.jpg` : '' };
  }
  async playlists(credential) {
    const map = new Map();
    const add = p => {
      const id = p.dissid || p.tid || p.disstid || p.id;
      // QQ includes system asset folders 205/206 with tid=0. They are not playlists.
      if ((!id || String(id) === '0') && [205, 206].includes(Number(p.dirid))) return;
      if (!/^\d+$/.test(String(id)) || Number(id) <= 0) throw new ApiError(502, 'QQ 音乐返回了不完整的歌单，请稍后重试');
      map.set(String(id), { id: String(id), name: p.diss_name || p.title || p.dissname || p.name || 'QQ 音乐歌单', description: p.desc || '',
        trackCount: p.song_cnt ?? p.songnum ?? p.song_count ?? p.total_song_num ?? p.num0 ?? 0 });
    };
    const collectPages = async (url, field, params, totalField) => {
      for (let offset = 0; offset < 2000; offset += 200) {
        const data = await this.web(url, { ...params, sin: offset, size: 200, ein: offset + 199 }, credential);
        const items = data[field];
        if (!Array.isArray(items)) throw new ApiError(502, 'QQ 音乐歌单响应不完整，请稍后重试');
        const before = map.size;
        for (const p of items) { if (Number(p.dirid) === 201) liked = true; add(p); }
        const total = data[totalField] ?? (field === 'disslist' ? data.totoal : undefined);
        if (total != null && Number(total) <= offset + items.length) return;
        if (items.length < 200) {
          if (total != null && Number(total) > offset + items.length) throw new ApiError(502, 'QQ 音乐歌单未完整返回，请稍后重试');
          return;
        }
        if (before === map.size) throw new ApiError(502, 'QQ 音乐分页读取失败，请稍后重试');
      }
      throw new ApiError(422, 'QQ 音乐歌单超过单次同步上限');
    };
    let liked = false;
    await collectPages('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', 'disslist', { hostuin: credential.musicid, hostUin: 0 }, 'total');
    if (!liked) {
      const home = await this.web('https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg', {
        cid: 205360838, ct: 20, cv: 4747474, userid: credential.musicid, reqfrom: 1, reqtype: 0, hostUin: 0,
      }, credential);
      const favorite = home.mymusic?.[0];
      if (favorite?.id && String(favorite.id) !== '0') add({ ...favorite, name: '我喜欢' });
    }
    await collectPages('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', 'cdlist', {
      ct: 20, cid: 205360956, userid: credential.musicid, reqtype: 3,
    }, 'totaldiss');
    return [...map.values()];
  }
  async web(url, params, credential) {
    const { musicid = '0', musickey = '' } = credential;
    const headers = { Referer: 'https://y.qq.com/portal/profile.html' };
    if (musickey) headers.Cookie = `uin=${musicid}; qqmusic_key=${musickey}; qm_keyst=${musickey}; tmeLoginType=2`;
    const response = await request(endpoint(url, { format: 'json', inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
      platform: 'yqq.json', needNewCode: 0, loginUin: musicid, g_tk: hash33(musickey, 5381), ...params }), {
      headers,
    });
    const body = await readJson(response);
    if ([1000, 1001, 104401, 104400].includes(body.code)) throw authError();
    if (body.code !== 0 || !body.data) throw new ApiError(502, `QQ 音乐请求未完成（${Number(body.code) || '未知'}），请稍后重试`);
    return body.data;
  }
  async firstTrack(credential, id) {
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new ApiError(400, 'QQ 音乐歌单标识无效');
    const data = await this.music('music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: Number(id), dirid: 0, tag: true, song_begin: 0, song_num: 1, userinfo: true, orderlist: true, onlysonglist: false }, credential);
    const p = data.cdlist?.[0] || data;
    const first = (p.songlist || p.songList || data.songlist)?.[0];
    return first ? this.normalize(first) : null;
  }
  async playlistTracks(credential, id) {
    const numericId = Number(id);
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(numericId) || numericId <= 0) throw new ApiError(400, 'QQ 音乐歌单标识无效');
    const result = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const data = await this.music('music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: numericId, dirid: 0, tag: true, song_begin: offset, song_num: 100, userinfo: true, orderlist: true, onlysonglist: false }, credential);
      const p = data.cdlist?.[0] || data;
      const items = p.songlist || p.songList || data.songlist;
      if (!Array.isArray(items)) throw new ApiError(502, 'QQ 音乐未返回完整歌曲列表');
      result.push(...items.map(t => this.normalize(t)).filter(t => t.id));
      const total = p.total_song_num ?? p.songnum ?? data.total_song_num;
      if (!items.length || items.length < 100 || (total !== undefined && result.length >= total)) return result;
    }
    throw new ApiError(422, '歌单超过 5000 首，暂不能完整同步');
  }
  async search(credential, query, page = 1) {
    const normalize = data => {
      if (Number(data.meta?.is_filter) < 0) throw new ApiError(502, 'QQ 音乐暂未开放此次搜索，请稍后重试');
      const items = data.body?.song?.list || data.song?.list;
      if (!Array.isArray(items)) throw new ApiError(502, 'QQ 音乐未返回有效搜索结果');
      const total = Number(data.body?.song?.sum ?? data.body?.song?.totalnum ?? data.song?.totalnum);
      return { tracks: items.map(t => this.normalize(t)).filter(t => t.id), hasMore: items.length > 0 && (Number.isFinite(total) ? page * 30 < total : items.length >= 30) };
    };
    const params = { query, pageNum: page, numPerPage: 30, search_type: 0 };
    const webSearch = () => this.web('https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp', { w: query, p: page, n: 30, catZhida: 1, remoteplace: 'txt.yqq.song', aggr: 1, cr: 1, lossless: 0 }, credential);
    const desktopSearches = [
      () => this.music('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', params, credential),
      () => this.music('music.search.SearchCgiService', 'DoSearchForQQMusicDesktop', params, credential, { ct: 24, cv: 0 }),
    ];
    // Prefer the web gateway for guests. A valid empty page needs no fallback.
    const searches = credential.musickey ? [...desktopSearches, webSearch] : [webSearch, ...desktopSearches];
    let lastError;
    for (const run of searches) {
      try { return normalize(await run()); }
      catch (error) {
        if (credential.musickey && error.code === 'PROVIDER_AUTH_EXPIRED') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  async lyrics(credential, id) {
    const response = await request(endpoint('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', { songmid: id, format: 'json', nobase64: '1' }), { headers: { Referer: 'https://y.qq.com/' } });
    const body = await readJson(response);
    if (body.code !== 0) throw new ApiError(502, 'QQ 音乐歌词暂时不可用');
    return { lyric: body.lyric || '', translation: body.trans || '' };
  }
  async playback(credential, id) {
    const data = await this.music('music.vkey.GetVkey', 'UrlGetVkey', { guid: randomUUID().replaceAll('-', ''), songmid: [id], songtype: [0], uin: credential.musicid, loginflag: 1, platform: '20' }, credential, { ct: 19 });
    const info = data.midurlinfo?.[0];
    if (!info?.purl || info.freeTrialInfo) throw new ApiError(403, 'QQ 音乐未提供此歌曲的完整播放权限，可能需要会员、购买或受到版权限制，请更换歌曲', 'PROVIDER_PLAYBACK_RESTRICTED');
    return new URL(info.purl, data.sip?.find(s => s.startsWith('https://')) || data.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/').href;
  }
}
