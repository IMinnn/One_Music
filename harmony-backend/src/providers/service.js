import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, rateLimit } from '../security.js';
import { transaction } from '../db.js';
import { NeteaseProvider } from './netease.js';
import { QQProvider } from './qq.js';
import { releaseDate, statisticCount } from './metadata.js';

export function createProviderService(db, dataDir, adapters = { qq: new QQProvider(), netease: new NeteaseProvider() }) {
  const keyPath = join(dataDir, 'platform.key');
  if (!existsSync(keyPath)) {
    if (db.prepare('SELECT COUNT(*) AS n FROM provider_connections').get().n) throw new Error('缺少平台凭据密钥 platform.key，请从备份恢复');
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('平台凭据密钥长度错误，请从备份恢复');
  const challenges = new Map(), busySync = new Set(), coverRequests = new Map();
  const aggregations = new Map();
  let coverActive = 0;
  const coverWaiters = [];
  function safeCover(value) {
    try { const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && ['y.gtimg.cn', 'music.126.net'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) { url.protocol = 'https:'; return url.href; }
    } catch {} return '';
  }
  function adapter(provider) { if (!['qq', 'netease'].includes(provider)) throw new ApiError(404, '音乐平台不存在'); return adapters[provider]; }
  function seal(userId, provider, credential) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(userId + ':' + provider));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  function open(row) {
    try {
      const bytes = Buffer.from(row.credential, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(row.user_id + ':' + row.provider)); decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch { throw new ApiError(503, '平台凭据无法读取，请重新扫码绑定', 'PROVIDER_CREDENTIAL_ERROR'); }
  }
  const find = (userId, provider) => db.prepare('SELECT * FROM provider_connections WHERE user_id = ? AND provider = ?').get(userId, provider);
  function connection(userId, provider) {
    adapter(provider); const row = find(userId, provider);
    if (!row || row.status !== 'connected') throw new ApiError(409, `请先扫码连接${provider === 'qq' ? 'QQ 音乐' : '网易云音乐'}，可使用任意可用账号`, 'PROVIDER_NOT_CONNECTED');
    return row;
  }
  function unchanged(row) {
    const latest = find(row.user_id, row.provider);
    if (!latest || latest.credential !== row.credential || latest.status !== 'connected') throw new ApiError(409, '平台账号已变更，请重试', 'PROVIDER_CHANGED');
  }
  async function call(row, method, ...args) {
    try { return await adapter(row.provider)[method](open(row), ...args); }
    catch (error) {
      if (error.code === 'PROVIDER_AUTH_EXPIRED') db.prepare("UPDATE provider_connections SET status = 'expired' WHERE user_id = ? AND provider = ? AND credential = ?").run(row.user_id, row.provider, row.credential);
      throw error;
    }
  }
  function cancel(userId, provider) {
    for (const [id, c] of challenges) if (c.userId === userId && (!provider || c.provider === provider)) challenges.delete(id);
  }
  function states(userId) {
    return ['qq', 'netease'].map(id => {
      const row = find(userId, id);
      return { id, name: id === 'qq' ? 'QQ 音乐' : '网易云音乐', available: true, connected: row?.status === 'connected',
        status: row?.status || 'disconnected', nickname: row?.nickname || '', syncedAt: row?.synced_at || null };
    });
  }
  function upsertTrack(userId, provider, t) {
    if (!t || !t.id || String(t.id).length > 150) throw new ApiError(502, '平台歌曲标识无效');
    const found = db.prepare('SELECT id FROM tracks WHERE user_id = ? AND provider = ? AND provider_id = ?').get(userId, provider, String(t.id));
    const id = found?.id || randomUUID();
    db.prepare(`INSERT INTO tracks(id,user_id,provider,provider_id,title,artist,album,duration,created_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,provider,provider_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,duration=excluded.duration`)
      .run(id, userId, provider, String(t.id), String(t.title || '未命名歌曲').slice(0, 300), String(t.artist || '').slice(0, 500), String(t.album || '').slice(0, 300), Math.max(0, Number(t.duration) || 0), Date.now());
    let cover = '';
    try {
      const url = new URL(t.coverUrl);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
        ['y.gtimg.cn', 'music.126.net'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) {
        url.protocol = 'https:'; cover = url.href;
      }
    } catch {}
    db.prepare("UPDATE tracks SET cover_url = CASE WHEN ? != '' THEN ? ELSE cover_url END WHERE id = ?").run(cover, cover, id);
    db.prepare("UPDATE tracks SET release_date = CASE WHEN ? != '' THEN ? ELSE release_date END, play_count = COALESCE(?, play_count), favorite_count = COALESCE(?, favorite_count) WHERE id = ?")
      .run(releaseDate(t.releaseDate), releaseDate(t.releaseDate), statisticCount(t.playCount), statisticCount(t.favoriteCount), id);
    return id;
  }
  return {
    states, cancel,
    async start(userId, provider) {
      adapter(provider); rateLimit(db, `qr-create:${userId}:${provider}`, 10, 600000);
      cancel(userId, provider);
      const id = randomUUID(), c = { userId, provider, expiresAt: Date.now() + 180000, status: 'loading', lastPoll: 0 };
      challenges.set(id, c);
      try {
        const result = await adapter(provider).startQr();
        if (challenges.get(id) !== c) throw new ApiError(409, '二维码请求已取消');
        c.secret = result.secret; c.status = 'waiting';
        return { id, image: result.image, hint: result.hint, status: c.status, expiresAt: c.expiresAt };
      } catch (error) { challenges.delete(id); throw error; }
    },
    async poll(userId, provider, id, stillAuthenticated = () => {}) {
      adapter(provider); const c = challenges.get(id);
      if (!c || c.userId !== userId || c.provider !== provider) throw new ApiError(404, '二维码不存在或已取消');
      if (c.expiresAt <= Date.now()) { challenges.delete(id); return { status: 'expired' }; }
      if (c.status === 'authorized') return { status: c.status };
      if (c.pending) return c.pending;
      if (Date.now() - c.lastPoll < 2000) return { status: c.status };
      c.lastPoll = Date.now();
      c.pending = (async () => {
        const result = await adapter(provider).pollQr(c.secret);
        stillAuthenticated();
        if (challenges.get(id) !== c || c.expiresAt <= Date.now()) throw new ApiError(409, '二维码已失效，请重新生成');
        if (result.status === 'authorized') {
          if (!result.credential || !result.profile?.id) throw new ApiError(502, '平台登录信息不完整');
          const encrypted = seal(userId, provider, result.credential), old = find(userId, provider);
          transaction(db, () => {
            if (old && old.profile_id !== String(result.profile.id)) db.prepare('DELETE FROM playlists WHERE user_id = ? AND source = ?').run(userId, provider);
            db.prepare(`INSERT INTO provider_connections(user_id,provider,profile_id,nickname,credential,status,updated_at) VALUES(?,?,?,?,?,'connected',?)
              ON CONFLICT(user_id,provider) DO UPDATE SET profile_id=excluded.profile_id,nickname=excluded.nickname,credential=excluded.credential,status='connected',updated_at=excluded.updated_at,synced_at=NULL`)
              .run(userId, provider, String(result.profile.id), String(result.profile.nickname || '音乐用户').slice(0, 100), encrypted, Date.now());
          });
          delete c.secret;
        }
        c.status = result.status;
        return { status: c.status };
      })();
      try { return await c.pending; } finally { delete c.pending; }
    },
    cancelQr(userId, provider, id) { const c = challenges.get(id); if (c?.userId === userId && c.provider === provider) challenges.delete(id); },
    disconnect(userId, provider) {
      adapter(provider); cancel(userId, provider);
      transaction(db, () => {
        db.prepare('DELETE FROM provider_connections WHERE user_id = ? AND provider = ?').run(userId, provider);
        db.prepare('DELETE FROM playlists WHERE user_id = ? AND source = ?').run(userId, provider);
      });
    },
    async sync(userId, provider) {
      const row = connection(userId, provider), lock = userId + ':' + provider;
      if (busySync.has(lock)) throw new ApiError(409, '此平台正在同步，请稍候');
      rateLimit(db, `provider-sync:${lock}`, 20, 600000); busySync.add(lock);
      try {
        const profile = await call(row, 'profile'), lists = await call(row, 'playlists', profile);
        unchanged(row);
        if (!Array.isArray(lists) || lists.length > 2000) throw new ApiError(502, '平台歌单数量超出支持范围');
        transaction(db, () => {
          const remoteIds = new Set(lists.map(p => String(p.id)));
          for (const old of db.prepare('SELECT id,remote_id FROM playlists WHERE user_id = ? AND source = ?').all(userId, provider))
            if (!remoteIds.has(old.remote_id)) db.prepare('DELETE FROM playlists WHERE id = ?').run(old.id);
          for (const p of lists) {
            if (!p.id) throw new ApiError(502, '平台歌单信息不完整');
            const now = Date.now();
            db.prepare(`INSERT INTO playlists(id,user_id,name,description,color,source,remote_id,track_count,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,source,remote_id) WHERE remote_id IS NOT NULL
              DO UPDATE SET name=excluded.name,description=excluded.description,track_count=excluded.track_count,updated_at=excluded.updated_at,preview_cover=''`)
              .run(randomUUID(), userId, String(p.name || '平台歌单').slice(0, 80), String(p.description || '').slice(0, 500), provider === 'qq' ? 'sage' : 'orange', provider, String(p.id), Math.max(0, Number(p.trackCount) || 0), now, now);
          }
          db.prepare('UPDATE provider_connections SET nickname = ?, synced_at = ? WHERE user_id = ? AND provider = ?').run(profile.nickname, Date.now(), userId, provider);
        });
        return { count: lists.length };
      } finally { busySync.delete(lock); }
    },
    async playlistCover(userId, id) {
      const key = userId + ':' + id;
      if (coverRequests.has(key)) return coverRequests.get(key);
      const pending = (async () => {
        const list = db.prepare("SELECT * FROM playlists WHERE id = ? AND user_id = ? AND source != 'own'").get(id, userId);
        if (!list) throw new ApiError(404, '平台歌单不存在');
        const row = connection(userId, list.source);
        if (list.loaded_at) return db.prepare('SELECT t.cover_url FROM playlist_tracks p JOIN tracks t ON t.id=p.track_id WHERE p.playlist_id=? ORDER BY p.position LIMIT 1').get(id)?.cover_url || '';
        if (list.preview_cover) return list.preview_cover;
        if (coverActive >= 3) await new Promise(resolve => coverWaiters.push(resolve));
        else coverActive++;
        try {
          unchanged(row);
          const first = await call(row, 'firstTrack', list.remote_id); unchanged(row);
          const cover = safeCover(first?.coverUrl);
          db.prepare('UPDATE playlists SET preview_cover = ? WHERE id = ? AND user_id = ? AND loaded_at IS NULL').run(cover, id, userId);
          return cover;
        } finally { const waiter = coverWaiters.shift(); if (waiter) waiter(); else coverActive--; }
      })();
      coverRequests.set(key, pending);
      try { return await pending; } finally { coverRequests.delete(key); }
    },
    async loadPlaylist(userId, id) {
      const list = db.prepare("SELECT * FROM playlists WHERE id = ? AND user_id = ? AND source != 'own'").get(id, userId);
      if (!list) throw new ApiError(404, '平台歌单不存在');
      const row = connection(userId, list.source);
      const tracks = await call(row, 'playlistTracks', list.remote_id);
      unchanged(row);
      if (!db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(id, userId)) throw new ApiError(409, '歌单已变更');
      transaction(db, () => {
        const ids = [...new Set(tracks.map(t => upsertTrack(userId, list.source, t)))];
        db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
        ids.forEach((trackId, position) => db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run(id, trackId, position));
        db.prepare('UPDATE playlists SET version=version+1,loaded_at=?,track_count=? WHERE id=?').run(Date.now(), ids.length, id);
      });
      return { count: tracks.length };
    },
    async aggregate(userId) {
      if (aggregations.has(userId)) return aggregations.get(userId);
      const pending = (async () => {
        const lists = db.prepare(`SELECT p.id,p.source FROM playlists p JOIN provider_connections c
          ON c.user_id=p.user_id AND c.provider=p.source
          WHERE p.user_id=? AND p.loaded_at IS NULL AND c.status='connected'
          ORDER BY p.created_at,p.id`).all(userId);
        const errors = []; let cursor = 0, loaded = 0;
        await Promise.all(Array.from({ length: Math.min(3, lists.length) }, async () => {
          while (cursor < lists.length) {
            const list = lists[cursor++];
            try { await this.loadPlaylist(userId, list.id); loaded++; }
            catch (error) { errors.push({ playlistId: list.id, provider: list.source, message: error.message }); }
          }
        }));
        return { loaded, errors };
      })();
      aggregations.set(userId, pending);
      try { return await pending; } finally { aggregations.delete(userId); }
    },
    async search(userId, provider, query, page = 1) {
      const source = adapter(provider), row = find(userId, provider);
      rateLimit(db, `provider-search:${userId}`, 60, 60000);
      let result;
      if (row?.status === 'connected') {
        try {
          result = await call(row, 'search', query, page);
          unchanged(row);
        } catch (error) {
          if (error.code !== 'PROVIDER_AUTH_EXPIRED' && error.code !== 'PROVIDER_CREDENTIAL_ERROR') throw error;
        }
      }
      if (!result) {
        try { result = await source.search({}, query, page); }
        catch (error) {
          if (error.code === 'PROVIDER_AUTH_EXPIRED') throw new ApiError(502, '平台暂时无法提供免登录搜索，请稍后重试', 'PROVIDER_UNAVAILABLE');
          throw error;
        }
      }
      const tracks = Array.isArray(result) ? result : result.tracks;
      const ids = transaction(db, () => tracks.map(t => upsertTrack(userId, provider, t)));
      return { ids: [...new Set(ids)], page, hasMore: tracks.length > 0 && (Array.isArray(result) ? tracks.length >= 30 : !!result.hasMore) };
    },
    async lyrics(userId, track) {
      const row = connection(userId, track.provider);
      const result = await call(row, 'lyrics', track.provider_id); unchanged(row); return result;
    },
    async playback(userId, track) {
      const row = connection(userId, track.provider);
      const url = await call(row, 'playback', track.provider_id); unchanged(row); return url;
    },
    cleanup() { for (const [id, c] of challenges) if (c.expiresAt <= Date.now()) challenges.delete(id); },
    close() { challenges.clear(); },
  };
}
