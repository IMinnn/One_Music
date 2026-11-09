import { releaseDate, statisticCount as normalizeCount } from './metadata.js';
import { createCipheriv, publicEncrypt, constants, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { ApiError } from '../security.js';
import { request, readJson, cookiesFrom, cookieValue, authError } from './http.js';

// Web protocol constants, documented by NeteaseCloudMusicApiEnhanced (MIT).
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
function aes(text, key) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from('0102030405060708'));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}
export function weapi(data) {
  const secret = randomBytes(12).toString('hex').slice(0, 16);
  const buffer = Buffer.alloc(128); Buffer.from(secret.split('').reverse().join('')).copy(buffer, 112);
  return new URLSearchParams({ params: aes(aes(JSON.stringify(data), '0CoJUm6Qyw8W8jud'), secret),
    encSecKey: publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, buffer).toString('hex') });
}
export class NeteaseProvider {
  async call(path, data = {}, credential = {}) {
    const cookie = credential.cookie || 'os=pc; appver=3.0.18';
    const response = await request('https://music.163.com/weapi/' + path, { method: 'POST',
      headers: { Referer: 'https://music.163.com/', Origin: 'https://music.163.com', Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: weapi({ ...data, csrf_token: cookieValue(cookie, '__csrf') }).toString() });
    const body = await readJson(response);
    if (body.code === 301) throw authError();
    if (![200, 800, 801, 802, 803].includes(body.code)) throw new ApiError(502, `网易云音乐暂时无法完成请求（${Number(body.code) || '未知'}）`, 'PROVIDER_UNAVAILABLE');
    return { body, cookie: cookiesFrom(response.headers, cookie) };
  }
  async startQr() {
    const { body, cookie } = await this.call('login/qrcode/unikey', { type: 3 });
    const key = body.unikey || body.data?.unikey;
    if (!key) throw new ApiError(502, '网易云音乐未返回二维码，请重试');
    return { secret: { key, cookie }, image: await QRCode.toDataURL(`https://music.163.com/login?codekey=${encodeURIComponent(key)}`, { width: 256, margin: 2 }),
      hint: '使用手机网易云音乐 App 扫一扫，并在手机上确认登录' };
  }
  async pollQr(secret) {
    const { body, cookie } = await this.call('login/qrcode/client/login', { key: secret.key, type: 3 }, secret);
    if (body.code === 800) return { status: 'expired' };
    if (body.code === 802) return { status: 'scanned' };
    if (body.code === 801) return { status: 'waiting' };
    if (body.code !== 803) throw new ApiError(502, `网易云音乐返回了无法识别的扫码状态（${body.code}），请刷新二维码`);
    if (!cookieValue(cookie, 'MUSIC_U')) throw new ApiError(502, '网易云登录凭据未返回，请刷新二维码');
    const credential = { cookie }, profile = await this.profile(credential);
    return { status: 'authorized', credential, profile };
  }
  async profile(credential) {
    const { body } = await this.call('nuser/account/get', {}, credential);
    if (!body.profile?.userId || !body.account) throw authError();
    return { id: String(body.profile.userId), nickname: body.profile.nickname || '网易云用户' };
  }
  async playlists(credential, profile) {
    const result = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const { body } = await this.call('user/playlist', { uid: profile.id, offset, limit: 100, includeVideo: false }, credential);
      const items = body.playlist;
      if (!Array.isArray(items)) throw new ApiError(502, '网易云音乐未返回完整歌单列表');
      result.push(...items.map(p => ({ id: String(p.id), name: p.name, description: p.description || '', trackCount: p.trackCount || 0 })));
      if (!body.more || !items.length) return result;
    }
    throw new ApiError(422, '网易云歌单超过单次同步上限，请减少歌单后重试');
  }
  normalize(song) {
    return { id: String(song.id), title: song.name, artist: (song.ar || song.artists || []).map(a => a.name).join(' / '),
      album: (song.al || song.album)?.name || '', duration: (song.dt || song.duration || 0) / 1000,
      releaseDate: releaseDate(song.publishTime), playCount: normalizeCount(song.playCount ?? song.play_count),
      favoriteCount: normalizeCount(song.favoriteCount ?? song.collectCount ?? song.collect_count),
      coverUrl: (song.al || song.album)?.picUrl || '' };
  }
  async firstTrack(credential, id) {
    const { body } = await this.call('v6/playlist/detail', { id, n: 1, s: 0 }, credential);
    const first = body.playlist?.tracks?.[0];
    if (first) return this.normalize(first);
    const firstId = body.playlist?.trackIds?.[0]?.id;
    if (!firstId) return null;
    const { body: details } = await this.call('v3/song/detail', { c: JSON.stringify([{ id: firstId }]) }, credential);
    return details.songs?.[0] ? this.normalize(details.songs[0]) : null;
  }
  async playlistTracks(credential, id) {
    const { body } = await this.call('v6/playlist/detail', { id, n: 5000, s: 0 }, credential);
    if (!Array.isArray(body.playlist?.trackIds)) throw new ApiError(502, '网易云音乐未返回完整歌曲列表');
    const ids = body.playlist.trackIds.map(t => t.id);
    if (ids.length > 5000) throw new ApiError(422, '歌单超过 5000 首，暂不能完整同步');
    const tracks = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { body: details } = await this.call('v3/song/detail', { c: JSON.stringify(ids.slice(i, i + 200).map(id => ({ id }))) }, credential);
      tracks.push(...(details.songs || []).map(t => this.normalize(t)));
    }
    return tracks;
  }
  async search(credential, query, page = 1) {
    const { body } = await this.call('cloudsearch/pc', { s: query, type: 1, limit: 30, offset: (page - 1) * 30, total: true }, credential);
    const songs = body.result?.songs || [], total = Number(body.result?.songCount);
    return { tracks: songs.map(t => this.normalize(t)), hasMore: songs.length > 0 && (Number.isFinite(total) ? page * 30 < total : songs.length >= 30) };
  }
  async lyrics(credential, id) {
    const { body } = await this.call('song/lyric', { id, lv: -1, tv: -1, rv: -1 }, credential);
    return { lyric: body.lrc?.lyric || '', translation: body.tlyric?.lyric || '' };
  }
  async playback(credential, id) {
    const { body } = await this.call('song/enhance/player/url/v1', { ids: JSON.stringify([Number(id)]), level: 'standard', encodeType: 'mp3' }, credential);
    const song = body.data?.[0];
    if (!song?.url || song.freeTrialInfo) throw new ApiError(403, '此歌曲当前无法完整播放，可能需要会员或受到平台限制');
    return song.url;
  }
}
