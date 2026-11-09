import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { unlink, rename } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { openDatabase, transaction } from './db.js';
import { createProviderService } from './providers/service.js';
import { exportPlaylists, importPlaylists, playlistFileLimit } from './playlist-transfer.js';
import { request as platformRequest, safeMediaUrl } from './providers/http.js';
import { ApiError, digest, newToken, cleanText } from './security.js';

const DAY = 86400000;
const colors = new Set(['sage', 'orange', 'blue', 'cream', 'pink']);
const audioTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req, limit = 65536) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new ApiError(415, '请求格式应为 JSON');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new ApiError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw new ApiError(400, '请求内容无效'); }
}
function tokenFrom(req) {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('harmony_session='))?.slice(16);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}
function audioSignature(buffer, extension) {
  const text = buffer.toString('ascii');
  if (extension === '.mp3') return text.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 224) === 224);
  if (extension === '.aac') return buffer[0] === 255 && (buffer[1] & 246) === 240;
  if (extension === '.wav') return text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE';
  if (extension === '.flac') return text.startsWith('fLaC');
  if (extension === '.ogg') return text.startsWith('OggS');
  if (extension === '.m4a') return text.slice(4, 8) === 'ftyp';
  return false;
}

export function createAppCore(options, createAccountRoutes) {
  const webDir = options.webDir ? resolve(options.webDir) : null;
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || './data');
  const mediaDir = join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const db = openDatabase(dataDir);
  const providers = createProviderService(db, dataDir, options.providers);
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const secure = options.secure ?? process.env.COOKIE_SECURE === 'true';
  let origin = createAccountRoutes ? options.origin || process.env.PUBLIC_ORIGIN || '' : '';
  if (production && (!secure || !origin.startsWith('https://')))
    throw new Error('生产环境需要 HTTPS 的 PUBLIC_ORIGIN 和 COOKIE_SECURE=true');
  if (origin) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol))
      throw new Error('PUBLIC_ORIGIN 必须是完整来源网址，不带路径或末尾斜杠');
  }
  const uploadLimit = (options.maxUploadMB || Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
  const storageLimit = (options.userStorageMB || Number(process.env.USER_STORAGE_MB) || 2048) * 1024 * 1024;
  const uploads = new Set();
  const accounts = createAccountRoutes?.({ db, providers, secure, session, setSession, ownTrack, tokenFrom, body, json });

  function session(req) {
    const token = tokenFrom(req);
    const user = token && db.prepare(`SELECT u.id, u.username, u.created_at, EXISTS(SELECT 1 FROM local_profiles l WHERE l.user_id = u.id) AS local FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(digest(token), Date.now());
    if (!user || (!accounts && !user.local)) throw new ApiError(401, '请登录后继续', 'UNAUTHENTICATED');
    return user;
  }
  function setSession(req, res, userId, remember) {
    const old = tokenFrom(req);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(old));
    const token = newToken(), lifetime = remember ? 30 * DAY : DAY;
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(digest(token), userId, Date.now(), Date.now() + lifetime);
    res.setHeader('Set-Cookie', `harmony_session=${token}; Path=/; HttpOnly; SameSite=Strict${remember ? '; Max-Age=2592000' : ''}${secure ? '; Secure' : ''}`);
    return token;
  }
  function ownPlaylist(id, userId) {
    const list = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(id, userId);
    if (!list) throw new ApiError(404, '找不到这张歌单');
    return list;
  }
  function ownTrack(id, userId) {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?').get(id, userId);
    if (!track) throw new ApiError(404, '找不到这首歌曲');
    return track;
  }
  function checkVersion(list, value) {
    if (list.source !== 'own') throw new ApiError(403, '平台歌单仅可读取');
    if (!Number.isInteger(value)) throw new ApiError(400, '缺少歌单版本，请刷新后重试');
    if (list.version !== value) throw new ApiError(409, '歌单已在另一处更新，已刷新，请重试此次操作', 'VERSION_CONFLICT');
  }
  function touch(id) {
    db.prepare('UPDATE playlists SET version = version + 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }
  function playlistData(list) {
    const trackIds = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(list.id).map(x => x.track_id);
    const firstCover = trackIds.length ? db.prepare('SELECT cover_url FROM tracks WHERE id = ?').get(trackIds[0])?.cover_url : '';
    return { id: list.id, name: list.name, description: list.description, color: list.color,
      coverUrl: firstCover || (!list.loaded_at && list.source !== 'own' ? list.preview_cover || '' : ''),
      source: list.source, version: list.version, trackIds, updatedAt: list.updated_at,
      trackCount: list.source === 'own' ? trackIds.length : list.track_count, loadedAt: list.loaded_at };
  }
  function trackData(t, states) {
    const platformConnected = t.provider !== 'local' && (states || providers.states(t.user_id)).some(p => p.id === t.provider && p.connected);
    return { id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration,
      releaseDate: t.release_date || '', playCount: t.play_count ?? null, favoriteCount: t.favorite_count ?? null,
      provider: t.provider, coverUrl: t.cover_url || '', bytes: t.bytes, canPlay: !!t.file_name || platformConnected, canDownload: !!t.file_name,
      fileExtension: t.file_name ? extname(t.file_name) : '',
      downloadReason: t.file_name ? '下载账号内的原始音乐文件' : '当前无平台免费下载授权' };
  }

  async function route(req, res) {
    const url = new URL(req.url, origin);
    const path = url.pathname, method = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://y.gtimg.cn https://*.music.126.net; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.headers.host !== new URL(origin).host) throw new ApiError(403, '访问地址不匹配');
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== origin)
      throw new ApiError(403, '请求来源无效', 'ORIGIN_REJECTED');

    if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true, version: '0.4.0' });
    if (path === '/api/auth/guest' && method === 'POST') {
      await body(req);
      if (!options.localGuestKey || production || req.headers['x-harmony-local-key'] !== options.localGuestKey)
        throw new ApiError(403, '本地模式仅可从桌面客户端进入');
      let profile = db.prepare("SELECT user_id FROM local_profiles WHERE device = 'desktop'").get();
      if (!profile) {
        transaction(db, () => {
          profile = db.prepare("SELECT user_id FROM local_profiles WHERE device = 'desktop'").get();
          if (profile) return;
          const id = randomUUID();
          db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, '本地模式', '@local-' + id, '', Date.now());
          db.prepare('INSERT INTO local_profiles VALUES(?,?)').run('desktop', id); profile = { user_id: id };
        });
      }
      setSession(req, res, profile.user_id, true);
      return json(res, 200, { user: { id: profile.user_id, username: '本地模式', local: true } });
    }
    if (accounts && await accounts.publicRoute(req, res, path, method)) return;
    if (path.startsWith('/api/')) {
      const user = session(req);
      if (path === '/api/providers' && method === 'GET') return json(res, 200, { providers: providers.states(user.id) });
      const providerMatch = path.match(/^\/api\/providers\/(qq|netease)(?:\/(qr|sync)(?:\/([a-zA-Z0-9-]+))?)?$/);
      if (providerMatch) {
        const [, provider, action, challengeId] = providerMatch;
        if (method === 'POST') {
          await body(req);
          if (action === 'qr' && !challengeId) { const qr = await providers.start(user.id, provider); session(req); return json(res, 201, qr); }
          if (action === 'qr' && challengeId) return json(res, 200, await providers.poll(user.id, provider, challengeId, () => session(req)));
          if (action === 'sync' && !challengeId) return json(res, 200, await providers.sync(user.id, provider));
        }
        if (method === 'DELETE') {
          await body(req);
          if (!action) { providers.disconnect(user.id, provider); return json(res, 200, { ok: true }); }
          if (action === 'qr' && challengeId) { providers.cancelQr(user.id, provider, challengeId); return json(res, 200, { ok: true }); }
        }
        throw new ApiError(404, '平台接口不存在');
      }
      if (path === '/api/providers/search' && method === 'POST') {
        const input = await body(req), query = cleanText(input.query, '搜索词', 100);
        if (input.pages !== undefined && (!input.pages || typeof input.pages !== 'object' || Array.isArray(input.pages) || Object.entries(input.pages).some(([key, page]) => !['qq', 'netease'].includes(key) || !Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 30)))) throw new ApiError(400, '搜索页码无效');
        const selected = providers.states(user.id).filter(p => p.available && (input.provider === 'all' || p.id === input.provider) && (input.pages === undefined || Object.hasOwn(input.pages, p.id)));
        if (!selected.length) throw new ApiError(400, '请选择有效的搜索平台');
        const result = await Promise.allSettled(selected.map(async p => ({ provider: p.id, ...await providers.search(user.id, p.id, query, input.pages?.[p.id] ?? 1) })));
        const trackIds = result.filter(r => r.status === 'fulfilled').flatMap(r => r.value.ids);
        return json(res, 200, { trackIds, pagination: result.filter(r => r.status === 'fulfilled').map(r => r.value), errors: result.flatMap((r, i) => r.status === 'rejected' ? [{ provider: selected[i].id, message: r.reason.message }] : []) });
      }
      const refreshPlaylist = path.match(/^\/api\/platform-playlists\/([a-zA-Z0-9-]+)\/refresh$/);
      const playlistCover = path.match(/^\/api\/platform-playlists\/([a-zA-Z0-9-]+)\/cover$/);
      if (playlistCover && method === 'GET') {
        const cover = await providers.playlistCover(user.id, playlistCover[1]);
        if (!cover) { res.writeHead(204, { 'Cache-Control': 'private, max-age=60' }); return res.end(); }
        res.writeHead(302, { Location: cover, 'Cache-Control': 'private, max-age=300' }); return res.end();
      }
      if (refreshPlaylist && method === 'POST') { await body(req); return json(res, 200, await providers.loadPlaylist(user.id, refreshPlaylist[1])); }
      if (path === '/api/me' && method === 'GET') return json(res, 200, { user: { id: user.id, username: user.local ? '本地模式' : user.username, local: !!user.local } });
      if (accounts && await accounts.userRoute(req, res, path, method, user)) return;
      if (path === '/api/playlist-layout' && method === 'PUT') {
        const input = await body(req), sources = ['own', 'qq', 'netease'];
        if (!Array.isArray(input.groups) || input.groups.length !== 3 || new Set(input.groups).size !== 3 || input.groups.some(s => !sources.includes(s)) ||
          !input.lists || typeof input.lists !== 'object' || !Number.isInteger(input.version) || input.version < 0)
          throw new ApiError(400, '歌单排序格式无效');
        const lists = {};
        for (const source of sources) {
          const ids = input.lists[source] || [];
          if (!Array.isArray(ids) || ids.length > 2500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string'))
            throw new ApiError(400, '歌单排序格式无效');
          const owned = new Set(db.prepare('SELECT id FROM playlists WHERE user_id = ? AND source = ?').all(user.id, source).map(p => p.id));
          if (ids.some(id => !owned.has(id))) throw new ApiError(400, '歌单已变更，请刷新后重试');
          lists[source] = ids;
        }
        const value = { groups: input.groups, lists };
        if (input.collapsed !== undefined && (!Array.isArray(input.collapsed) || input.collapsed.length > 3 || new Set(input.collapsed).size !== input.collapsed.length || input.collapsed.some(source => !sources.includes(source))))
          throw new ApiError(400, '歌单分组状态无效');
        transaction(db, () => {
          const previous = db.prepare('SELECT version,layout FROM playlist_layouts WHERE user_id = ?').get(user.id);
          if ((previous?.version || 0) !== input.version) throw new ApiError(409, '其他设备已调整歌单顺序，已刷新，请重新拖动', 'VERSION_CONFLICT');
          value.collapsed = input.collapsed ?? (previous ? JSON.parse(previous.layout).collapsed || [] : []);
          db.prepare('INSERT INTO playlist_layouts(user_id,layout,version) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET layout=excluded.layout,version=excluded.version')
            .run(user.id, JSON.stringify(value), input.version + 1);
        });
        return json(res, 200, { playlistLayout: { ...value, version: input.version + 1 } });
      }
      if (path === '/api/library/aggregate' && method === 'POST') {
        await body(req);
        return json(res, 200, await providers.aggregate(user.id));
      }
      if (path === '/api/library' && method === 'GET') {
        const states = providers.states(user.id);
        const tracks = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY created_at DESC, id').all(user.id);
        const lists = db.prepare('SELECT * FROM playlists WHERE user_id = ? ORDER BY created_at, id').all(user.id);
        const collectionTrackIds = db.prepare(`SELECT t.id FROM tracks t WHERE t.user_id = ? AND (
          t.provider = 'local' OR EXISTS (SELECT 1 FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE pt.track_id = t.id AND p.user_id = t.user_id)
          OR EXISTS (SELECT 1 FROM favorites f WHERE f.track_id = t.id AND f.user_id = t.user_id))
          ORDER BY t.created_at DESC, t.id`).all(user.id).map(t => t.id);
        return json(res, 200, { tracks: tracks.map(t => trackData(t, states)), collectionTrackIds, playlists: lists.map(playlistData),
          favorites: db.prepare('SELECT track_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map(x => x.track_id),
          recent: db.prepare('SELECT track_id FROM recent_tracks WHERE user_id = ? ORDER BY played_at DESC LIMIT 50').all(user.id).map(x => x.track_id),
          storage: { used: tracks.reduce((s, t) => s + t.bytes, 0), limit: storageLimit },
          playlistLayout: (() => { const row = db.prepare('SELECT * FROM playlist_layouts WHERE user_id = ?').get(user.id); return row ? { ...JSON.parse(row.layout), version: row.version } : { version: 0 }; })(),
          providers: states });
      }
      if (path === '/api/playlists/export' && method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="harmony-playlists.json"');
        return json(res, 200, exportPlaylists(db, user.id));
      }
      if (path === '/api/playlists/import' && method === 'POST') {
        const input = await body(req, playlistFileLimit);
        session(req);
        return json(res, 200, importPlaylists(db, user.id, input));
      }
      if (path === '/api/playlists' && method === 'POST') {
        const input = await body(req), name = cleanText(input.name, '歌单名称', 80);
        const description = cleanText(input.description, '歌单介绍', 500, true);
        const id = randomUUID(), now = Date.now();
        if (db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id = ? AND source = 'own'").get(user.id).n >= 500)
          throw new ApiError(400, '最多可创建 500 张歌单');
        db.prepare('INSERT INTO playlists (id,user_id,name,description,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, user.id, name, description, colors.has(input.color) ? input.color : 'sage', now, now);
        return json(res, 201, { playlist: playlistData(ownPlaylist(id, user.id)) });
      }
      const listMatch = path.match(/^\/api\/playlists\/([a-zA-Z0-9-]+)(\/tracks)?$/);
      if (listMatch) {
        const id = listMatch[1];
        if (method === 'GET' && !listMatch[2]) return json(res, 200, { playlist: playlistData(ownPlaylist(id, user.id)) });
        const input = await body(req);
        const list = ownPlaylist(id, user.id);
        checkVersion(list, input.version);
        if (method === 'DELETE' && !listMatch[2]) {
          db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(id, user.id);
          return json(res, 200, { ok: true });
        }
        if (method === 'PATCH' && !listMatch[2]) {
          const name = cleanText(input.name ?? list.name, '歌单名称', 80);
          const description = cleanText(input.description ?? list.description, '歌单介绍', 500, true);
          db.prepare('UPDATE playlists SET name = ?, description = ?, color = ?, version = version + 1, updated_at = ? WHERE id = ?')
            .run(name, description, colors.has(input.color) ? input.color : list.color, Date.now(), id);
          return json(res, 200, { playlist: playlistData(ownPlaylist(id, user.id)) });
        }
        if (method === 'PUT' && listMatch[2]) {
          const ids = input.trackIds;
          if (!Array.isArray(ids) || ids.length > 5000 || ids.some(x => typeof x !== 'string') || new Set(ids).size !== ids.length)
            throw new ApiError(400, '歌曲列表无效：最多 5000 首，不可重复');
          ids.forEach(trackId => ownTrack(trackId, user.id));
          transaction(db, () => {
            db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
            const insert = db.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?)');
            ids.forEach((trackId, index) => insert.run(id, trackId, index));
            touch(id);
          });
          return json(res, 200, { playlist: playlistData(ownPlaylist(id, user.id)) });
        }
      }
      if (path === '/api/tracks/import' && method === 'POST') {
        const originalName = cleanText(url.searchParams.get('name'), '文件名', 255);
        const extension = extname(originalName).toLowerCase();
        if (!audioTypes[extension]) throw new ApiError(415, '支持 MP3、WAV、FLAC、OGG、M4A 和 AAC 文件');
        if (uploads.has(user.id)) throw new ApiError(429, '正在导入其他歌曲，请稍后再试');
        const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM tracks WHERE user_id = ?').get(user.id).n;
        const budget = Math.min(uploadLimit, storageLimit - used);
        if (Number(req.headers['content-length'] || 0) > budget || budget <= 0)
          throw new ApiError(413, '文件超过大小限制或账号存储空间不足');
        uploads.add(user.id);
        const id = randomUUID(), fileName = id + extension;
        const temporary = join(mediaDir, fileName + '.upload'), final = join(mediaDir, fileName);
        let bytes = 0, header = Buffer.alloc(0);
        try {
          const limiter = new Transform({ transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
            callback(bytes > budget ? new ApiError(413, '文件超过大小限制或账号存储空间不足') : null, chunk);
          } });
          await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx' }));
          if (bytes < 16 || !audioSignature(header, extension)) throw new ApiError(415, '文件内容不是可识别的音频格式');
          await rename(temporary, final);
          // Session can be revoked while a large upload is in progress.
          session(req);
          db.prepare(`INSERT INTO tracks (id,user_id,provider,provider_id,title,artist,file_name,mime,bytes,created_at)
            VALUES (?,?,'local',?,?,?, ?,?,?,?)`).run(id, user.id, id, originalName.slice(0, -extension.length), '未知艺人', fileName, audioTypes[extension], bytes, Date.now());
          return json(res, 201, { track: trackData(ownTrack(id, user.id)) });
        } catch (error) {
          await Promise.all([unlink(temporary).catch(() => {}), unlink(final).catch(() => {})]);
          throw error;
        } finally { uploads.delete(user.id); }
      }
      const trackMatch = path.match(/^\/api\/tracks\/([a-zA-Z0-9-]+)(?:\/(audio|favorite|recent|lyrics))?$/);
      if (trackMatch) {
        const action = trackMatch[2];
        const track = ownTrack(trackMatch[1], accounts?.continuedOwner(req, url, trackMatch[1], action) ?? user.id);
        if (action === 'lyrics' && method === 'GET') {
          if (track.provider === 'local') return json(res, 200, { lyric: '', translation: '' });
          return json(res, 200, await providers.lyrics(track.user_id, track));
        }
        if (action === 'audio' && ['GET', 'HEAD'].includes(method)) {
          if (!track.file_name && track.provider !== 'local') {
            if (url.searchParams.has('download')) throw new ApiError(403, '当前无平台免费下载授权');
            let target = safeMediaUrl(await providers.playback(track.user_id, track));
            let upstream;
            for (let i = 0; i < 4; i++) {
              upstream = await platformRequest(target, { headers: req.headers.range ? { Range: req.headers.range } : {} });
              if ([301, 302, 303, 307, 308].includes(upstream.status)) {
                const location = upstream.headers.get('location'); await upstream.body?.cancel();
                if (!location) throw new ApiError(502, '平台音频重定向无效');
                target = safeMediaUrl(new URL(location, target).href); continue;
              }
              break;
            }
            if (!upstream || ![200, 206].includes(upstream.status)) { await upstream?.body?.cancel(); throw new ApiError(502, '平台音频暂时不可用'); }
            const type = upstream.headers.get('content-type') || 'audio/mpeg';
            if (!/^(audio\/|application\/octet-stream)/i.test(type)) { await upstream.body?.cancel(); throw new ApiError(502, '平台没有返回音频文件'); }
            res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'private, no-store');
            for (const name of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(name)) res.setHeader(name, upstream.headers.get(name));
            res.writeHead(upstream.status);
            if (method === 'HEAD') { await upstream.body?.cancel(); return res.end(); }
            const stream = Readable.fromWeb(upstream.body); res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); return stream.pipe(res);
          }
          if (!track.file_name) throw new ApiError(403, '当前歌曲不可播放或下载');
          const file = join(mediaDir, track.file_name);
          if (!existsSync(file)) throw new ApiError(404, '音频文件不存在，请重新导入');
          const size = statSync(file).size;
          res.setHeader('Content-Type', track.mime);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'private, no-store');
          if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="music${extname(file)}"; filename*=UTF-8''${encodeURIComponent(track.title + extname(file))}`);
          let start = 0, end = size - 1, status = 200;
          if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${size}`); return json(res, 416, { error: '音频范围无效' }); }
            if (!match[1]) start = Math.max(0, size - Number(match[2]));
            else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
            if (start > end || start >= size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
              res.setHeader('Content-Range', `bytes */${size}`); return json(res, 416, { error: '音频范围无效' });
            }
            status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
          }
          res.writeHead(status, { 'Content-Length': end - start + 1 });
          if (method === 'HEAD') return res.end();
          const stream = createReadStream(file, { start, end });
          res.on('close', () => stream.destroy());
          stream.on('error', () => res.destroy());
          return stream.pipe(res);
        }
        if (action === 'favorite' && method === 'PUT') {
          const input = await body(req);
          if (typeof input.favorite !== 'boolean') throw new ApiError(400, '收藏状态无效');
          if (input.favorite) db.prepare('INSERT OR IGNORE INTO favorites VALUES (?, ?, ?)').run(user.id, track.id, Date.now());
          else db.prepare('DELETE FROM favorites WHERE user_id = ? AND track_id = ?').run(user.id, track.id);
          return json(res, 200, { ok: true });
        }
        if (action === 'recent' && method === 'POST') {
          await body(req);
          db.prepare('INSERT OR REPLACE INTO recent_tracks VALUES (?, ?, ?)').run(user.id, track.id, Date.now());
          return json(res, 200, { ok: true });
        }
        if (!action && method === 'DELETE') {
          await body(req);
          transaction(db, () => {
            for (const row of db.prepare('SELECT playlist_id FROM playlist_tracks WHERE track_id = ?').all(track.id)) touch(row.playlist_id);
            db.prepare('DELETE FROM tracks WHERE id = ? AND user_id = ?').run(track.id, user.id);
          });
          if (track.file_name) await unlink(join(mediaDir, track.file_name)).catch(() => {});
          return json(res, 200, { ok: true });
        }
      }
      throw new ApiError(404, '接口不存在');
    }
    const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/lyrics.js': ['lyrics.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
    if (webDir && ['GET', 'HEAD'].includes(method) && staticFiles[path]) {
      const [fileName, type] = staticFiles[path];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') return res.end();
      const stream = createReadStream(join(webDir, fileName));
      stream.on('error', () => res.destroy());
      return stream.pipe(res);
    }
    throw new ApiError(404, '页面不存在');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, {
        error: error instanceof ApiError ? error.message : '服务器暂时无法处理请求，请稍后重试', code: error.code || 'SERVER_ERROR',
      });
      else if (!res.destroyed) res.destroy();
      if (!(error instanceof ApiError)) console.error('Request failed:', error.message);
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  const cleanup = setInterval(() => {
    providers.cleanup();
    const now = Date.now();
    accounts?.cleanup(now);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').run(now);
  }, 60000).unref();
  return {
    db, server, dataDir,
    async listen(port = 47831, host = '127.0.0.1') {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
      });
      const local = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`;
      origin ||= local;
      return local;
    },
    async close() {
      providers.close();
      clearInterval(cleanup);
      await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
      db.close();
    },
  };
}
