import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { ApiError, cleanText } from './security.js';

export const playlistFileLimit = 20 * 1024 * 1024;
const colors = new Set(['sage', 'orange', 'blue', 'cream', 'pink']);

export function exportPlaylists(db, userId) {
  const tracks = ids => ids.map(id => {
    const t = db.prepare('SELECT * FROM tracks WHERE id=? AND user_id=?').get(id, userId);
    return { provider: t.provider, providerId: t.provider_id || t.id, title: t.title,
      artist: t.artist, album: t.album, duration: t.duration };
  });
  return { format: 'harmony-playlists', version: 1, exportedAt: new Date().toISOString(),
    favorites: tracks(db.prepare('SELECT track_id FROM favorites WHERE user_id=? ORDER BY created_at DESC').all(userId).map(t => t.track_id)),
    playlists: db.prepare("SELECT * FROM playlists WHERE user_id=? AND source='own' ORDER BY created_at,id").all(userId).map(p => ({
      name: p.name, description: p.description, color: p.color,
      tracks: tracks(db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position').all(p.id).map(t => t.track_id)),
    })),
  };
}

export function importPlaylists(db, userId, input) {
  const invalid = () => { throw new ApiError(400, '歌单文件格式无效，请选择和音导出的 JSON 文件'); };
  if (input.format !== 'harmony-playlists' || input.version !== 1 || !Array.isArray(input.favorites) ||
      !Array.isArray(input.playlists) || input.playlists.length > 500) invalid();
  let count = 0;
  const tracks = values => {
    if (!Array.isArray(values) || values.length > 5000 || (count += values.length) > 100000) invalid();
    return values.map(t => {
      if (!t || !['local', 'qq', 'netease'].includes(t.provider) ||
          !Number.isFinite(t.duration) || t.duration < 0 || t.duration > 604800) invalid();
      return { provider: t.provider, providerId: cleanText(t.providerId, '歌曲标识', 256),
        title: cleanText(t.title, '歌曲名称', 1000), artist: cleanText(t.artist, '艺人', 1000, true),
        album: cleanText(t.album, '专辑', 1000, true), duration: t.duration };
    });
  };
  const favorites = tracks(input.favorites);
  const playlists = input.playlists.map(p => {
    if (!p || typeof p !== 'object') invalid();
    return { name: cleanText(p.name, '歌单名称', 80).normalize('NFC'),
      description: cleanText(p.description, '歌单介绍', 500, true),
      color: colors.has(p.color) ? p.color : 'sage', tracks: tracks(p.tracks) };
  });
  return transaction(db, () => {
    const result = { created: 0, merged: 0, added: 0, skipped: 0 };
    const now = Date.now(), merged = new Set();
    const resolveTrack = t => {
      const old = db.prepare('SELECT id FROM tracks WHERE user_id=? AND provider=? AND provider_id=?').get(userId, t.provider, t.providerId);
      if (old) return old.id;
      const id = randomUUID();
      db.prepare('INSERT INTO tracks(id,user_id,provider,provider_id,title,artist,album,duration,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, userId, t.provider, t.providerId, t.title, t.artist, t.album, t.duration, now);
      return id;
    };
    // Existing order is preserved; duplicates within the file and repeated imports are ignored.
    for (const [index, t] of favorites.entries()) {
      const id = resolveTrack(t);
      const change = db.prepare('INSERT OR IGNORE INTO favorites VALUES(?,?,?)').run(userId, id, now - index).changes;
      result[change ? 'added' : 'skipped']++;
    }
    for (const p of playlists) {
      let list = db.prepare("SELECT * FROM playlists WHERE user_id=? AND source='own' AND name=? ORDER BY created_at,id LIMIT 1").get(userId, p.name);
      if (!list) {
        if (db.prepare("SELECT COUNT(*) AS n FROM playlists WHERE user_id=? AND source='own'").get(userId).n >= 500)
          throw new ApiError(400, '最多可创建 500 张歌单，导入未保存');
        const id = randomUUID();
        db.prepare('INSERT INTO playlists(id,user_id,name,description,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, userId, p.name, p.description, p.color, now, now);
        list = { id }; result.created++;
      } else merged.add(list.id);
      const existing = new Set(db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=?').all(list.id).map(t => t.track_id));
      let position = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM playlist_tracks WHERE playlist_id=?').get(list.id).n;
      let changed = false;
      for (const t of p.tracks) {
        const id = resolveTrack(t);
        if (existing.has(id)) { result.skipped++; continue; }
        if (existing.size >= 5000) throw new ApiError(400, '合并后单张歌单超过 5000 首，导入未保存');
        db.prepare('INSERT INTO playlist_tracks VALUES(?,?,?)').run(list.id, id, position++);
        existing.add(id); result.added++; changed = true;
      }
      if (changed) db.prepare('UPDATE playlists SET version=version+1,updated_at=? WHERE id=?').run(now, list.id);
    }
    result.merged = merged.size;
    return result;
  });
}
